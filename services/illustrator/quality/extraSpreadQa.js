/**
 * Per-spread QA: cover-secondary match, implicit parent–child resemblance, birthday candle count.
 * One vision call when any check applies.
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');

const QA_HTTP_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * @param {string} imageBase64
 * @param {object} opts
 * @param {string} [opts.spreadPrompt]
 * @param {string} [opts.spreadText]
 * @param {string} [opts.theme]
 * @param {number} [opts.celebrationAge]
 * @param {string} [opts.coverBase64]
 * @param {string|null} [opts.additionalCoverCharacters]
 * @param {boolean} [opts.hasSecondaryOnCover]
 * @param {boolean} [opts.hasParentOnCover] - parent theme: true if themed parent appears on cover (from cover vision)
 * @param {number} [opts.spreadIndex] 0-based
 * @param {number} [opts.totalSpreads]
 * @param {object} [opts.costTracker]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[]}>}
 */
async function checkExtraSpreadQa(imageBase64, opts = {}) {
  const {
    spreadPrompt = '',
    spreadText = '',
    theme = '',
    celebrationAge,
    coverBase64 = null,
    additionalCoverCharacters = null,
    hasSecondaryOnCover = false,
    hasParentOnCover,
    spreadIndex = 0,
    totalSpreads = 13,
    costTracker,
    abortSignal,
  } = opts;

  const isBirthday = theme === 'birthday' || theme === 'birthday_magic';
  const isParentTheme = theme === 'mothers_day' || theme === 'fathers_day';
  const lastSpread = spreadIndex >= totalSpreads - 1;
  const mentionsCake = /\b(cake|candle|candles|birthday\s+cake)\b/i.test(`${spreadPrompt} ${spreadText}`);
  const needsCandles = isBirthday && typeof celebrationAge === 'number' && celebrationAge >= 0
    && (mentionsCake || lastSpread);

  const needsCoverSecondary = !!(coverBase64 && additionalCoverCharacters && hasSecondaryOnCover);
  const mentionsParent = /\b(mom|dad|mother|father|parent|mama|mommy|daddy|papa|mum|grandma|grandpa)\b/i.test(`${spreadPrompt} ${spreadText}`);
  const needsParentResemblance = isParentTheme || mentionsParent || hasSecondaryOnCover;

  if (!needsCandles && !needsCoverSecondary && !needsParentResemblance) {
    return { pass: true, issues: [], tags: [] };
  }

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return {
      pass: false,
      issues: ['Extra spread QA unavailable: no Gemini API key'],
      tags: ['qa_unavailable'],
    };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const parentOnCover = hasParentOnCover === true;

  let instruction = `You are QA for one children's book spread illustration.

VISIBILITY / OVERLAP (same rule as cross-spread QA): Judge only what is clearly visible in THIS spread. When you compare to the cover image, compare only traits that appear on BOTH the cover and this spread for that same person. If this spread shows only part of someone (hands, arms, back, cropped head), only those visible parts must be consistent with the cover for identity — do NOT fail because hair, full outfit, or other regions are absent, off-frame, or not comparable. Do not invent contradictions for body parts you cannot see.

`;

  if (needsCoverSecondary) {
    instruction += `
CHECK A — COVER SECONDARY MATCH:
- The FIRST image below is the BOOK COVER (reference). The SECOND image is THIS SPREAD.
- MEDIA EXCLUSION (critical): People depicted INSIDE media on the cover — a performer on a TV or tablet/phone/computer/cinema screen, a figure in a framed photo, a face on a poster / magazine cover / book cover / billboard / painting — are SCENE DECOR, not a "cover secondary person". The cover-secondary identity lock does NOT apply to them. If a similar media element (TV, poster, etc.) appears in this spread, the figure shown on it may look different (different show / different program / different artwork) — that is NORMAL and must PASS. Only a flesh-and-blood secondary person physically present in the cover scene counts.
- If THIS SPREAD clearly shows the same real (non-media) secondary person as on the cover (not just anonymous crowd), they must be the same individual. Apply the VISIBILITY rule: match only skin, hair, build, and clothing regions that are **clearly visible on both** cover and this spread. If the spread shows only a partial view, matching that partial to the cover is enough — do not require full-body agreement with unseen areas.
- If the spread does NOT show that secondary person (or shows only a media/screen version of them), pass A.
Cover secondary description: ${String(additionalCoverCharacters).slice(0, 800)}
`;
  }

  if (needsParentResemblance) {
    if (isParentTheme && !parentOnCover) {
      instruction += `
CHECK B — PARENT (face hidden / not on cover; partial body only):
- If a parent figure appears only as hands, arms, back, or cropped head (no full face), do NOT require their visible skin or hair to "match" the hero child's face for family resemblance.
- Apply partial-view logic: only assess what is visible; do NOT flag parent vs child skin tone differences when you only see the parent's limbs.
- Do NOT flag lighting/shadow or minor tone shifts on hands/arms.
- Flag only if the visible adult parts look like a categorically different, unrelated person in a way an uninformed viewer would notice (wrong-person energy), or if a full parent face wrongly appears when it should stay hidden.
- If no adult is present, pass B.

`;
    } else {
      instruction += `
CHECK B — PARENT / IMPLIED ADULT vs CHILD (strict only on clear mismatch):
- If an adult is visible or clearly implied as mother/father/parent (even back of head, arms/hands only), their visible skin tone and hair should look plausibly related to the main child where both are visible enough to compare.
- Do NOT flag lighting/shadow, sun tan lines, slight warmth/coolness shifts, or minor tone differences on hands/arms vs the child's face.
- Do NOT flag unless the adult clearly occupies a meaningful part of the frame (roughly >15% of image area) AND looks like a categorically different ethnicity from the child (e.g. pale pink skin vs deep brown skin with hair in an unrelated color family) such that an uninformed viewer would say they are probably not related.
- If no adult is present, pass B.

`;
    }
  }

  if (needsCandles) {
    instruction += `
CHECK C — BIRTHDAY CANDLES:
- Count ONLY lit candles on the birthday cake. If there is no cake with candles, set candleCount to null and pass C.
- Expected count: exactly ${celebrationAge}.
- If there IS a cake with lit candles, candleCount must equal ${celebrationAge} or C fails.

`;
  }

  instruction += `
Return ONLY valid JSON:
{"pass": true/false, "issues": [], "tags": [], "checks": {"cover_secondary_ok": true/false, "parent_resemblance_ok": true/false, "candles_ok": true/false, "candleCount": null}}

For checks not run, set the corresponding *_ok to true. Set pass=false if ANY run check fails. Tags: cover_secondary_mismatch, parent_resemblance_fail, candle_count_mismatch.
`;

  const parts = [{ text: instruction }];
  if (needsCoverSecondary) {
    parts.push({ inline_data: { mimeType: 'image/jpeg', data: coverBase64 } });
  }
  parts.push({ inline_data: { mimeType: 'image/png', data: imageBase64 } });

  let lastErr = null;
  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 512,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, abortSignal);

      if (costTracker) costTracker.addTextUsage(GEMINI_QA_MODEL, 700, 150);

      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);
      if (!result) {
        lastErr = new Error('unparseable JSON');
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim())
        .filter(Boolean);

      return {
        pass: !!result.pass,
        issues: Array.isArray(result.issues) ? result.issues : [],
        tags,
      };
    } catch (e) {
      lastErr = e;
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
    }
  }

  return {
    pass: true,
    issues: [],
    tags: ['qa_infra_error'],
    infra: true,
  };
}

module.exports = { checkExtraSpreadQa };
