/**
 * Writer draft stage.
 *
 * Writes the full manuscript using the storyBible, visualBible, and spread
 * specs. Produces strict-JSON one entry per spread with text, side, and
 * line-break hints. Does not redesign plot structure.
 */

const { callText } = require('../llm/openaiClient');
const { MODELS, TOTAL_SPREADS } = require('../constants');
const { updateSpread, appendLlmCall } = require('../schema/bookDocument');
const { renderTextPolicyBlock } = require('./textPolicies');
const { selectRetryMemory, renderRetryMemoryForPrompt } = require('../retryMemory');

const SYSTEM_PROMPT = `You write premium children's book prose for image-first spreads.

Hard rules:
- Write the actual spread text. Honor the spread spec exactly (side, line target, personalization).
- Read-aloud quality comes first. Musical cadence, simple words, no large metaphors, low repetition.
- Third-person by default unless the user prompt overrides.
- Funny/playful tone, character-based humor. Mostly implicit emotional meaning — never preach.
- Use the child's name sometimes, not constantly. Use custom details concretely.
- Each spread's text must be plausible to render in ${2}-${4} lines on one side of the illustration.
- No line may be longer than ~14 words. No text that would cross the horizontal center of the spread when painted.
- Return ONLY strict JSON: { "spreads": [ { "spreadNumber": 1, "text": "...", "side": "left|right", "lineBreakHints": ["..."], "personalizationUsed": ["..."], "writerNotes": "optional" }, ... ] }.`;

function userPrompt(doc) {
  const { storyBible, visualBible, spreads } = doc;
  const retries = selectRetryMemory(doc.retryMemory, 'writerDraft');
  const retryBlock = renderRetryMemoryForPrompt(retries);
  const specs = spreads.map(s => ({
    spreadNumber: s.spreadNumber,
    purpose: s.spec?.purpose,
    plotBeat: s.spec?.plotBeat,
    emotionalBeat: s.spec?.emotionalBeat,
    humorBeat: s.spec?.humorBeat,
    location: s.spec?.location,
    focalAction: s.spec?.focalAction,
    textSide: s.spec?.textSide,
    textLineTarget: s.spec?.textLineTarget,
    mustUseDetails: s.spec?.mustUseDetails,
    forbiddenMistakes: s.spec?.forbiddenMistakes,
  }));

  return [
    renderTextPolicyBlock(doc),
    '',
    `Story bible:\n${JSON.stringify(storyBible, null, 2)}`,
    '',
    `Visual cues (for tone only — do NOT describe images in prose):\n${JSON.stringify({
      palette: visualBible.palette,
      environmentAnchors: visualBible.environmentAnchors,
    }, null, 2)}`,
    '',
    `Spread specs (length ${TOTAL_SPREADS}):\n${JSON.stringify(specs, null, 2)}`,
    retryBlock ? `\n${retryBlock}` : '',
    'Emit the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * Apply the JSON manuscript onto the document.
 *
 * @param {object} doc
 * @param {any} json
 * @returns {object}
 */
function applyManuscript(doc, json) {
  const arr = Array.isArray(json?.spreads) ? json.spreads : [];
  let next = doc;
  for (const entry of arr) {
    const n = Number(entry?.spreadNumber);
    if (!Number.isFinite(n) || n < 1 || n > TOTAL_SPREADS) continue;
    const manuscript = {
      text: String(entry.text || '').trim(),
      side: entry.side === 'left' ? 'left' : 'right',
      lineBreakHints: Array.isArray(entry.lineBreakHints) ? entry.lineBreakHints.map(String) : [],
      personalizationUsed: Array.isArray(entry.personalizationUsed) ? entry.personalizationUsed.map(String) : [],
      writerNotes: entry.writerNotes ? String(entry.writerNotes) : null,
    };
    next = updateSpread(next, n, s => ({
      ...s,
      manuscript,
    }));
  }
  return next;
}

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function draftBookText(doc) {
  const result = await callText({
    model: MODELS.WRITER,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPrompt(doc),
    jsonMode: true,
    temperature: 0.95,
    maxTokens: 12000,
    label: 'writerDraft',
    abortSignal: doc.operationalContext?.abortSignal,
  });

  const next = applyManuscript(doc, result.json);
  return appendLlmCall(next, {
    stage: 'writerDraft',
    model: result.model,
    attempts: result.attempts,
    usage: result.usage,
  });
}

module.exports = { draftBookText, applyManuscript };
