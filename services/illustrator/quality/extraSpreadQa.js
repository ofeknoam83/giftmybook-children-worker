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
    spreadIndex = 0,
    totalSpreads = 13,
    costTracker,
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

  let instruction = `You are QA for one children's book spread illustration.\n`;

  if (needsCoverSecondary) {
    instruction += `
CHECK A — COVER SECONDARY MATCH:
- The FIRST image below is the BOOK COVER (reference). The SECOND image is THIS SPREAD.
- If THIS SPREAD clearly shows the same secondary person as on the cover (not just anonymous crowd), they MUST match: skin tone, hair color/family, build — same individual. If the spread does NOT show that secondary person, pass A.
Cover secondary description: ${String(additionalCoverCharacters).slice(0, 800)}
`;
  }

  if (needsParentResemblance) {
    instruction += `
CHECK B — PARENT / IMPLIED ADULT vs CHILD:
- If an adult is visible or clearly implied as mother/father/parent (even back of head, arms only), their visible skin tone and hair must look plausibly related to the main child (family resemblance). Flag if the adult looks like a totally different ethnicity from the child in a way that breaks family continuity.
- If no adult is present, pass B.

`;
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
      }, QA_TIMEOUT_MS);

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
    pass: false,
    issues: [`Extra spread QA failed after retries: ${lastErr?.message || 'unknown'}`],
    tags: ['qa_api_error'],
  };
}

module.exports = { checkExtraSpreadQa };
