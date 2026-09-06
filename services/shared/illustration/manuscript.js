'use strict';

const { createHash } = require('crypto');
const TEXT_VERIFICATION_VERSION = 'painted-manuscript-v1';
const TEXT_MISMATCH = 'embedded story text does not match the approved manuscript';

// Compare letters in order, including accents and non-Latin names. OCR line
// wrapping, quote style, capitalization and punctuation are not spelling.
// Never fold similar-looking letters (i/l), remove accents, or allow a
// percentage of missing words. A dictionary would reject personal names.
function normalizeManuscript(text) {
  return (String(text || '').normalize('NFC').replace(/[‘’‚‛′]/g, "'").toLowerCase().match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu) || []).join(' ');
}

function manuscriptHash(text) {
  return createHash('sha256').update(normalizeManuscript(text)).digest('hex');
}

function compareManuscript(expected, extracted) {
  const a = normalizeManuscript(expected), b = normalizeManuscript(extracted);
  if (a === b) return { valid: true, issues: [] };
  if (!b) return { valid: false, issues: ['No readable manuscript was transcribed.'] };
  const wanted = a.split(' '), seen = b.split(' ');
  let i = 0;
  while (i < wanted.length && wanted[i] === seen[i]) i++;
  const word = value => value ? `"${value.slice(0, 60)}"` : '(end of text)';
  return { valid: false, issues: [`Word ${i + 1}: expected ${word(wanted[i])}, read ${word(seen[i])}.`] };
}

// Require two agreeing readings. The reader supplies a full image followed
// by magnified glyphs; disagreement gets one tie-breaker, never more than
// three text calls. Two service failures stop without buying more artwork.
async function verifyManuscript(expected, readText) {
  const base = { version: TEXT_VERIFICATION_VERSION, manuscriptHash: manuscriptHash(expected) };
  const readings = new Map();
  let reason = 'Text could not be verified.', failures = 0, attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    attempts = attempt;
    try {
      const extractedText = await readText(attempt);
      if (typeof extractedText !== 'string') throw new Error('No usable text transcription returned.');
      const letters = normalizeManuscript(extractedText);
      readings.set(letters, (readings.get(letters) || 0) + 1);
      if (readings.get(letters) >= 2) {
        const comparison = compareManuscript(expected, extractedText);
        return { ...base, status: comparison.valid ? 'verified' : 'mismatch', ...comparison, attempts };
      }
      reason = 'Text readings disagree; spelling needs another check.';
    } catch (err) {
      reason = err.message || 'Text verification unavailable.';
      if (++failures >= 2) break;
    }
  }
  return { ...base, status: 'unverified', valid: false, issues: [reason], attempts };
}

function textVerificationCurrent(verification, expected) {
  return verification?.version === TEXT_VERIFICATION_VERSION
    && verification.manuscriptHash === manuscriptHash(expected)
    && verification.status === 'verified';
}

function applyTextVerification(qa, verification) {
  // The old general-purpose judge sees the manuscript; the independent
  // blind transcription is authoritative for word accuracy, not geometry.
  const isOldTextFinding = d => d === TEXT_MISMATCH || d === 'embedded story text missing from the image' || d.startsWith('embedded story text garbled:');
  const defects = (qa.defects || []).filter(d => !isOldTextFinding(d));
  const blocking = (qa.blocking || []).filter(d => !isOldTextFinding(d));
  const advisory = (qa.advisory || []).filter(d => !isOldTextFinding(d));
  if (verification.status === 'mismatch') { defects.push(TEXT_MISMATCH); blocking.push(TEXT_MISMATCH); }
  if (verification.status === 'unverified') advisory.push('Story spelling could not be verified; saved artwork needs a text check.');
  return { ...qa, defects, blocking, advisory, pass: defects.length === 0 && verification.status === 'verified', textVerification: verification };
}

module.exports = { TEXT_VERIFICATION_VERSION, TEXT_MISMATCH, normalizeManuscript, manuscriptHash, compareManuscript, verifyManuscript, textVerificationCurrent, applyTextVerification };
