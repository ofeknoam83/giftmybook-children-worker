/**
 * Rolling spread-summary memory.
 *
 * After every accepted spread we generate a compact summary; the next
 * spread's writer prompt includes the previous 2 summaries plus the
 * full current beat. This caps writer context at ~4k tokens regardless
 * of book length and avoids v1's long-context repetition collapse.
 *
 * Summaries are tiny LLM calls; we route them to the SUMMARIZER role
 * (Gemini mid-tier in the default routing) which is cheap and fast.
 */

const { callWithRole } = require('../llm/modelRouter');

const SUMMARIZER_SYSTEM = `You compress one spread of a children's book into a short JSON summary used as memory for the next spread. Output STRICT JSON with: { spread, what_happened, emotional_state, callbacks_used, callbacks_pending, open_threads, last_image_cue }. Total payload <= 350 characters. No markdown, no commentary.`;

async function summarizeSpread({ spread, beat, draft, intent }) {
  const userPrompt = JSON.stringify({
    spread,
    beat: {
      purpose: beat?.purpose,
      target_emotion: beat?.target_emotion,
      callbacks_introduced: beat?.callbacks_introduced || [],
      callbacks_used: beat?.callbacks_used || [],
    },
    text: draft?.text || '',
    callbacks_total: (intent?.callback_motifs || []).map((m) => m.id),
  });

  const resp = await callWithRole('SUMMARIZER', {
    systemPrompt: SUMMARIZER_SYSTEM,
    userPrompt,
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 400,
    label: 'v2.summarizer',
  });
  let json = resp.json;
  if (!json && typeof resp.text === 'string') {
    try { json = JSON.parse(resp.text); } catch { json = null; }
  }
  if (!json || typeof json !== 'object') {
    json = {
      spread,
      what_happened: (draft?.text || '').slice(0, 120),
      emotional_state: beat?.target_emotion || 'unknown',
      callbacks_used: beat?.callbacks_used || [],
      callbacks_pending: [],
      open_threads: [],
      last_image_cue: '',
    };
  }
  return json;
}

function recentSummaries(allSummaries, currentSpread, n = 2) {
  return (allSummaries || [])
    .filter((s) => s && typeof s.spread === 'number' && s.spread < currentSpread)
    .sort((a, b) => a.spread - b.spread)
    .slice(-n);
}

module.exports = { summarizeSpread, recentSummaries };
