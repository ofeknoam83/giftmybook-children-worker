/**
 * Illustrator — Consistency QA
 *
 * Per-spread, stateless vision call to gemini-2.5-flash that compares the
 * generated spread against the pinned BOOK COVER. Checks:
 *   - Hero child: same face, ethnicity, skin tone, hair, eye color
 *   - Outfit: same outfit family as cover (unless cover + spread are clearly
 *     in different situations like bedtime pajamas or swimwear)
 *   - Art style: still 3D Pixar render (NOT 2D flat, watercolor, sketch, etc.)
 *   - Secondary people: if the cover has secondaries, they appear here with
 *     the same cover look; if the cover has ONLY the child, no random
 *     strangers appear on the spread.
 *   - One hero (no duplicates) + seamless composition (no split panels)
 *
 * Returns structured tags so the caller can build a concise correction note.
 */

const {
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  QA_TIMEOUT_MS,
  QA_HTTP_ATTEMPTS,
} = require('./config');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractGeminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => p && typeof p.text === 'string' && p.text.length && p.thought !== true)
    .map(p => p.text)
    .join('\n')
    .trim();
}

function parseJsonBlock(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * @param {string} spreadBase64 - Generated spread image.
 * @param {string} coverBase64 - Pinned reference cover image.
 * @param {object} [opts]
 * @param {boolean} [opts.hasSecondaryOnCover]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[], infra?: boolean}>}
 */
async function checkSpreadConsistency(spreadBase64, coverBase64, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: false, issues: ['Consistency QA unavailable: no Gemini API key'], tags: ['qa_unavailable'], infra: true };
  }
  if (!coverBase64) {
    return { pass: false, issues: ['Consistency QA needs cover reference'], tags: ['qa_unavailable'], infra: true };
  }

  const prompt = buildConsistencyPrompt({
    hasSecondaryOnCover: !!opts.hasSecondaryOnCover,
  });
  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'IMAGE 1 — BOOK COVER (ground truth):' },
        { inline_data: { mimeType: 'image/jpeg', data: coverBase64 } },
        { text: 'IMAGE 2 — GENERATED SPREAD (to verify):' },
        { inline_data: { mimeType: 'image/png', data: spreadBase64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, QA_TIMEOUT_MS, opts.abortSignal);
      if (!resp.ok) { lastErr = new Error(`Consistency QA HTTP ${resp.status}`); await sleep(500 * attempt); continue; }
      const data = await resp.json();
      const txt = extractGeminiResponseText(data);
      const parsed = parseJsonBlock(txt);
      if (!parsed) { lastErr = new Error('Consistency QA unparseable response'); await sleep(500 * attempt); continue; }
      return evaluateResult(parsed);
    } catch (err) {
      lastErr = err;
      await sleep(500 * attempt);
    }
  }

  console.warn(`[illustrator/consistencyQa] Fail-open after ${QA_HTTP_ATTEMPTS} attempts: ${lastErr?.message}`);
  return {
    pass: false,
    issues: [`Consistency QA infra error: ${lastErr?.message || 'unknown'}`],
    tags: ['qa_api_error'],
    infra: true,
  };
}

function buildConsistencyPrompt({ hasSecondaryOnCover }) {
  return `You are a quality reviewer comparing a book COVER (Image 1) to a generated interior SPREAD (Image 2). Both should be from the same 3D Pixar children's book.

Return STRICT JSON with this schema (no markdown, no commentary):

{
  "heroChildMatches": <true if the spread hero looks like the child on the cover — same face, ethnicity, skin tone, hair color/style, eye color>,
  "heroChildDifferences": "<short description of any visible differences, or empty string>",
  "outfitMatches": <true if the hero's outfit on the spread is the same outfit family as the cover OR is an explicit situational swap like pajamas/swimwear/coat. False if the outfit is arbitrarily different.>,
  "artStyleIs3DPixar": <true if the spread is rendered in a 3D Pixar CGI style matching the cover — photorealistic soft render, volumetric lighting, subsurface skin scattering, warm palette. False if it drifts into 2D flat, watercolor, pencil sketch, gouache, anime cel, storybook ink, paper cutout, or any other 2D style.>,
  "artStyleNotes": "<short description if artStyleIs3DPixar is false>",
  "heroCount": <integer — how many copies of the hero child appear in the spread. 1 is correct; 2+ is a duplicated-hero bug>,
  "splitPanel": <true if the spread looks like two separate scenes with a visible seam / diptych / before-after layout>,
  "explicitStranger": <true ONLY if the spread shows a non-child human's FULL FACE or a FULL-BODY adult figure that is NOT visible on the cover. ${hasSecondaryOnCover ? 'Adults visible on the cover are allowed to appear fully — they are NOT strangers.' : 'When no adult is on the cover, a fully-rendered adult (face visible, or full body figure) is a failure.'} Hands, arms, back-of-head, a shoulder, or a cropped torso with the face out of frame are NOT explicit — do not flag those as strangers even if the adult is not on the cover. Implied/partial adult presence is expected whenever the spread text references a parent or family member.>,
  "strangerDescription": "<short description of the explicit stranger (full face or full body), or empty>",
  "recurringItemConcerns": "<empty string, or a short note if a previously-introduced item (pet, toy, accessory) appears with a clearly different design from how it would be established in the book's reference cover>"
}

Be strict. A slight style drift (e.g., flatter shading, missing subsurface glow) is still a fail on artStyleIs3DPixar. Duplicated heroes or diptych seams are always a fail. Return ONLY the JSON.`;
}

function evaluateResult(parsed) {
  const issues = [];
  const tags = [];

  if (parsed.heroChildMatches === false) {
    const diff = (parsed.heroChildDifferences || '').trim();
    issues.push(`Hero child does not match cover${diff ? `: ${diff}` : ''}`);
    tags.push('hero_mismatch');
  }
  if (parsed.outfitMatches === false) {
    issues.push('Hero outfit differs from the cover (and not an explicit situational swap)');
    tags.push('outfit_mismatch');
  }
  if (parsed.artStyleIs3DPixar === false) {
    const notes = (parsed.artStyleNotes || '').trim();
    issues.push(`Art style drifts from 3D Pixar${notes ? `: ${notes}` : ''}`);
    tags.push('style_drift');
  }
  if (Number(parsed.heroCount) > 1) {
    issues.push(`Hero child appears ${parsed.heroCount}× (should be 1×)`);
    tags.push('duplicated_hero');
  }
  if (parsed.splitPanel === true) {
    issues.push('Spread looks like a split panel / diptych with a visible seam');
    tags.push('split_panel');
  }
  // Only a full FACE or full-body adult figure not on the cover is a failure.
  // Implicit presence (hands, arms, back-of-head, cropped torso without face)
  // is allowed because per-spread prompts often reference a parent who is not
  // on the cover (e.g. "Analeigh wakes by Mommy").
  if (parsed.explicitStranger === true) {
    const who = (parsed.strangerDescription || '').trim();
    issues.push(`Unexpected person on spread${who ? `: ${who}` : ''}`);
    tags.push('unexpected_person');
  }
  if (parsed.recurringItemConcerns && String(parsed.recurringItemConcerns).trim()) {
    issues.push(`Recurring item concern: ${parsed.recurringItemConcerns}`);
    tags.push('recurring_item_drift');
  }

  return {
    pass: issues.length === 0,
    issues,
    tags: [...new Set(tags)],
  };
}

module.exports = { checkSpreadConsistency };
