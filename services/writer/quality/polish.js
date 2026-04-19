/**
 * Post-generation text polish for read-aloud quality.
 *
 * Runs after the quality gate passes (or after all revision attempts).
 * Sends the final story through one focused LLM call that rewrites the text
 * to be more natural, rhythmic, and delightful to read aloud.
 *
 * Falls back to the original story if the LLM call or parsing fails.
 */

const { BaseThemeWriter } = require('../themes/base');
const { checkAndFixPronouns } = require('./pronoun');

const _llmCaller = new BaseThemeWriter('_polish');

const POLISH_SYSTEM_PROMPT = `You are a world-class children's picture book editor. Your ONLY job is to polish the story text so it is natural, rhythmic, and delightful to read aloud by a parent.

Follow these rules strictly:

1. RHYTHM & READ-ALOUD FLOW
   - Each spread must have consistent rhythm: similar syllable count and cadence across lines.
   - Lines should sound smooth when read aloud by a parent. No stumble-points.
   - Avoid abrupt or uneven sentence lengths within the same spread.

2. SIMPLE, CHILD-FRIENDLY LANGUAGE
   - Replace complex, abstract, or uncommon words with simple, familiar ones.
   - Prefer words a 2-4 year old would recognize or enjoy hearing.
   - Avoid poetic phrasing that sacrifices clarity.

3. NATURAL RHYMES ONLY
   - Keep rhymes, but rewrite any forced or awkward rhyme.
   - If a rhyme makes a sentence unnatural, prioritize clarity over rhyme.
   - Maintain consistent rhyme patterns within each spread.

4. CLARITY OVER CLEVERNESS
   - Rewrite any line that is vague, confusing, or hard to visualize.
   - Every sentence must describe something a child can see, hear, or feel.

5. CONSISTENCY IN STYLE
   - Maintain a consistent tone and structure across all spreads.
   - No sudden shifts in writing style (e.g., switching from full sentences to fragments).

6. REPETITION (CONTROLLED)
   - Preserve the refrain and key emotional repetition.
   - Repetition should feel intentional and meaningful, not excessive.
   - Do not overuse any word or phrase beyond the refrain.

7. STRONG IMAGERY & ACTION
   - Prefer concrete actions and sensory details (touch, sound, movement).
   - Each spread should include something a child can see, hear, or feel.

8. REMOVE AWKWARD PHRASES
   - Fix or replace phrases that feel unnatural, unclear, or overly "written."
   - No strange metaphors, unclear meanings, or adult-like expressions.

9. MAINTAIN STORY FLOW
   - The book must feel like a gentle progression, not disconnected scenes.
   - Strengthen the emotional arc: connection -> play -> warm ending.
   - Each spread should lead naturally into the next.

10. OUTPUT FORMAT
    - Return the FULL revised text.
    - Keep the exact same structure: ---SPREAD N--- followed by text.
    - Do NOT explain changes. Do NOT add commentary. Only return the story text.
    - Keep the same number of spreads.

CONSTRAINTS:
- Do NOT change the child's name, the parent's name, or any personal details.
- Do NOT remove or change the refrain — only improve how it sits in context.
- Do NOT add new spreads or remove existing ones.
- Do NOT use dashes, hyphens, or em dashes in the text.
- The final result should sound like a professional, bestselling children's book.`;

/**
 * Polish a story's text for read-aloud quality.
 * @param {object} story - { spreads: [{ spread, text }], _model, _ageTier }
 * @param {object} child - { name, age, gender, ... }
 * @param {object} book - { theme, ... }
 * @returns {object} polished story (same shape), or original on failure
 */
async function polishText(story, child, book) {
  const spreads = story.spreads || [];
  if (spreads.length === 0) return story;

  const storyText = spreads
    .map(s => `---SPREAD ${s.spread}---\n${s.text}`)
    .join('\n\n');

  const userPrompt = `Polish this ${book.theme.replace(/_/g, ' ')} picture book for ${child.name} (age ${child.age}).

${storyText}`;

  try {
    console.log(`[writerV2] Polishing text for read-aloud quality (${spreads.length} spreads)...`);
    const result = await _llmCaller.callLLM('reviser', POLISH_SYSTEM_PROMPT, userPrompt, {
      maxTokens: 4000,
      temperature: 0.4,
    });

    const polishedSpreads = parseSpreads(result.text);

    if (polishedSpreads.length < spreads.length * 0.7) {
      console.warn(`[writerV2] Polish produced only ${polishedSpreads.length} spreads (expected ~${spreads.length}), keeping original`);
      return story;
    }

    checkAndFixPronouns(polishedSpreads, child.gender);

    for (const s of polishedSpreads) {
      if (s.text) {
        s.text = s.text
          .replace(/\s*[\u2014\u2013]\s*/g, ', ')
          .replace(/(?<=[a-zA-Z])\s*-\s*(?=[a-zA-Z])/g, ', ');
      }
    }

    console.log(`[writerV2] Polish complete: ${polishedSpreads.length} spreads, model ${result.model}`);
    return { ...story, spreads: polishedSpreads, _polished: true, _polishModel: result.model };
  } catch (err) {
    console.warn(`[writerV2] Polish failed, keeping original story: ${err.message}`);
    return story;
  }
}

/**
 * Parse ---SPREAD N--- delimited text into structured spreads.
 * Mirrors BaseThemeWriter.parseSpreads but kept local to avoid circular deps.
 */
function parseSpreads(rawText) {
  const spreads = [];
  if (!rawText || !rawText.trim()) return spreads;

  const pattern = /---\s*SPREAD\s+(\d+)\s*---/gi;
  const parts = rawText.split(pattern);

  for (let i = 1; i < parts.length; i += 2) {
    const spreadNum = parseInt(parts[i], 10);
    const text = (parts[i + 1] || '').trim();
    if (text) {
      spreads.push({ spread: spreadNum, text });
    }
  }

  if (spreads.length === 0) {
    const fallbackPattern = /(?:^|\n)\s*(?:Spread\s+)?(\d+)[:.]\s*/gi;
    const fallbackParts = rawText.split(fallbackPattern);
    for (let i = 1; i < fallbackParts.length; i += 2) {
      const spreadNum = parseInt(fallbackParts[i], 10);
      const text = (fallbackParts[i + 1] || '').trim();
      if (text && spreadNum >= 1 && spreadNum <= 20) {
        spreads.push({ spread: spreadNum, text });
      }
    }
  }

  return spreads;
}

module.exports = { polishText };
