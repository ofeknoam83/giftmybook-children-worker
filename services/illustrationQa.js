/**
 * Illustration QA Service
 *
 * Individual illustration checks used by per-spread QA and consistency
 * validation. The holistic QA orchestrator (runHolisticQa) was removed
 * because it loaded all 13 upscaled images into memory, causing OOM
 * crashes at the 4096 MiB Cloud Run limit.
 */

const { getNextApiKey, fetchWithTimeout } = require('./illustrationGenerator');

const GEMINI_QA_MODEL = 'gemini-2.5-flash';
const MAX_IMAGES_PER_REQUEST = 4;


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

module.exports = {
  // Individual checks — used by per-spread QA and consistency validation
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
};
