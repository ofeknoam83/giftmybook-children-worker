/**
 * Content-addressed in-memory artifact store with optional persistence
 * adapter. Every workflow stage's output is written here and can be
 * read back by any later stage. The store is the single source of
 * truth for "what happened in this book run".
 *
 * Why content-addressed: replays are free — a stage that gets the same
 * inputs gets the same content hash and can be skipped. Reproducibility
 * is a hard requirement (design doc principle 8: "iterate small, save
 * aggressively, fail loud").
 *
 * Persistence: today we keep artifacts in memory keyed by `bookId`
 * because the v1 worker is a single-process Node service and a book
 * runs in one process. When we move to Temporal proper, the persistence
 * adapter is swapped to GCS + Postgres without touching the call sites.
 *
 * Public contract:
 *   const store = createArtifactStore({ bookId });
 *   await store.put('stage_3_intent', intentJson, { parent: 'stage_2_age' });
 *   const intent = await store.get('stage_3_intent');
 *   const all = await store.snapshot();   // for telemetry
 *   const exists = await store.has('stage_3_intent');
 */

const crypto = require('crypto');

function hashContent(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * @param {{ bookId: string, persistence?: PersistenceAdapter }} opts
 * @returns {ArtifactStore}
 */
function createArtifactStore({ bookId, persistence } = {}) {
  if (!bookId) throw new Error('createArtifactStore: bookId is required');
  const memory = new Map();

  async function put(key, value, meta = {}) {
    if (!key) throw new Error('artifactStore.put: key is required');
    const contentHash = hashContent(value);
    const record = {
      bookId,
      key,
      contentHash,
      parent: meta.parent || null,
      createdAt: new Date().toISOString(),
      stage: meta.stage || key,
      attempt: meta.attempt || 1,
      value,
    };
    memory.set(key, record);
    if (persistence?.put) {
      try { await persistence.put(record); }
      catch (err) { console.warn(`[artifactStore] persistence.put failed for ${key}: ${err.message}`); }
    }
    return record;
  }

  async function get(key) {
    if (memory.has(key)) return memory.get(key).value;
    if (persistence?.get) {
      const rec = await persistence.get(bookId, key);
      if (rec) {
        memory.set(key, rec);
        return rec.value;
      }
    }
    return null;
  }

  async function getRecord(key) {
    if (memory.has(key)) return memory.get(key);
    if (persistence?.get) return persistence.get(bookId, key);
    return null;
  }

  async function has(key) {
    if (memory.has(key)) return true;
    if (persistence?.has) return persistence.has(bookId, key);
    return false;
  }

  async function snapshot() {
    return Array.from(memory.values()).map((rec) => ({
      key: rec.key,
      contentHash: rec.contentHash,
      parent: rec.parent,
      createdAt: rec.createdAt,
      stage: rec.stage,
      attempt: rec.attempt,
    }));
  }

  return { bookId, put, get, getRecord, has, snapshot };
}

module.exports = { createArtifactStore, hashContent };
