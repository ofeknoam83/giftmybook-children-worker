'use strict';

const { downloadBuffer, uploadBuffer, getSignedUrl } = require('../../gcsStorage');
const { QA_VERSION } = require('../versions');
const { fnv1a } = require('../selection');

const manifestPath = bookId => `children-jobs/${bookId}/reviewed-art.json`;
const isMissing = err => Number(err?.code) === 404;

// The manifest records where the actual renders landed, including runs that
// stopped for candidate review. Recomputing keys during PDF assembly can
// change them when typography, tuning, or renderer defaults have changed.
async function readManifest(bookId, context, spreads, aspect) {
  let raw;
  try { raw = await downloadBuffer(manifestPath(bookId)); }
  catch (err) { if (isMissing(err)) return null; throw err; }
  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.version !== 1 || JSON.stringify(manifest.context) !== JSON.stringify(context)) {
    throw new Error('Saved artwork belongs to a different story, layout, or identity reference');
  }
  const prefix = `children-jobs/${bookId}/ce-renders/`;
  for (const spread of spreads) {
    const key = manifest.renderKeys?.[spread];
    const tail = typeof key === 'string' && key.startsWith(prefix) ? key.slice(prefix.length) : '';
    if (!tail || tail.split('/').length !== 3 || tail.split('/').some(p => !p || p === '..' || p === '.')
      || !tail.endsWith(`/spread-${spread}.${aspect}.png`)) {
      throw new Error(`Saved artwork path is invalid for spread ${spread}`);
    }
  }
  return manifest;
}

async function saveManifest(bookId, context, results, metadata) {
  await uploadBuffer(Buffer.from(JSON.stringify({
    version: 1, context,
    renderKeys: Object.fromEntries(results.map(r => [r.spread, r.storageKey])),
    ...metadata,
  })), manifestPath(bookId), 'application/json');
}

async function readReviewedRender(spread, storageKey, legacyUnanchoredKey, log) {
  let buffer;
  try { buffer = await downloadBuffer(storageKey); }
  catch (err) {
    if (!legacyUnanchoredKey || !isMissing(err)) throw err;
    buffer = await downloadBuffer(legacyUnanchoredKey);
    storageKey = legacyUnanchoredKey;
    log('info', `Spread ${spread}: recovered original reviewed artwork before typography was pinned`);
  }
  const marker = JSON.parse((await downloadBuffer(`${storageKey}.qa.json`)).toString('utf8'));
  if (marker.renderHash !== fnv1a(buffer.toString('base64')).toString(36)) throw new Error('marker does not match the saved artwork');
  if (marker.qaVersion !== QA_VERSION) throw new Error(`marker predates ${QA_VERSION}`);
  if (marker.unresolved) throw new Error('saved artwork still has unresolved blocking defects');
  log('info', `Spread ${spread}: replaying reviewed artwork (${buffer.length} bytes)`);
  return {
    spread, buffer, storageKey, url: await getSignedUrl(storageKey, 30 * 24 * 60 * 60 * 1000),
    advisories: Array.isArray(marker.advisories) ? marker.advisories : [],
    fresh: false, bathWater: false, blocking: [], candidates: [], candidateFiles: [],
    qa: marker.qa || null, bbox: marker.qa?.bbox || null,
    propBoxes: Array.isArray(marker.qa?.propBoxes) ? marker.qa.propBoxes : [],
  };
}

module.exports = { readManifest, saveManifest, readReviewedRender };
