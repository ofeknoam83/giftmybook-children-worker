'use strict';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const ENRICHER_SYSTEM = `You are a children's media expert assistant.
Your job is to identify pop culture references in text and add short clarifying annotations
so a story-writing AI understands exactly what is being referenced.

Rules:
- Annotate proper nouns, character names, brand names, show titles, and pop culture terms
  (TV shows, movies, video games, book characters, toy brands, YouTubers, online games, etc.).
- Also annotate DISGUISED references: hyphenated compounds, lowercase puns, portmanteaus,
  or allusive phrases where part of the term matches a known show, character, or brand
  (e.g. "Bluey-blue" alludes to the show Bluey; "paw-patrol march" alludes to PAW Patrol).
- When a KNOWN INTERESTS list is provided, be MORE willing to annotate plausible echoes of
  those interests — even if the reference is indirect, lowercase, or embedded in a compound word.
- Insert the annotation immediately after the term, in parentheses, as a brief factual description.
  Keep each annotation to one sentence, max 20 words.
- Do NOT annotate ordinary first names (e.g. "her friend Emma"), common words, or the child's own name.
- Do NOT annotate terms that have NO plausible pop culture connection.
- Do NOT invent references — but when the known-interests list supports a match, annotate it.
- Return ONLY the annotated text. No preamble, no explanation, no JSON, no markdown.
- If there are no pop culture references, return the input text unchanged.

Examples:

Input (interests: Bluey, Minecraft):
"She loves Bluey-blue skies and building block towers all day."
Output:
"She loves Bluey-blue (allusion to Bluey, Australian children's TV show) skies and building block towers (evokes Minecraft block-building) all day."

Input (interests: Paw Patrol):
"He does a little paw-patrol march around the yard with his dog."
Output:
"He does a little paw-patrol march (allusion to PAW Patrol, children's TV show) around the yard with his dog."`;

function parseEnrichmentResponse(raw, original) {
  if (!raw || typeof raw !== 'string') return original;
  let cleaned = raw.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith('\u201C') && cleaned.endsWith('\u201D'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  const origWords = original.trim().split(/\s+/).length;
  const enrichedWords = cleaned.split(/\s+/).length;
  if (enrichedWords < origWords || enrichedWords > origWords * 4) {
    console.warn('[enrichCustomDetails] Output length suspicious, falling back.');
    return original;
  }
  return cleaned;
}

async function callGeminiForEnrichment(systemPrompt, userPrompt, genConfig) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: genConfig,
  };

  const resp = await fetch(
    `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  return result.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * @param {string} customDetails - freeform text from the parent
 * @param {string} childName
 * @param {number|string} childAge
 * @param {string[]} [interests] - structured interests from the order (e.g. ["Bluey", "Minecraft"])
 */
async function enrichCustomDetails(customDetails, childName, childAge, interests) {
  if (!customDetails || customDetails.trim().length === 0) return customDetails || '';
  const interestsList = (interests || []).filter(Boolean);
  let userPrompt = `The child is ${childAge} years old. The child's name is ${childName} — do not annotate their name.`;
  if (interestsList.length) {
    userPrompt += `\n\nKNOWN INTERESTS (annotate any allusions to these, even indirect or disguised): ${interestsList.join(', ')}`;
  }
  userPrompt += `\n\nAnnotate any pop culture references in the following text:\n\n"${customDetails}"`;
  try {
    const raw = await callGeminiForEnrichment(ENRICHER_SYSTEM, userPrompt, { maxOutputTokens: 512, temperature: 0.1 });
    const enriched = parseEnrichmentResponse(raw, customDetails);
    if (enriched !== customDetails) console.log('[enrichCustomDetails]', { original: customDetails, enriched });
    return enriched;
  } catch (err) {
    console.warn('[enrichCustomDetails] Failed, using original:', err?.message);
    return customDetails;
  }
}

const STORY_REF_SYSTEM = `You are a children's media expert. You will receive a children's story manuscript
and a list of the child's known interests. Your job is to add inline reference annotations
so a downstream illustration AI knows when the story text is alluding to a real show, character, or brand.

Rules:
- Scan every spread for allusions to the KNOWN INTERESTS: puns, compound words, color references,
  character-name echoes, or thematic nods (e.g. "Bluey-blue breeze" → Bluey; "block kingdom" → Minecraft).
- Insert a short parenthetical annotation immediately after the allusive phrase.
  Keep each annotation to one sentence, max 15 words. Format: (allusion to X, brief description)
- Do NOT change any story wording — only insert parenthetical annotations.
- Do NOT annotate the child's own name or ordinary words with no pop culture connection.
- Preserve ALL formatting: spread headers, Left/Right markers, line breaks, and punctuation.
- Return the FULL manuscript text with annotations inserted. No preamble, no explanation.
- If no references are found, return the manuscript unchanged.`;

/**
 * Annotate generated story text with pop-culture reference hints before structuring.
 * Returns the manuscript with inline parenthetical annotations for allusive phrases.
 *
 * @param {string} storyText - raw manuscript from Phase 1
 * @param {string} childName
 * @param {string[]} interests - structured interests from the order
 * @returns {Promise<string>} annotated manuscript (or original on failure)
 */
async function enrichStoryReferences(storyText, childName, interests) {
  const interestsList = (interests || []).filter(Boolean);
  if (!storyText || !interestsList.length) return storyText || '';

  const userPrompt = `Child's name (do NOT annotate): ${childName}
KNOWN INTERESTS: ${interestsList.join(', ')}

Manuscript:
${storyText}`;

  try {
    const raw = await callGeminiForEnrichment(STORY_REF_SYSTEM, userPrompt, { maxOutputTokens: 4096, temperature: 0.1 });
    const enriched = parseEnrichmentResponse(raw, storyText);
    if (enriched !== storyText) console.log('[enrichStoryReferences] Annotated story text with reference hints');
    return enriched;
  } catch (err) {
    console.warn('[enrichStoryReferences] Failed, using original:', err?.message);
    return storyText;
  }
}

module.exports = { enrichCustomDetails, enrichStoryReferences };
