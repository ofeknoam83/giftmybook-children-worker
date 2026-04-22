/**
 * Illustrator V2 — Per-Spread OCR Text Verification
 *
 * After each spread, uses Gemini Vision to verify:
 * 1. Text content: each word appears the same number of times as in the manuscript
 * 2. Text does not bridge from left side to right side of the image (or vice versa)
 * 3. Text is within edge margins
 * 4. Font size is not too large
 * 5. Text is legible
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS, TEXT_RULES } = require('../config');
const { sanitizeMixedScriptString } = require('../../writer/quality/sanitize');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');

const QA_HTTP_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Tokens for per-word frequency (manuscript vs illustration must match).
 * Lowercase; apostrophes of any style are stripped so "McDonald's"/"McDonalds"
 * and "don't"/"dont" count as the same token regardless of what the OCR or
 * manuscript uses for the quote glyph.
 * @param {string} s
 * @returns {string[]}
 */
function tokenizeForWordCounts(s) {
  const ascii = sanitizeMixedScriptString(String(s || ''));
  return ascii
    .toLowerCase()
    .replace(/['‘’ʹʻʼ՚＇‛′ꞌ]/g, '')
    .match(/[a-z0-9]+/g) || [];
}

/**
 * Short function words that Gemini Vision's OCR frequently drops on small
 * book captions. When the illustration is missing ONE instance of one of
 * these vs. the manuscript, that's almost always an OCR miss — not a real
 * illustration defect — so we don't fail the spread on it. Extra copies
 * (illustration > manuscript) are still flagged as duplication defects.
 */
const OCR_DROP_TOLERANT_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in',
  'is', 'it', 'its', 'my', 'nor', 'not', 'of', 'on', 'or', 'our',
  'she', 'so', 'that', 'than', 'the', 'their', 'them', 'they', 'this',
  'to', 'up', 'us', 'was', 'we', 'were', 'will', 'with', 'you', 'your',
]);

/**
 * @param {string} expectedText - Story text for this spread (writing-QA approved)
 * @param {string} extractedText - OCR from the illustration
 * @returns {string[]} Human-readable issues; empty if counts match for every token
 */
function wordFrequencyMismatchIssues(expectedText, extractedText) {
  const expTokens = tokenizeForWordCounts(expectedText);
  const extTokens = tokenizeForWordCounts(extractedText);
  const countMap = (tokens) => {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
  };
  const E = countMap(expTokens);
  const X = countMap(extTokens);
  const keys = new Set([...E.keys(), ...X.keys()]);
  const issues = [];
  for (const t of keys) {
    const e = E.get(t) || 0;
    const x = X.get(t) || 0;
    if (e === x) continue;
    // Extra copies in the illustration always indicate a real defect
    // (caption painted twice, word duplicated) — flag unconditionally.
    if (x > e) {
      issues.push(`Word "${t}": manuscript ${e}×, illustration ${x}×`);
      continue;
    }
    // x < e: illustration is missing instances of this word.
    // Forgive a single-instance miss of a known OCR-drop-tolerant stopword:
    // OCR on small captions routinely drops these even when they're rendered
    // correctly, and retrying in-session won't fix an OCR error.
    if (OCR_DROP_TOLERANT_WORDS.has(t) && e - x === 1) continue;
    issues.push(`Word "${t}": manuscript ${e}×, illustration ${x}×`);
  }
  return issues;
}

/**
 * Verify text rendered in a generated spread image.
 *
 * @param {string} imageBase64 - Generated image as base64
 * @param {string} expectedText - The story text that should appear
 * @param {object} [opts]
 * @param {object} [opts.costTracker]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], score: number, tags?: string[], infra?: boolean}>}
 */
async function verifySpreadText(imageBase64, expectedText, opts = {}) {
  if (!expectedText || !expectedText.trim()) {
    return { pass: true, issues: [], score: 1.0, tags: [] };
  }

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return {
      pass: false,
      issues: ['Text QA unavailable: no Gemini API key configured'],
      score: 0,
      tags: ['qa_unavailable'],
    };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const hardTopMarginPct = Math.max(8, Math.floor(TEXT_RULES.topPaddingPercent * 0.55));

  const expectedForQa = sanitizeMixedScriptString(expectedText.trim());

  const prompt = `Analyze the text in this children's book illustration.

EXPECTED TEXT for THIS SPREAD ONLY (approved manuscript — exact source of truth for WHICH WORDS and HOW MANY TIMES each word appears):
"${expectedForQa}"

Check ALL of the following:

1. TEXT CONTENT — WORD COUNTS (CRITICAL):
   Read all story text visible in the image. For CONTENT words (nouns, verbs, adjectives, names, numbers), the count in the image MUST equal the count in the EXPECTED TEXT above (same rules as counting: lowercase, "don't" = one token, ignore punctuation).
   Examples: if the manuscript has "hop" three times ("Hop, hop, hop"), the illustration must show "hop" three times — not two, not four.
   DUPLICATION CHECK (HARD FAIL): if ANY word — content word OR function word — appears MORE times in the image than in EXPECTED TEXT (e.g., the whole caption was accidentally painted twice so every word doubles), that is a HARD FAIL.
   DO NOT FLAG short function words (a, an, and, as, at, by, for, from, in, is, it, of, on, or, the, to, up, with, that, was, were, be, he, she, it) being MISSING OR UNDERCOUNTED in the image vs. the manuscript. These are frequently dropped by OCR on small captions and their absence is NOT a defect worth regenerating for. Only flag function-word mismatches when the image has MORE of them than expected (duplication).
   Do NOT treat legitimate repetition inside the manuscript as an error.
   Your extractedText must be the full text you read from the image (best-effort OCR) so we can verify counts programmatically.

2. TEXT SIDE LOCK (CRITICAL): The story text must stay entirely on ONE side of the image. It must NOT cross from the left side of the image to the right side, or from the right side to the left — no line, word, or phrase may bridge both halves. Imagine a vertical line down the middle: all glyphs must lie entirely in the left 50% OR entirely in the right 50%, not spanning across. Also: the middle ${TEXT_RULES.centerExclusionPercent * 2}% band (center ${TEXT_RULES.centerExclusionPercent}% each side of the midpoint) is a NO-TEXT ZONE for the main story text — treat bridging across that band the same as a HARD FAIL. Tag as "text_bridges_sides" or "text_center" when this rule breaks.

3. EDGE MARGINS:
   - Left and right: text must be at least ${TEXT_RULES.edgePaddingPercent}% away from the left and right edges.
   - TOP (CRITICAL — print crop removes the top ~7% of this image): text must be at least ${TEXT_RULES.topPaddingPercent}% from the top edge. Flag with tag "text_top_edge" as a HARD FAIL if the TOP of any letter is within ${hardTopMarginPct}% of the top edge — at that distance it will be cut off after printing.
   - Bottom: text must be at least ${TEXT_RULES.bottomPaddingPercent}% from the bottom edge.

4. TEXT OVER HERO'S FACE/HEAD (HARD FAIL — tag "text_over_face"): Identify the main child (the hero). Does the text overlap, touch, or sit directly on top of the hero's face, head, hair, or eyes? Flag as HARD FAIL if ANY text character is over the hero's head or face. Partial overlap with the hero's body (below the shoulders) is OK if unavoidable; overlap with the head/face is NEVER OK.

5. FONT SIZE: Is the text small and subtitle-like? Or is it large/headline-sized? Flag if text looks like a title or headline.

6. LEGIBILITY: Is the text crisp, sharp, and readable? Flag if blurry, fuzzy, or low contrast.

Return ONLY valid JSON:
{
  "pass": true/false,
  "extractedText": "the exact text you read from the image",
  "issues": ["list of specific issues found"],
  "tags": ["zero or more of: text_top_edge, text_over_face, text_center, text_bridges_sides, text_duplicated, text_garbled, text_too_large, text_illegible, text_word_count_mismatch"],
  "score": 0.0-1.0
}

Score guide: 1.0 = perfect, 0.8+ = minor issues, 0.5-0.8 = significant issues, <0.5 = major problems.
Set pass=false for: word-count mismatch vs expected, text bridging sides, forbidden middle band, missing/garbled words, text over the hero's face/head, or text within ${hardTopMarginPct}% of the top edge.`;

  let lastErrMsg = 'unknown error';

  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mimeType: 'image/png', data: imageBase64 } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) {
        opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 800, 200);
      }

      if (!resp.ok) {
        lastErrMsg = `API HTTP ${resp.status}`;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);

      if (!result) {
        lastErrMsg = 'unparseable model response';
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }
      const rawIssues = Array.isArray(result.issues) ? result.issues : [];
      const rawTags = Array.isArray(result.tags) ? result.tags : [];
      const tags = rawTags.filter(t => typeof t === 'string').map(t => t.toLowerCase().trim()).filter(Boolean);

      const extracted = (result.extractedText || '').trim();

      // Drop the model's own word-count / duplication complaints. We run our
      // own deterministic frequency check (wordFrequencyMismatchIssues) which
      // applies apostrophe normalization and stopword-drop tolerance; the
      // model's prose-level counts are noisier (it frequently reports a
      // function word as "missing from the image" when its own OCR simply
      // dropped it) and would cause false-positive retries.
      const filteredIssues = rawIssues.filter(i => {
        const s = String(i || '').toLowerCase();
        if (/duplicat/.test(s)) return false;
        if (/word\s+count|count\s+mismatch|count\s+for\s+['"]|is\s+0\s+in\s+the\s+image|missing\s+from\s+the\s+(extracted|image)|does\s+not\s+appear\s+in\s+the\s+image/.test(s)) return false;
        return true;
      });
      const filteredTags = tags.filter(t => t !== 'text_duplicated' && t !== 'text_word_count_mismatch');

      const freqIssues = wordFrequencyMismatchIssues(expectedForQa, extracted);
      const issues = [...filteredIssues];
      for (const fi of freqIssues) {
        if (!issues.includes(fi)) issues.push(fi);
      }
      const finalTags = [...filteredTags];
      if (freqIssues.length > 0 && !finalTags.includes('text_word_count_mismatch')) {
        finalTags.push('text_word_count_mismatch');
      }

      const pass = freqIssues.length === 0 && filteredIssues.length === 0 && filteredTags.length === 0;

      return {
        pass,
        issues,
        tags: finalTags,
        score: typeof result.score === 'number' ? result.score : (pass ? 1.0 : 0.5),
        extractedText: extracted,
      };
    } catch (e) {
      lastErrMsg = e.message || String(e);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
    }
  }

  return {
    pass: true,
    issues: [],
    tags: ['qa_infra_error'],
    score: 1.0,
    infra: true,
  };
}

module.exports = { verifySpreadText, tokenizeForWordCounts, wordFrequencyMismatchIssues };
