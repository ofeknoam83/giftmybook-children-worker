/**
 * Illustrator — Action Consistency QA
 *
 * Per-spread, stateless vision call to gemini-2.5-flash that checks two
 * tightly-related properties of the rendered image:
 *
 *   1. Does the IMAGE depict the action the TEXT (and the spreadSpec's
 *      focalAction) says is happening? Spread 6 of Scarlett's book said
 *      "Scarlett helps with mighty will. One hand holds the strap" while
 *      the image showed her strapped IN the stroller — that is what we are
 *      catching here. (PRD C.1)
 *
 *   2. Is the action depicted POSSIBLE for the hero's declared age? An
 *      8-month-old "running down the street" or "spinning on the hilltop"
 *      is a hard fail regardless of what the manuscript text says — the
 *      writer-side prompt fix is the primary defence (A.5/A.6) and this is
 *      the backstop for the rendered image. (PRD C.2)
 *
 * Both checks share an image, an API call, and a JSON response — they live
 * in one module to halve the QA latency budget. Returns structured tags so
 * the caller can build a concise correction note.
 *
 * Tags emitted:
 *   - action_mismatch       : the depicted action does not match the text/spec
 *   - age_action_impossible : the depicted action is age-impossible
 */

const {
  GEMINI_QA_MODEL,
  CHAT_API_BASE,
  QA_TIMEOUT_MS,
  QA_HTTP_ATTEMPTS,
} = require('./config');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');
const { AGE_BANDS } = require('../bookPipeline/constants');

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
 * Render a short, concrete description of what a child of this age band
 * physically cannot do. Used in the vision prompt so the model has a fixed
 * yardstick rather than guessing.
 *
 * @param {string} ageBand
 * @param {number|string|null} childAge
 * @returns {string}
 */
function ageActionLimitsForBand(ageBand, childAge) {
  // Tightest band: the lap-baby tier added in PR A. Cap actions to what an
  // infant under ~18 months can physically do, with a hard floor on
  // independent locomotion. The numeric child age (in years) refines the
  // limits when present.
  if (ageBand === AGE_BANDS.PB_INFANT) {
    const ageYrs = Number(childAge);
    let monthsHint = '';
    if (Number.isFinite(ageYrs) && ageYrs >= 0 && ageYrs < 2) {
      monthsHint = ` (~${Math.max(1, Math.round(ageYrs * 12))} months old)`;
    }
    return [
      `Hero age: lap-baby${monthsHint}.`,
      'Cannot stand unsupported (under ~12 months), cannot walk (under ~14 months),',
      'cannot run, cannot jump, cannot climb a hill or stair alone, cannot ride a bike/scooter,',
      'cannot lift heavy objects, cannot lead an adult anywhere, cannot dance unaided,',
      'cannot twirl/spin while standing, cannot tiptoe.',
      'CAN: be held, sit supported, lie on a blanket, reach, smile, look, pat/touch a small object,',
      'be carried, snuggle, point, clap, peekaboo, coo, kick on a blanket.',
    ].join(' ');
  }
  // Other bands: light yardstick — only flag clearly impossible stunts.
  return 'Use common-sense developmental yardsticks for the declared age band; flag only clearly impossible feats.';
}

/**
 * @param {string} spreadBase64 - Generated spread image (base64).
 * @param {object} opts
 * @param {string} opts.text - The manuscript text that appears on the spread.
 * @param {string} [opts.focalAction] - The spread spec's focalAction sentence.
 * @param {string} [opts.ageBand] - constants.AGE_BANDS.* value.
 * @param {number|string|null} [opts.childAge] - Child age in years.
 * @param {string} [opts.heroName] - Name of the hero (used in the prompt).
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{pass: boolean, issues: string[], tags: string[], infra?: boolean}>}
 */
async function checkSpreadActionConsistency(spreadBase64, opts = {}) {
  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { pass: false, issues: ['Action QA unavailable: no Gemini API key'], tags: ['qa_unavailable'], infra: true };
  }
  if (!spreadBase64) {
    return { pass: false, issues: ['Action QA needs a rendered spread image'], tags: ['qa_unavailable'], infra: true };
  }
  const text = String(opts.text || '').trim();
  const focalAction = String(opts.focalAction || '').trim();
  if (!text && !focalAction) {
    // Nothing to compare against — fail open (don't manufacture failures).
    return { pass: true, issues: [], tags: [] };
  }

  const ageLimits = ageActionLimitsForBand(opts.ageBand, opts.childAge ?? null);
  const heroName = String(opts.heroName || 'the hero child').trim() || 'the hero child';
  const prompt = buildActionConsistencyPrompt({ text, focalAction, ageLimits, heroName });
  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: 'IMAGE — GENERATED SPREAD UNDER REVIEW (judge what the hero is doing in this image):' },
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
      if (!resp.ok) { lastErr = new Error(`Action QA HTTP ${resp.status}`); await sleep(500 * attempt); continue; }
      const data = await resp.json();
      const txt = extractGeminiResponseText(data);
      const parsed = parseJsonBlock(txt);
      if (!parsed) { lastErr = new Error('Action QA unparseable response'); await sleep(500 * attempt); continue; }
      return evaluateActionResult(parsed);
    } catch (err) {
      lastErr = err;
      await sleep(500 * attempt);
    }
  }

  console.warn(`[illustrator/actionConsistencyQa] Fail-open after ${QA_HTTP_ATTEMPTS} attempts: ${lastErr?.message}`);
  return {
    pass: false,
    issues: [`Action QA infra error: ${lastErr?.message || 'unknown'}`],
    tags: ['qa_api_error'],
    infra: true,
  };
}

function buildActionConsistencyPrompt({ text, focalAction, ageLimits, heroName }) {
  const focalLine = focalAction
    ? `Intended focal action (from the spread spec): "${focalAction}"`
    : '(no spread-spec focal action provided — judge against the manuscript text only)';
  const textLine = text
    ? `Manuscript text on this spread:\n${text}`
    : '(no manuscript text provided)';
  return `You are a quality reviewer for a personalized children's book. Look at the spread image and judge whether the picture matches the words and the hero's age.

${textLine}
${focalLine}
${ageLimits}

Judge two things, separately and conservatively:

A) ACTION MATCH \u2014 does the IMAGE show ${heroName} doing the action the TEXT and FOCAL ACTION describe?
   - If the text says "helps push the stroller" and the image shows ${heroName} strapped INSIDE the stroller (passive), that is action_mismatch \u2014 the depicted action is the opposite of "helping push".
   - If the text says "leads Mama up the hill" and the image shows ${heroName} being carried, that is action_mismatch.
   - If the text says "claps her hands" and the image shows ${heroName} doing nothing visible with the hands, that is action_mismatch.
   - If the text describes an action and the image plausibly depicts that action OR a closely-related supported equivalent (\"watches the puppy from Mama's lap\" matches \"reaches for the puppy from Mama's lap\"), that is a PASS \u2014 do not flag.
   - When uncertain, prefer pass.

B) AGE-ACTION POSSIBILITY \u2014 given the hero's age limits above, is the depicted action physically possible for a child of that age?
   - The age limits are based on developmental yardsticks; honor them strictly when ageBand is PB_INFANT.
   - A 7-month-old standing alone on a dock, walking up a hill, twirling, tiptoeing, chasing a puppy, or running across a meadow is age_action_impossible \u2014 a hard fail.
   - A 7-month-old being held by a parent, sitting in a stroller, lying on a blanket, reaching from a high chair, smiling on a lap is age-appropriate \u2014 PASS.
   - For non-infant bands, only flag clearly impossible stunts (a 3-year-old "driving the car", a 5-year-old "lifting a refrigerator"). Otherwise pass.
   - When uncertain, prefer pass.

Return STRICT JSON with this exact schema (no markdown, no commentary):

{
  "actionMatches": <true if the image shows the hero performing the action implied by the text/focalAction (or a closely-related supported equivalent); false on a clear mismatch (e.g. text says "helps push" but image shows hero strapped in passively, text says "leads" but image shows hero being carried, text says "climbs" but image shows hero seated). When uncertain, prefer true.>,
  "actionMismatchReason": "<one short sentence naming what the text said and what the image shows, or empty string>",
  "ageActionPossible": <true if the depicted action is physically possible for the declared age band; false on a clear age impossibility (lap-baby standing, walking, running, climbing, twirling, leading). When uncertain, prefer true.>,
  "ageActionReason": "<one short sentence naming the impossible action and why, or empty string>"
}

Return ONLY the JSON.`;
}

/**
 * @param {object} parsed Model JSON.
 * @returns {{pass: boolean, issues: string[], tags: string[]}}
 */
function evaluateActionResult(parsed) {
  const issues = [];
  const tags = [];
  if (parsed && parsed.actionMatches === false) {
    const why = (parsed.actionMismatchReason || '').trim();
    issues.push(`Depicted action does not match the spread text${why ? `: ${why}` : ''}`);
    tags.push('action_mismatch');
  }
  if (parsed && parsed.ageActionPossible === false) {
    const why = (parsed.ageActionReason || '').trim();
    issues.push(`Depicted action is not possible for the hero's age${why ? `: ${why}` : ''}`);
    tags.push('age_action_impossible');
  }
  return {
    pass: issues.length === 0,
    issues,
    tags: [...new Set(tags)],
  };
}

module.exports = {
  checkSpreadActionConsistency,
  evaluateActionResult,
  ageActionLimitsForBand,
};
