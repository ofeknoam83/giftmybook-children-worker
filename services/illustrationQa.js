/**
 * Holistic Illustration QA Service
 *
 * Post-generation QA that analyzes ALL illustrations as a set,
 * catching cross-spread issues invisible to per-spread checks.
 *
 * Entry point: runHolisticQa(allImages, context)
 */

const { getNextApiKey, fetchWithTimeout } = require('./illustrationGenerator');

const GEMINI_QA_MODEL = 'gemini-2.5-flash';
const MAX_IMAGES_PER_REQUEST = 4;

// ── Check weights (text checks restored for embedded text verification) ──
const CHECK_WEIGHTS = {
  characterConsistency: 0.25,
  textAccuracy: 0.25,
  fontConsistency: 0.15,
  anatomical: 0.10,
  artStyle: 0.10,
  textWidth: 0.10,
  contentSafety: 0.05,
  duplicateItems: 0.05,
  colorPalette: 0,
};

// ── Helpers ──

/** Parse JSON from Gemini response text, tolerating markdown fences */
function parseJsonResponse(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { return null; }
  }
  return null;
}

/** Call Gemini Vision with text + images for QA analysis */
async function callGeminiQa(prompt, images, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) return null;

  const parts = [{ text: prompt }];
  for (const img of images) {
    const data = typeof img === 'string' ? img : img.toString('base64');
    parts.push({ inline_data: { mime_type: 'image/jpeg', data } });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: opts.maxTokens || 1024,
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, opts.timeoutMs || 60000);

  if (!resp.ok) return null;
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return parseJsonResponse(text);
}

/** Split array into chunks of given size */
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ═══════════════════════════════════════════
// CHECK 1: Character Visual Consistency (25%)
// ═══════════════════════════════════════════
async function checkCharacterVisualConsistency(allImages, context) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  if (allImages.length < 2) return results;

  const batches = chunk(allImages, MAX_IMAGES_PER_REQUEST);
  const characterInfo = [
    context.characterAnchor ? `Main character: ${context.characterAnchor}` : '',
    context.characterOutfit ? `Expected outfit: ${context.characterOutfit}` : '',
    context.allCharacters?.length ? `All characters: ${context.allCharacters.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  try {
    for (const batch of batches) {
      const imageLabels = batch.map(img => `Image ${img.index + 1}`).join(', ');
      const prompt = `You are reviewing ${batch.length} illustrations from the same children's book (${imageLabels}).
${characterInfo}

For EACH character that appears in multiple images, check:
1. Is their face shape and features consistent?
2. Is their hair color/style consistent?
3. Is their skin tone consistent?
4. Are they wearing the same outfit (unless a scene change justifies it)?
5. Are body proportions consistent?

DO NOT flag: left/right mirroring, minor lighting differences, scene-specific accessories, eye open/closed state.

Return ONLY valid JSON:
{"characters": [{"name": "child", "consistent": true, "issues": [], "affectedImages": []}]}
Only flag OBVIOUS differences where the character would be unrecognizable.`;

      const images = batch.map(img => img.imageBase64);
      const result = await callGeminiQa(prompt, images);
      if (result?.characters) {
        for (const char of result.characters) {
          if (!char.consistent && char.issues?.length > 0) {
            results.passed = false;
            results.issues.push(...char.issues.map(i => `${char.name}: ${i}`));
            const affected = (char.affectedImages || []).map(imgNum => {
              const batchImg = batch[imgNum - 1];
              return batchImg ? batchImg.index : null;
            }).filter(i => i !== null);
            results.affectedSpreads.push(...affected);
          }
        }
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Character consistency check error:', e.message);
    // Default pass on infra failure
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 2: Color Palette Coherence (10%)
// ═══════════════════════════════════════════
async function checkColorPaletteCoherence(allImages, context) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  if (allImages.length < 2) return results;

  // Group by scene if storyPlan has scene info, otherwise batch sequentially
  const scenes = [];
  if (context.storyPlan?.scenes?.length) {
    for (const scene of context.storyPlan.scenes) {
      const sceneImages = allImages.filter(img =>
        img.index >= (scene.startSpread || 0) && img.index <= (scene.endSpread || allImages.length - 1)
      );
      if (sceneImages.length > 0) scenes.push(sceneImages);
    }
  }
  if (scenes.length === 0) {
    // Treat consecutive pairs/groups of 4 as scenes
    scenes.push(...chunk(allImages, MAX_IMAGES_PER_REQUEST));
  }

  try {
    for (const sceneImages of scenes) {
      if (sceneImages.length < 2) continue;
      const batches = chunk(sceneImages, MAX_IMAGES_PER_REQUEST);

      for (const batch of batches) {
        const prompt = `These ${batch.length} images are from the same scene in a children's book.
Check if the color palette is coherent within this scene:
- Background colors should be consistent (same room = same wall color)
- Lighting should be consistent (same time of day)
- Character colors shouldn't shift (e.g., red shirt looking orange in one spread)

Note: Different scenes CAN have different palettes. Only flag jarring inconsistencies within the same scene.

Return ONLY valid JSON:
{"sceneCoherence": true, "issues": [], "affectedImages": []}
affectedImages = 1-based indices of images in this batch that break coherence.`;

        const images = batch.map(img => img.imageBase64);
        const result = await callGeminiQa(prompt, images, { maxTokens: 512 });
        if (result && !result.sceneCoherence) {
          results.passed = false;
          results.issues.push(...(result.issues || ['Color palette inconsistency within scene']));
          const affected = (result.affectedImages || []).map(imgNum => {
            const batchImg = batch[imgNum - 1];
            return batchImg ? batchImg.index : null;
          }).filter(i => i !== null);
          results.affectedSpreads.push(...affected);
        }
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Color palette check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 3: Font & Text Consistency (15%)
// ═══════════════════════════════════════════
async function checkFontTextConsistency(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  const textImages = allImages.filter(img => img.pageText && img.pageText.trim().length > 0);
  if (textImages.length < 2) return results;

  try {
    const batches = chunk(textImages, MAX_IMAGES_PER_REQUEST);
    for (const batch of batches) {
      const prompt = `These are ${batch.length} illustrated pages from the same children's book, shown in order.
Compare the text rendering across ALL pages:
1. Is the font family the same on every page?
2. Is the font size (relative to page) consistent?
3. Is the font weight/boldness consistent?
4. Is the text color the same throughout?
5. Is text placement style consistent (always top, always bottom, etc.)?

Find the MAJORITY style. Flag any pages that deviate from it.
Minor AI rendering variations are acceptable — only flag OBVIOUS differences.

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of images that differ from the majority.`;

      const images = batch.map(img => img.imageBase64);
      const result = await callGeminiQa(prompt, images, { maxTokens: 512 });
      if (result && !result.consistent) {
        results.passed = false;
        results.issues.push(...(result.issues || ['Font inconsistency detected']));
        const affected = (result.outlierImages || result.outlierSpreads || []).map(imgNum => {
          const batchImg = batch[imgNum - 1];
          return batchImg ? batchImg.index : null;
        }).filter(i => i !== null);
        results.affectedSpreads.push(...affected);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Font consistency check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 4: Anatomical Correctness (15%)
// ═══════════════════════════════════════════
async function checkAnatomicalCorrectness(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [] };

  try {
    // Run per-image in parallel (one image per call)
    const checks = allImages.map(async (img) => {
      const prompt = `Check this children's book illustration for anatomical issues:
- Hands: correct number of fingers (5 per hand)? No extra or missing fingers?
- Arms/legs: correct number (2 of each), natural positions?
- Face: two eyes, one nose, one mouth, properly placed? Ears present and correct?
- No merged or extra body parts?
- No distorted or unnatural proportions?

Focus on the main character(s). Minor stylistic exaggerations are fine for children's book art.
Only flag CLEAR anatomical errors.

Return ONLY valid JSON:
{"passed": true, "issues": []}`;

      const result = await callGeminiQa(prompt, [img.imageBase64], { maxTokens: 512 });
      return { index: img.index, result };
    });

    const checkResults = await Promise.all(checks);
    for (const { index, result } of checkResults) {
      if (result && !result.passed) {
        results.passed = false;
        results.issues.push(...(result.issues || []).map(i => `Spread ${index + 1}: ${i}`));
        results.affectedSpreads.push(index);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Anatomical check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 5: Text Accuracy (15%)
// ═══════════════════════════════════════════
async function checkTextAccuracy(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  const textImages = allImages.filter(img => img.pageText && img.pageText.trim().length > 0);
  if (textImages.length === 0) return results;

  try {
    const checks = textImages.map(async (img) => {
      const prompt = `Read ALL text visible in this children's book illustration.
Expected text: "${img.pageText}"

Compare what you see vs what was expected:
1. Is every word spelled correctly?
2. Is the full expected text present?
3. Is there any extra/garbled text that shouldn't be there?
4. Are there any AI-generated text artifacts (random letters, symbols)?

Minor formatting differences (line breaks, capitalization) are acceptable.
Only flag misspellings, missing words, garbled text, or extra gibberish.

Return ONLY valid JSON:
{"textAccurate": true, "extractedText": "what you actually read", "issues": []}`;

      const result = await callGeminiQa(prompt, [img.imageBase64], { maxTokens: 512 });
      return { index: img.index, result };
    });

    const checkResults = await Promise.all(checks);
    for (const { index, result } of checkResults) {
      if (result && !result.textAccurate) {
        results.passed = false;
        results.issues.push(...(result.issues || []).map(i => `Spread ${index + 1}: ${i}`));
        results.affectedSpreads.push(index);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Text accuracy check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 6: Art Style Consistency (5%)
// ═══════════════════════════════════════════
async function checkArtStyleConsistency(allImages, context) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  if (allImages.length < 2) return results;

  try {
    const batches = chunk(allImages, MAX_IMAGES_PER_REQUEST);
    for (const batch of batches) {
      const artStyleDesc = context.artStyle ? `Expected art style: ${context.artStyle}` : '';
      const prompt = `These are ${batch.length} illustrations from the same children's book.
${artStyleDesc}

Check:
1. Is the rendering technique consistent (all watercolor, all digital, all 3D, etc.)?
2. Is the level of detail consistent (not some photorealistic and some sketchy)?
3. Is the line weight/quality consistent?
4. Do all illustrations feel like they belong to the same book?

Minor variations are expected in AI art. Only flag OBVIOUS style breaks.

Return ONLY valid JSON:
{"consistent": true, "outlierImages": [], "issues": []}
outlierImages = 1-based indices of images that differ from the majority style.`;

      const images = batch.map(img => img.imageBase64);
      const result = await callGeminiQa(prompt, images, { maxTokens: 512 });
      if (result && !result.consistent) {
        results.passed = false;
        results.issues.push(...(result.issues || ['Art style inconsistency detected']));
        const affected = (result.outlierImages || []).map(imgNum => {
          const batchImg = batch[imgNum - 1];
          return batchImg ? batchImg.index : null;
        }).filter(i => i !== null);
        results.affectedSpreads.push(...affected);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Art style check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 7: Text Width & Placement (5%)
// ═══════════════════════════════════════════
async function checkTextWidthPlacement(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  const textImages = allImages.filter(img => img.pageText && img.pageText.trim().length > 0);
  if (textImages.length === 0) return results;

  try {
    const checks = textImages.map(async (img) => {
      const prompt = `Check the text in this children's book illustration:
1. Does the text take up more than about 35% of the page width?
2. Is the text readable (good contrast against the illustrated background, with shadow or outline)?
3. Is the text rendered with a consistent, child-friendly font?

Return ONLY valid JSON:
{"passed": true, "estimatedTextWidthPct": 25, "issues": []}
Flag if text is clearly too wide (>35% of page) or unreadable.`;

      const result = await callGeminiQa(prompt, [img.imageBase64], { maxTokens: 256 });
      return { index: img.index, result };
    });

    const checkResults = await Promise.all(checks);
    for (const { index, result } of checkResults) {
      if (result && !result.passed) {
        results.passed = false;
        results.issues.push(...(result.issues || []).map(i => `Spread ${index + 1}: ${i}`));
        results.affectedSpreads.push(index);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Text width check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 8: Scene-to-Text Alignment (5%)
// ═══════════════════════════════════════════
async function checkSceneTextAlignment(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [] };
  const imagesWithContext = allImages.filter(
    img => (img.pageText && img.pageText.trim().length > 0) || (img.sceneDescription && img.sceneDescription.trim().length > 0)
  );
  if (imagesWithContext.length === 0) return results;

  try {
    const checks = imagesWithContext.map(async (img) => {
      const textSection = img.pageText ? `Story text for this page: "${img.pageText}"` : '';
      const sceneSection = img.sceneDescription ? `Scene description: "${img.sceneDescription}"` : '';
      const prompt = `${textSection}
${sceneSection}

Does the illustration match the story?
1. Setting: Does the location match what the text describes?
2. Action: Is the character doing what the text says?
3. Emotion: Does the character's expression match the story mood?
4. Objects: Are key objects mentioned in the text present?

Minor artistic interpretations are fine. Only flag CLEAR mismatches (e.g., "rainy day" but sunshine, "running" but standing still).

Return ONLY valid JSON:
{"aligned": true, "issues": []}`;

      const result = await callGeminiQa(prompt, [img.imageBase64], { maxTokens: 512 });
      return { index: img.index, result };
    });

    const checkResults = await Promise.all(checks);
    for (const { index, result } of checkResults) {
      if (result && !result.aligned) {
        results.passed = false;
        results.issues.push(...(result.issues || []).map(i => `Spread ${index + 1}: ${i}`));
        results.affectedSpreads.push(index);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Scene alignment check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 9: Content Safety (5%) — HARD BLOCK
// ═══════════════════════════════════════════
async function checkContentSafety(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [], isHardBlock: false };

  try {
    const checks = allImages.map(async (img) => {
      const prompt = `This is a children's book illustration for ages 2-8.
Check for any content that could be inappropriate:
1. Any scary or frightening elements (monsters, dark imagery, blood)?
2. Any unsafe situations (child near danger without adult supervision)?
3. All characters appropriately dressed?
4. No violence or dark imagery?
5. Age-appropriate content throughout?

Return ONLY valid JSON:
{"safe": true, "issues": []}`;

      const result = await callGeminiQa(prompt, [img.imageBase64], { maxTokens: 256 });
      return { index: img.index, result };
    });

    const checkResults = await Promise.all(checks);
    for (const { index, result } of checkResults) {
      if (result && !result.safe) {
        results.passed = false;
        results.isHardBlock = true;
        results.issues.push(...(result.issues || []).map(i => `Spread ${index + 1}: ${i}`));
        results.affectedSpreads.push(index);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Content safety check error:', e.message);
    // Default pass on infra failure — never block on infra errors
  }

  return results;
}

// ═══════════════════════════════════════════
// CHECK 10: Duplicate Item Detection (5%)
// ═══════════════════════════════════════════
async function checkDuplicateItems(allImages) {
  const results = { passed: true, issues: [], affectedSpreads: [] };

  try {
    const checks = allImages.map(async (img) => {
      const prompt = `Examine this children's book illustration for DUPLICATED or CLONED objects.

Look for any specific, distinctive object that appears to be duplicated/cloned in the image — as if copy-pasted:
- Two identical books with the same cover design
- Two copies of the same distinctive toy in different positions
- The child holding the same specific object in both hands
- Two identical plates of food
- Two identical specific items that should be unique

Do NOT flag these — they are intentional multiples:
- A shelf of books (multiple different books is normal)
- A pile of blocks or building pieces
- A row of flowers or trees
- Multiple similar but not identical items (e.g. two different cups)
- Patterns or repeating decorative elements
- Multiple of the same common item (e.g. plates at a dinner table for multiple people)

Only flag objects that appear to be AI cloning artifacts — the SAME specific distinctive item appearing twice when it clearly should be unique.

Return ONLY valid JSON:
{"passed": true, "issues": []}`;

      const result = await callGeminiQa(prompt, [img.imageBase64], { maxTokens: 512 });
      return { index: img.index, result };
    });

    const checkResults = await Promise.all(checks);
    for (const { index, result } of checkResults) {
      if (result && !result.passed) {
        results.passed = false;
        results.issues.push(...(result.issues || []).map(i => `Spread ${index + 1}: ${i}`));
        results.affectedSpreads.push(index);
      }
    }
  } catch (e) {
    console.warn('[illustrationQa] Duplicate items check error:', e.message);
  }

  return results;
}

// ═══════════════════════════════════════════
// ORCHESTRATOR: runHolisticQa
// ═══════════════════════════════════════════

/**
 * Run holistic visual QA checks on the complete set of illustrations.
 * Includes text accuracy, font consistency, and text width checks for embedded text.
 * 7 checks: character consistency (25%), text accuracy (25%), font consistency (15%),
 * anatomical (10%), art style (10%), text width (10%), content safety (5%).
 *
 * IMPORTANT: Never abort generation. Always produce a book.
 * QA results are informational — used for chat-based retries, not blocking.
 *
 * @param {Array<{index, imageBase64, imageUrl, pageText, sceneDescription}>} allImages
 * @param {{characterRef, characterAnchor, characterOutfit, artStyle, childName, bookType, storyPlan, allCharacters}} context
 * @returns {{passed: boolean, score: number, issues: Array, failedSpreads: Array<{index, checks: Array<{check, passed, issues}>}>}}
 */
async function runHolisticQa(allImages, context) {
  console.log(`[illustrationQa] Starting holistic QA on ${allImages.length} images`);
  const startTime = Date.now();

  // Filter out images without base64 data
  const validImages = allImages.filter(img => img.imageBase64);
  if (validImages.length === 0) {
    console.warn('[illustrationQa] No valid images for QA — skipping');
    return { passed: true, score: 100, issues: [], failedSpreads: [] };
  }

  // Run all checks in parallel (text checks restored for embedded text)
  const [
    charConsistency,
    textAccuracy,
    fontConsistency,
    anatomical,
    artStyle,
    textWidth,
    contentSafety,
    duplicateItems,
  ] = await Promise.all([
    checkCharacterVisualConsistency(validImages, context).catch(e => {
      console.warn('[illustrationQa] Character consistency failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
    checkTextAccuracy(validImages).catch(e => {
      console.warn('[illustrationQa] Text accuracy failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
    checkFontTextConsistency(validImages).catch(e => {
      console.warn('[illustrationQa] Font consistency failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
    checkAnatomicalCorrectness(validImages).catch(e => {
      console.warn('[illustrationQa] Anatomical check failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
    checkArtStyleConsistency(validImages, context).catch(e => {
      console.warn('[illustrationQa] Art style failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
    checkTextWidthPlacement(validImages).catch(e => {
      console.warn('[illustrationQa] Text width failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
    checkContentSafety(validImages).catch(e => {
      console.warn('[illustrationQa] Content safety failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [], isHardBlock: false };
    }),
    checkDuplicateItems(validImages).catch(e => {
      console.warn('[illustrationQa] Duplicate items check failed:', e.message);
      return { passed: true, issues: [], affectedSpreads: [] };
    }),
  ]);

  // Calculate weighted score
  const checkResults = {
    characterConsistency: charConsistency,
    textAccuracy,
    fontConsistency,
    anatomical,
    artStyle,
    textWidth,
    contentSafety,
    duplicateItems,
  };

  let score = 0;
  const allIssues = [];
  const spreadFailures = new Map(); // index -> [{check, passed, issues}]

  for (const [checkName, result] of Object.entries(checkResults)) {
    const weight = CHECK_WEIGHTS[checkName] || 0;
    if (result.passed) {
      score += weight * 100;
    }
    if (result.issues?.length > 0) {
      allIssues.push(...result.issues.map(i => `[${checkName}] ${i}`));
    }
    // Track per-spread failures
    for (const spreadIdx of (result.affectedSpreads || [])) {
      if (!spreadFailures.has(spreadIdx)) spreadFailures.set(spreadIdx, []);
      spreadFailures.get(spreadIdx).push({
        check: checkName,
        passed: false,
        issues: result.issues?.filter(i => i.includes(`Spread ${spreadIdx + 1}`)) || result.issues || [],
      });
    }
  }

  score = Math.round(score);

  // Build failedSpreads array
  const failedSpreads = Array.from(spreadFailures.entries()).map(([index, checks]) => ({
    index,
    checks,
  }));

  // Hard gate: text width violation is always fixable — trigger re-composite
  if (!textWidth.passed) {
    console.warn(`[illustrationQa] TEXT WIDTH HARD GATE: text exceeds 35% width on ${textWidth.affectedSpreads?.length || 0} spreads`);
  }

  // Overall pass: score >= 75% AND no text width violations
  const passed = score >= 75 && textWidth.passed;

  const elapsed = Date.now() - startTime;
  console.log(`[illustrationQa] Holistic QA complete: score=${score}, passed=${passed}, issues=${allIssues.length}, failedSpreads=${failedSpreads.length}, elapsed=${elapsed}ms`);

  return { passed, score, issues: allIssues, failedSpreads };
}

// ═══════════════════════════════════════════
// LIGHTWEIGHT SCORER: Score a single image against the book
// ═══════════════════════════════════════════

/**
 * Score a single illustration against the full book context for specific checks only.
 * Used by Tier 3 (multi-candidate selection) to pick the best candidate.
 *
 * @param {string} imageBase64 - The candidate image to score
 * @param {Array<{index, imageBase64, pageText, sceneDescription}>} allQaImages - All book images
 * @param {Array<string>} failedChecks - Which checks to run (e.g., ['characterConsistency', 'fontConsistency'])
 * @param {{characterRef, characterAnchor, characterOutfit, artStyle, childName, storyPlan, allCharacters}} qaContext
 * @param {object} imageInfo - {index, pageText, sceneDescription} for the candidate
 * @returns {Promise<{score: number, issues: string[]}>}
 */
async function scoreIllustrationAgainstBook(imageBase64, allQaImages, failedChecks, qaContext, imageInfo) {
  if (!imageBase64 || !failedChecks || failedChecks.length === 0) {
    return { score: 100, issues: [] };
  }

  // Build a combined image set: replace the candidate's position with the new image
  const combinedImages = allQaImages.map(img => {
    if (img.index === imageInfo.index) {
      return { ...img, imageBase64 };
    }
    return img;
  });

  // Map check names to check functions
  const checkMap = {
    characterConsistency: () => checkCharacterVisualConsistency(combinedImages, qaContext),
    textAccuracy: () => checkTextAccuracy([{ ...imageInfo, imageBase64 }]),
    fontConsistency: () => checkFontTextConsistency(combinedImages),
    anatomical: () => checkAnatomicalCorrectness([{ ...imageInfo, imageBase64 }]),
    artStyle: () => checkArtStyleConsistency(combinedImages, qaContext),
    colorPalette: () => checkColorPaletteCoherence(combinedImages, qaContext),
    duplicateItems: () => checkDuplicateItems([{ ...imageInfo, imageBase64 }]),
    textWidth: () => checkTextWidthPlacement([{ ...imageInfo, imageBase64 }]),
    sceneAlignment: () => checkSceneTextAlignment([{ ...imageInfo, imageBase64 }]),
    contentSafety: () => checkContentSafety([{ ...imageInfo, imageBase64 }]),
  };

  // Run only the failed checks
  const checksToRun = failedChecks.filter(c => checkMap[c]);
  const results = await Promise.all(
    checksToRun.map(async (checkName) => {
      try {
        const result = await checkMap[checkName]();
        return { checkName, result };
      } catch (e) {
        console.warn(`[illustrationQa] scoreIllustrationAgainstBook: ${checkName} error:`, e.message);
        return { checkName, result: { passed: true, issues: [] } };
      }
    })
  );

  // Calculate weighted score based on the checks we ran
  let score = 0;
  let totalWeight = 0;
  const allIssues = [];

  for (const { checkName, result } of results) {
    const weight = CHECK_WEIGHTS[checkName] || 0;
    totalWeight += weight;
    if (result.passed) {
      score += weight * 100;
    }
    if (result.issues?.length > 0) {
      allIssues.push(...result.issues.map(i => `[${checkName}] ${i}`));
    }
  }

  // Normalize score to 0-100 based on total weight of checks run
  const normalizedScore = totalWeight > 0 ? Math.round(score / totalWeight) : 100;

  return { score: normalizedScore, issues: allIssues };
}

module.exports = {
  runHolisticQa,
  scoreIllustrationAgainstBook,
  // Export individual checks for testing
  checkCharacterVisualConsistency,
  checkColorPaletteCoherence,
  checkAnatomicalCorrectness,
  checkArtStyleConsistency,
  checkSceneTextAlignment,
  checkContentSafety,
  checkFontTextConsistency,
  checkTextAccuracy,
  checkTextWidthPlacement,
  checkDuplicateItems,
  CHECK_WEIGHTS,
};
