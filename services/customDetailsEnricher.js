'use strict';

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const ENRICHER_SYSTEM = `You are a children's media expert assistant.
Your job is to identify pop culture references in text written by parents about their children,
and add short clarifying annotations so a story-writing AI understands exactly what is being referenced.

Rules:
- Only annotate proper nouns, character names, brand names, show titles, or capitalized terms
  that are likely pop culture references (TV shows, movies, video games, book characters,
  toy brands, YouTubers, online games, etc.).
- Insert the annotation immediately after the term, in parentheses, as a brief factual description.
  Keep each annotation to one sentence, max 20 words.
- Do NOT annotate ordinary first names (e.g. "her friend Emma"), common words, or the child's own name.
- Do NOT annotate terms you are not confident about — leave them exactly as-is.
- Do NOT invent or guess. If you are unsure, skip it.
- Return ONLY the annotated text. No preamble, no explanation, no JSON, no markdown.
- If there are no pop culture references, return the input text unchanged.`;

function parseEnrichmentResponse(raw, original) {
  if (!raw || typeof raw !== 'string') return original;
  let cleaned = raw.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith('\u201C') && cleaned.endsWith('\u201D'))) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  const origWords = original.trim().split(/\s+/).length;
  const enrichedWords = cleaned.split(/\s+/).length;
  if (enrichedWords < origWords || enrichedWords > origWords * 3) {
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

async function enrichCustomDetails(customDetails, childName, childAge) {
  if (!customDetails || customDetails.trim().length === 0) return customDetails || '';
  const userPrompt = `The child is ${childAge} years old. The child's name is ${childName} — do not annotate their name.\nAnnotate any pop culture references in the following text:\n\n"${customDetails}"`;
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

module.exports = { enrichCustomDetails };
