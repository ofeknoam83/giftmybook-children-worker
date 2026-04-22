/**
 * Book-wide "easy" consistency gate — one vision call with all interior spreads.
 * Uses the same illustration system rules (from session) + gemini-2.5-flash for QA.
 * Only flags obvious defects; overlap/visibility rules match cross-spread philosophy.
 */

const sharp = require('sharp');
const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_HTTP_ATTEMPTS } = require('../config');
const { fetchWithTimeout, getNextApiKey } = require('../../illustrationGenerator');
const { extractGeminiResponseText, parseQaJsonFromText } = require('./geminiJson');
const { formatBibleForQa } = require('./consistency');

const QA_TIMEOUT_MS = 120000;
const REVIEW_MAX_EDGE_PX = 896;
const REVIEW_JPEG_QUALITY = 82;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Downscale spread image for a single multimodal QA request (payload limits).
 * @param {string} imageBase64
 * @returns {Promise<string>} base64 jpeg
 */
async function shrinkSpreadForReview(imageBase64) {
  const buf = Buffer.from(imageBase64, 'base64');
  const out = await sharp(buf)
    .resize(REVIEW_MAX_EDGE_PX, REVIEW_MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: REVIEW_JPEG_QUALITY })
    .toBuffer();
  return out.toString('base64');
}

/**
 * One-shot book-wide review (obvious problems only).
 *
 * @param {object|null} session - Illustrator session (uses systemInstruction + apiKey fallback)
 * @param {Array<{index: number, imageBase64: string, pageText?: string}>} spreads
 * @param {object} opts
 * @param {object} [opts.storyBible]
 * @param {string} [opts.theme]
 * @param {boolean} [opts.hasParentOnCover]
 * @param {boolean} [opts.hasSecondaryOnCover]
 * @param {string|null} [opts.parentOutfit] - when set, parent clothing is story-locked
 * @param {string|null} [opts.additionalCoverCharacters]
 * @param {object} [opts.costTracker]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], suspectSpreads: number[], infra?: boolean}>}
 */
async function runBookWideConsistencyReview(session, spreads, opts = {}) {
  if (!spreads || spreads.length < 2) {
    return { pass: true, issues: [], suspectSpreads: [] };
  }

  const apiKey = session?.apiKey || getNextApiKey();
  if (!apiKey) {
    console.warn('[illustrator/quality/bookWideGate] No API key — passing gate (infra)');
    return { pass: true, issues: [], suspectSpreads: [], infra: true };
  }

  const ordered = [...spreads].sort((a, b) => a.index - b.index);
  const bibleBlock = formatBibleForQa(opts.storyBible);
  const systemRules = session?.systemInstruction
    ? String(session.systemInstruction).slice(0, 12000)
    : '';

  const isParentTheme = opts.theme === 'mothers_day' || opts.theme === 'fathers_day';
  const parentOnCover = opts.hasParentOnCover === true;
  const parentOutfitLock = opts.parentOutfit && String(opts.parentOutfit).trim();

  /** Overrides rigid "same hair/outfit every page" lines from systemInstruction for hidden-face parent. */
  const parentHiddenFaceQaOverride = isParentTheme && !parentOnCover
    ? `
⚠️ QA OVERRIDE — PARENT NOT ON COVER (FACE HIDDEN IN ILLUSTRATIONS):
The ILLUSTRATION RULES above tell the *generator* to lock hair/outfits and family resemblance. For THIS quality check only, interpret them narrowly:

- The HERO CHILD must stay visually consistent across spreads (overlap rule: compare only what is clearly visible in 2+ images).
- The PARENT (${opts.theme === 'mothers_day' ? 'mother' : 'father'}) often appears ONLY as partial body (hands, arms, back, cropped head). Do NOT fail the book because the parent's clothing, hat, hair length, curl, or apparent "outfit" looks different between spreads unless the SAME visible body region clearly contradicts itself between two spreads where it is both visible.
- Different scenes may read as different shirts/dresses or accessories when the parent is mostly off-frame — that is OK for face-hidden parent. Default to pass unless an uninformed viewer would say "clearly two different adults" from overlapping visible skin/hands.
- Do NOT require the parent's hairstyle or wardrobe to match spread-to-spread like the child's locked outfit unless ${parentOutfitLock ? `the story locked ONE parent outfit (see bible / "${String(parentOutfitLock).slice(0, 200)}") — then only flag if clearly visible clothing violates that lock in overlapping views.` : 'the story bible explicitly locks a single parent outfit AND that outfit is clearly visible in multiple spreads.'}
- Do NOT flag parent skin tone vs child's face using different lighting; only obvious wrong-person / wrong-ethnicity for the same character.
- Do NOT infer "Mama must match cover secondary" unless the cover secondary is explicitly the same person as the parent (here: parent is usually NOT on cover).
`
    : '';

  const coverNote = opts.additionalCoverCharacters && opts.hasSecondaryOnCover
    ? `Cover secondary (must match when same person clearly visible in multiple spreads): ${String(opts.additionalCoverCharacters).slice(0, 600)}
MEDIA EXCLUSION: If the cover depicts that secondary person INSIDE media — on a TV / phone / tablet / computer / cinema screen, in a framed photo, on a poster, magazine cover, book cover, billboard, or painting — they are scene decor, not a recurring character. Figures shown inside such media in other spreads (e.g. a different performer on a TV, a different poster on a wall) are free to differ from the cover. Do NOT flag that as a cover-secondary mismatch; only flesh-and-blood recurring people count.`
    : '';

  const qaPreamble = `QA MODE — LENIENT, OVERLAP-ONLY:
You are checking finished interior art for obvious breakage only. Prefer pass=true when unsure. Compare traits (hair, outfit, face) only where the same body region is clearly visible in two or more spreads. Do not fail on crops, lighting, or font details (handled elsewhere).

`;

  const introText = `${qaPreamble}You are a lenient final QA pass for a children's picture book. The images below are the INTERIOR SPREADS ONLY, in order from first to last (spread 1 through spread ${ordered.length}).

ILLUSTRATION RULES (same session the book was drawn under):
${systemRules || '(no session rules provided)'}

${bibleBlock ? `STORY BIBLE GROUND TRUTH:\n${bibleBlock}\n` : ''}
${coverNote ? `${coverNote}\n` : ''}
${parentHiddenFaceQaOverride}

YOUR JOB — OBVIOUS DEFECTS ONLY (do NOT nitpick):
- If a "QA OVERRIDE" block appears above, it **overrides** conflicting sentences in ILLUSTRATION RULES for this check only.
- Use the OVERLAP rule: only compare a trait (hair, outfit, face, skin) if it is clearly visible in TWO OR MORE spreads. Do NOT fail because a detail appears in one spread but is missing or cropped in another.
- Flag ONLY if an uninformed viewer would immediately agree something is broken: e.g. the hero child clearly looks like a different person across spreads where the face is visible in both; duplicate hero in one spread; grotesque extra limbs; obvious split-panel / diptych seam; same recurring secondary clearly a different individual when comparable; blatant contradiction of the story bible for named characters.
- Do NOT flag: normal lighting/color shifts, pose changes, different scenes, parent hands vs child face tone, missing hair/outfit in crops, minor proportion drift, or font/text details (checked elsewhere).

suspectSpreads — MINORITY / OUTLIER RULE (critical):
- "suspectSpreads" must list ONLY the OUTLIER spreads that DEVIATE from the majority look and/or the story bible. It is NEVER the full book.
- Example: if spreads 1,2,4,5,7,8,9,11,12,13 show the hero with hair A and outfit A, and spreads 3,10 show hair B / outfit B — suspectSpreads MUST be [3, 10]. Do NOT return [1,2,3,4,5,7,8,9,10,11,12,13].
- Tie-breaker when a majority exists: the MAJORITY is canonical; the outliers go in suspectSpreads.
- If the story bible agrees with one side, that side is canonical; the other side is the outlier list.
- If there is no clear majority (roughly 50/50 split) OR you cannot isolate the outliers to a small subset, prefer pass=true with an empty suspectSpreads. Do NOT list more than half of the spreads as suspects.
- Cap: suspectSpreads should contain at most ${Math.max(1, Math.floor(ordered.length / 2))} spreads (half the book, rounded down). If you would need to list more, the book is not obviously broken — return pass=true.

Return ONLY valid JSON:
{"pass": true, "issues": [], "suspectSpreads": []}
or
{"pass": false, "issues": ["short reasons"], "suspectSpreads": [1-based outlier spread numbers only]}

When pass=false, issues must be short and suspectSpreads must be the MINORITY outliers only. Default to pass=true if unsure.`;

  const thumbs = await Promise.all(ordered.map(s => shrinkSpreadForReview(s.imageBase64)));
  const parts = [{ text: introText }];
  for (let i = 0; i < ordered.length; i++) {
    parts.push({ text: `Spread ${i + 1} (book order):` });
    parts.push({ inline_data: { mimeType: 'image/jpeg', data: thumbs[i] } });
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  let lastHttp = null;
  for (let attempt = 0; attempt < QA_HTTP_ATTEMPTS; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, opts.abortSignal);

      if (opts.costTracker) {
        opts.costTracker.addTextUsage(GEMINI_QA_MODEL, 4000 + ordered.length * 400, 200);
      }

      if (!resp.ok) {
        lastHttp = resp.status;
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        continue;
      }

      const data = await resp.json();
      const text = extractGeminiResponseText(data);
      const result = parseQaJsonFromText(text);

      if (!result || typeof result.pass !== 'boolean') {
        if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
        else {
          console.warn('[illustrator/quality/bookWideGate] Unparseable QA after retries — passing (infra)');
          return { pass: true, issues: [], suspectSpreads: [], infra: true };
        }
        continue;
      }

      const issues = Array.isArray(result.issues) ? result.issues.filter(x => typeof x === 'string') : [];
      const suspectSpreads = Array.isArray(result.suspectSpreads)
        ? result.suspectSpreads.filter(n => typeof n === 'number' && n >= 1)
        : [];

      return {
        pass: !!result.pass,
        issues,
        suspectSpreads,
      };
    } catch (e) {
      console.warn(`[illustrator/quality/bookWideGate] Attempt ${attempt + 1}: ${e.message}`);
      if (attempt < QA_HTTP_ATTEMPTS - 1) await sleep(1000 * (attempt + 1));
      else {
        console.warn('[illustrator/quality/bookWideGate] Error after retries — passing (infra)');
        return { pass: true, issues: [], suspectSpreads: [], infra: true };
      }
    }
  }

  console.warn(`[illustrator/quality/bookWideGate] HTTP failed (${lastHttp}) — passing (infra)`);
  return { pass: true, issues: [], suspectSpreads: [], infra: true };
}

module.exports = { runBookWideConsistencyReview, shrinkSpreadForReview };
