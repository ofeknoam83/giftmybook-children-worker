/**
 * Illustrator — shared QA response parsing.
 *
 * All three vision-QA modules (textQa, consistencyQa, actionConsistencyQa)
 * had identical local copies of:
 *   - extractGeminiResponseText  (filter-by-thought, join parts)
 *   - parseJsonBlock             (strip ``` fences, regex-extract {...}, JSON.parse)
 *
 * Production showed consistencyQa responses being **truncated mid-JSON** when
 * the model has many `Notes` strings to fill in. The greedy `{[\s\S]*}` regex
 * then finds no closing `}` and returns null, which the caller treats as an
 * infra error — looping the entire correction pipeline.
 *
 * This module:
 *   1. Centralises the parser.
 *   2. Exposes `extractFinishReason` so callers can log *why* a response
 *      came back empty / truncated / safety-blocked.
 *   3. Adds a `repairTruncatedJson` step: if `JSON.parse` fails on a
 *      truncated payload, walk forward and close any open string and any
 *      open braces/brackets so the partial result can still be used.
 *      The Notes/issues fields the model didn't get to are simply absent —
 *      `evaluateConsistencyResult` already treats missing fields as "OK".
 */

'use strict';

/**
 * Read text out of a Gemini `generateContent` response. Filters out
 * `thought:true` parts (chain-of-thought sidecars) and returns the visible
 * model output.
 */
function extractGeminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => p && typeof p.text === 'string' && p.text.length && p.thought !== true)
    .map(p => p.text)
    .join('\n')
    .trim();
}

/**
 * Read finishReason from a Gemini response. Helpful values:
 *   STOP        - model finished naturally
 *   MAX_TOKENS  - hit output cap (truncated mid-stream)
 *   SAFETY      - blocked by safety filter
 *   RECITATION  - blocked for recitation
 *   OTHER       - unspecified
 */
function extractFinishReason(data) {
  const r = data?.candidates?.[0]?.finishReason;
  return typeof r === 'string' && r.length ? r : null;
}

/**
 * Attempt to close a truncated JSON object so it can still be parsed.
 *
 * Walks the input character-by-character tracking string-state and a stack of
 * open braces/brackets. If we run off the end mid-string or with the stack
 * still open, we append the closers needed to balance the structure. Any
 * trailing comma immediately before a closer is dropped.
 *
 * Returns the repaired string, or null if the input was clearly not a JSON
 * object start.
 */
function repairTruncatedJson(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith('{')) return null;

  const stack = []; // chars: '{' or '['
  let inString = false;
  let escaped = false;
  let lastNonWs = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); }
    else if (ch === '}') { if (stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack[stack.length - 1] === '[') stack.pop(); }
    if (!/\s/.test(ch)) lastNonWs = i;
  }

  let out = s;
  if (inString) {
    // Close the dangling string. Drop a trailing backslash that would escape
    // our closing quote.
    if (escaped) out = out.slice(0, -1);
    out += '"';
  }
  out = out.replace(/\s+$/, '');

  // Iteratively trim trailing tokens that would leave the object in a bad
  // state inside an unclosed `{` frame:
  //   - trailing comma:        `,` -> drop
  //   - trailing colon:        `:` -> drop (key without value)
  //   - orphan trailing key:   `"foo"` after `{` or `,` with no `:` after
  //                            -> drop the key (and the preceding `,` if any)
  // Repeat until none of these patterns match. Each pattern is a no-op when
  // its precondition is unmet, so this converges in at most a few passes.
  let prev = '';
  while (prev !== out) {
    prev = out;
    if (stack[stack.length - 1] !== '{') break;
    out = out.replace(/,\s*$/, '');
    out = out.replace(/:\s*$/, '');
    // Orphan trailing key: a string at the end whose preceding non-ws char
    // is `{` or `,` (i.e. it's in key position, not value position).
    out = out.replace(
      /([{,])\s*"(?:\\.|[^"\\])*"\s*$/,
      (_, prefix) => (prefix === '{' ? '{' : ''),
    );
  }

  while (stack.length) {
    const open = stack.pop();
    out += (open === '{' ? '}' : ']');
  }

  return out;
}

/**
 * Parse a Gemini text payload into a JS object. Strips ``` fences, regex-
 * extracts the `{...}` block, JSON.parses, and falls back to a best-effort
 * repair if the JSON appears truncated.
 *
 * @param {string} text
 * @returns {{ parsed: object|null, repaired: boolean, error?: Error }}
 */
function parseJsonBlock(text) {
  if (!text || typeof text !== 'string') {
    return { parsed: null, repaired: false };
  }
  const cleaned = text.replace(/```json\s*/i, '').replace(/```/g, '').trim();
  // Greedy match — anchors to last `}` if present.
  const greedy = cleaned.match(/\{[\s\S]*\}/);
  if (greedy) {
    try {
      return { parsed: JSON.parse(greedy[0]), repaired: false };
    } catch (err) {
      // fall through to repair attempt
    }
  }
  // No closing `}` (truncated), or JSON.parse failed mid-string. Try to
  // repair the partial object.
  const startIdx = cleaned.indexOf('{');
  if (startIdx < 0) return { parsed: null, repaired: false };
  const partial = cleaned.slice(startIdx);
  const repaired = repairTruncatedJson(partial);
  if (!repaired) return { parsed: null, repaired: false };
  try {
    return { parsed: JSON.parse(repaired), repaired: true };
  } catch (err) {
    return { parsed: null, repaired: false, error: err };
  }
}

module.exports = {
  extractGeminiResponseText,
  extractFinishReason,
  parseJsonBlock,
  repairTruncatedJson,
};
