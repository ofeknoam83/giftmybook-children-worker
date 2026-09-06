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
  const valid = a === b;
  return { valid, issues: valid ? [] : [b ? 'Painted words differ from the approved manuscript (spelling, order, omission or repetition).' : 'No readable manuscript was transcribed.'] };
}

// A mismatch gets ONE independent blind re-read before buying any artwork.
// An outage or conflicting readings remain unverified, never silently clean.
async function verifyManuscript(expected, readText) {
  const base = { version: TEXT_VERIFICATION_VERSION, manuscriptHash: manuscriptHash(expected) };
  let previousMismatch = null;
  let reason = 'Text could not be verified.';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const extractedText = await readText(attempt);
      if (typeof extractedText !== 'string') throw new Error('No usable text transcription returned.');
      const comparison = compareManuscript(expected, extractedText);
      if (comparison.valid) return { ...base, status: 'verified', valid: true, issues: [], attempts: attempt };
      const letters = normalizeManuscript(extractedText);
      if (previousMismatch === letters) return { ...base, status: 'mismatch', valid: false, issues: comparison.issues, attempts: attempt };
      previousMismatch = letters;
      reason = 'Text readings disagree; spelling needs another check.';
    } catch (err) { reason = err.message || 'Text verification unavailable.'; }
  }
  return { ...base, status: 'unverified', valid: false, issues: [reason], attempts: 2 };
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
