/**
 * Illustrator V2 — Scene prose safety rewriter.
 *
 * When Gemini's image classifier returns `blockReason=OTHER` we know the
 * request was refused at the prompt-feedback level. Our engine already has
 * two tiers of local "softening" (strip engine-added overlays, rewrite
 * `NEVER`→`do not`, drop CRITICAL RULES block) but those tiers do not touch
 * the **scene prose** that came from the story planner. That prose is
 * almost always the actual trigger — a phrase the writer produced that reads
 * unsafe to the image classifier when combined with the photoreal cover
 * reference.
 *
 * This module is a surgical LLM pass that rewrites ONLY the scene prose for
 * safety, preserving the visual content so continuity with prior spreads is
 * maintained. It is invoked by engine.js only after a safety block, never
 * preemptively (LLM cost is not worth paying on every spread).
 *
 * Design notes:
 * - Uses Gemini 2.5 Flash (same model as QA agents) to keep latency low.
 * - Routes through the round-robin API key pool shared with other illustrator
 *   QA callers, so it scales with the existing key budget.
 * - On any failure — API error, empty/unparseable response, abort — returns
 *   the original scene unchanged rather than throwing. The caller will still
 *   fall through to the proxy fallback tier if the rewrite can't be produced.
 * - Temperature is intentionally low (0.2) so rewrites stay close to the
 *   original wording; we don't want to rewrite a scared-in-the-dark scene
 *   into a fundamentally different story beat.
 */

const { GEMINI_QA_MODEL, CHAT_API_BASE, QA_TIMEOUT_MS } = require('./config');
const { fetchWithTimeout, getNextApiKey } = require('../illustrationGenerator');
const { extractGeminiResponseText } = require('./quality/geminiJson');

const REWRITE_HTTP_ATTEMPTS = 2;

/**
 * Ask a small LLM to rewrite a scene description so it preserves the visual
 * content but removes phrasing that an automated image-safety classifier is
 * likely to flag.
 *
 * @param {object} opts
 * @param {string} opts.scenePrompt - The raw scene description that safety-blocked.
 * @param {string} [opts.spreadText] - The story text for this spread (for context only; not rewritten).
 * @param {string} [opts.theme] - Book theme (for context; e.g. 'overcoming_fears').
 * @param {object} [opts.costTracker]
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<{rewrote: boolean, scenePrompt: string, reason?: string}>}
 *   `rewrote=false` with original scenePrompt and a `reason` on any failure.
 */
async function rewriteSceneForSafety(opts = {}) {
  const { scenePrompt, spreadText, theme, costTracker, abortSignal } = opts;
  const original = typeof scenePrompt === 'string' ? scenePrompt : '';

  if (!original.trim()) {
    return { rewrote: false, scenePrompt: original, reason: 'empty_input' };
  }

  const apiKey = getNextApiKey();
  if (!apiKey) {
    return { rewrote: false, scenePrompt: original, reason: 'no_api_key' };
  }

  const url = `${CHAT_API_BASE}/${GEMINI_QA_MODEL}:generateContent?key=${apiKey}`;

  const themeLine = theme ? `\n- Book theme: ${String(theme).slice(0, 80)}` : '';
  const textLine = spreadText
    ? `\n- Story text that will appear on this spread (do not rewrite, shown only for context):\n"""${String(spreadText).slice(0, 400)}"""`
    : '';

  const instruction = `You are a safety rewriter for a children's picture-book illustration pipeline.

An automated image-safety classifier refused to generate an illustration from the SCENE DESCRIPTION below. The classifier returned "blockReason=OTHER" which means it found the phrasing unsafe without telling us why. Common triggers in children's books:
- Medical/injury language (bleeding, wounds, hospital, shots, pain).
- Violence or threat (fighting, chasing, attacking, weapons, predators catching prey).
- Distress intensifiers (screaming, sobbing, terrified, panicking, alone in the dark crying).
- Death, drowning, falling, suffocating, being trapped.
- Religious/spiritual imagery (angels, God, heaven, prayer) when shown as real.
- Real people by name, branded characters, trademarked settings.
- Nudity-adjacent situations (bath, bedroom, undressing, underwear).
- Graphic emotional states ("face contorted in terror", "tears streaming down his bloody face").

Your job: rewrite the SCENE so it describes the SAME visual moment in gentler, concrete, observable language a picture-book illustrator would use. Preserve:
- Who is in the scene and where they are.
- What each character is doing (the physical action).
- Key objects, lighting, camera angle, and composition.
- Emotional tone, expressed through body language and setting rather than charged adjectives.
- Any continuity markers (specific outfits, colors, props).

Do NOT:
- Change the location, characters, or core action.
- Add new characters or remove ones that are needed for story continuity.
- Moralize or insert safety disclaimers.
- Shorten the description — keep roughly the same length and level of detail.
- Reply with anything other than the rewritten scene.

Context:${themeLine}${textLine}

SCENE TO REWRITE:
"""
${original}
"""

Return ONLY the rewritten scene as plain text. No preamble, no quotes, no explanation.`;

  let lastErr = 'unknown_error';

  for (let attempt = 0; attempt < REWRITE_HTTP_ATTEMPTS; attempt++) {
    if (abortSignal?.aborted) {
      return { rewrote: false, scenePrompt: original, reason: 'aborted' };
    }

    try {
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: instruction }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2048,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }, QA_TIMEOUT_MS, abortSignal);

      if (costTracker) {
        // Rough token estimate: instruction + scene ≈ 700 in, ≈ 400 out.
        costTracker.addTextUsage(GEMINI_QA_MODEL, 700, 400);
      }

      if (!resp.ok) {
        lastErr = `http_${resp.status}`;
        // 400 from the rewriter itself (our instruction flagged) is terminal — bail immediately.
        if (resp.status === 400) break;
        continue;
      }

      const data = await resp.json().catch(() => null);
      const text = data ? extractGeminiResponseText(data) : '';
      const cleaned = _stripRewriterPreamble(text);

      if (!cleaned || cleaned.length < 20) {
        lastErr = 'empty_or_too_short';
        continue;
      }

      // Guardrail: the rewrite must not balloon or collapse the scene. If the
      // model ignored the "keep roughly the same length" instruction, distrust
      // the output rather than send something unrecognizable.
      const ratio = cleaned.length / original.length;
      if (ratio < 0.35 || ratio > 2.2) {
        lastErr = `length_ratio_${ratio.toFixed(2)}`;
        continue;
      }

      return { rewrote: true, scenePrompt: cleaned };
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }

  return { rewrote: false, scenePrompt: original, reason: lastErr };
}

/**
 * Strip common LLM preambles like "Here is the rewritten scene:" or wrapping
 * triple-quotes. The rewriter prompt explicitly forbids these but smaller
 * models occasionally slip them in anyway.
 *
 * @param {string} text
 * @returns {string}
 */
function _stripRewriterPreamble(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text.trim();

  // Drop leading lines that are obvious preamble.
  out = out.replace(/^(here(?:'s| is)[^\n]*\n+)/i, '');
  out = out.replace(/^(rewritten\s+scene[:\s-]*\n+)/i, '');

  // Strip surrounding triple-quote or triple-backtick fences.
  out = out.replace(/^[`"']{3,}[^\n]*\n?/, '');
  out = out.replace(/[`"']{3,}\s*$/, '');

  // Strip surrounding single quote pairs on a single-line response.
  if (/^".*"$/s.test(out) || /^'.*'$/s.test(out)) {
    out = out.slice(1, -1);
  }

  return out.trim();
}

module.exports = {
  rewriteSceneForSafety,
};
