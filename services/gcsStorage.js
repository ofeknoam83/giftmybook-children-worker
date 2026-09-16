/**
 * GCS Storage helpers — upload, download, signed URLs
 */

const { Storage } = require('@google-cloud/storage');

const storage = new Storage();
const bucketName = process.env.GCS_BUCKET_NAME || 'giftmybook-bucket';

function getBucket() {
  return storage.bucket(bucketName);
}

/**
 * Upload a buffer to GCS.
 * @param {Buffer} buffer
 * @param {string} destination - GCS object path (e.g. "children-jobs/abc/ref.png")
 * @param {string} contentType
 * @returns {Promise<string>} Public or signed URL
 */
async function uploadBuffer(buffer, destination, contentType = 'application/octet-stream') {
  const file = getBucket().file(destination);
  await file.save(buffer, { contentType, resumable: false });
  const [signedUrl] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });
  return signedUrl;
}

/**
 * Create a GCS object ONLY if it does not exist yet (ifGenerationMatch: 0),
 * so concurrent instances racing to create the same deterministic object
 * cannot overwrite each other — exactly one write wins.
 * @param {Buffer} buffer
 * @param {string} destination - GCS object path
 * @param {string} contentType
 * @returns {Promise<{created: boolean}>} created=false when the object
 *   already existed (this write lost the race) — the caller should adopt
 *   the winning object's bytes instead of its own.
 */
async function uploadBufferIfAbsent(buffer, destination, contentType = 'application/octet-stream') {
  const file = getBucket().file(destination);
  try {
    await file.save(buffer, { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
    return { created: true };
  } catch (err) {
    if (err.code === 412) return { created: false }; // precondition failed: object exists
    throw err;
  }
}

/**
 * Download a URL and upload it to GCS.
 * @param {string} url - Source URL
 * @param {string} destination - GCS path
 * @returns {Promise<string>} GCS URI
 */
async function uploadFromUrl(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  return uploadBuffer(buffer, destination, contentType);
}

/**
 * The GCS object an HTTPS URL names, in either of the two URL styles the
 * app and the worker exchange — path-style
 * `https://storage.googleapis.com/<bucket>/<object>[?…]` and virtual-hosted
 * `https://<bucket>.storage.googleapis.com/<object>[?…]`. The query string
 * (a signature, expired or not) is ignored and the object path is decoded
 * once, so an encoded and a raw spelling of one object agree. Any other
 * URL (a CDN, a legacy host, a plain key) is null.
 * @param {string} url
 * @returns {{bucket: string, objectPath: string}|null}
 */
function parseGcsObjectUrl(url) {
  if (typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const decode = (raw) => { try { return decodeURIComponent(raw); } catch { return raw; } };
  const host = parsed.hostname.toLowerCase();
  if (host === 'storage.googleapis.com') {
    // Path format: /bucket-name/path/to/file
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const bucket = pathParts[0];
    const objectPath = decode(pathParts.slice(1).join('/'));
    return bucket && objectPath ? { bucket, objectPath } : null;
  }
  const vhost = /^([a-z0-9.\-_]+)\.storage\.googleapis\.com$/i.exec(host);
  if (vhost) {
    const objectPath = decode(parsed.pathname.replace(/^\/+/, ''));
    return objectPath ? { bucket: vhost[1], objectPath } : null;
  }
  return null;
}

/**
 * Read one GCS object with the worker's own credentials (IAM), bytes AND
 * content type — the read that does not depend on a URL's signature. Used
 * where a caller-supplied HTTPS URL was refused: an approved cover the app
 * stores WITHOUT its signature (canonical form, 2026-09-16), or a 7-day
 * signature that expired before a retry.
 * @param {{bucket: string, objectPath: string}} ref
 * @returns {Promise<{buffer: Buffer, contentType: string|null}>}
 */
async function readGcsObject(ref) {
  const file = storage.bucket(ref.bucket).file(ref.objectPath);
  const [buffer] = await file.download();
  let contentType = null;
  try {
    const [metadata] = await file.getMetadata();
    contentType = metadata && typeof metadata.contentType === 'string' ? metadata.contentType : null;
  } catch { /* the bytes are what matters; the caller sniffs the type */ }
  return { buffer, contentType };
}

/**
 * Download a file from GCS as a buffer.
 * @param {string} source - GCS object path or gs:// URI
 * @returns {Promise<Buffer>}
 */
async function downloadBuffer(source) {
  // Prefer GCS SDK for googleapis URLs so expired/invalid signed query strings
  // (HTTP 400/403 from fetch) do not break Cloud Run jobs — IAM reads the object.
  const ref = parseGcsObjectUrl(source);
  if (ref) {
    try {
      console.log(`[gcsStorage] Downloading via SDK gs://${ref.bucket}/${ref.objectPath.slice(0, 80)}`);
      const [buffer] = await storage.bucket(ref.bucket).file(ref.objectPath).download();
      return buffer;
    } catch (sdkErr) {
      console.warn(`[gcsStorage] SDK download failed, falling back to fetch: ${sdkErr.message}`);
    }
  }
  // Fallback: public URLs or other origins via fetch
  if (source.startsWith('https://') || source.startsWith('http://')) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Failed to download ${source.slice(0, 80)}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  // Handle gs:// URIs and plain GCS paths via SDK
  const path = source.startsWith('gs://') ? source.replace(`gs://${bucketName}/`, '') : source;
  const [buffer] = await getBucket().file(path).download();
  return buffer;
}

/**
 * Get a temporary signed URL for a GCS object.
 * @param {string} source - GCS object path
 * @param {number} expiresInMs - Default 1 hour
 * @returns {Promise<string>}
 */
async function getSignedUrl(source, expiresInMs = 3600_000) {
  const path = source.startsWith('gs://') ? source.replace(`gs://${bucketName}/`, '') : source;
  const [url] = await getBucket().file(path).getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresInMs,
  });
  return url;
}

/**
 * Whether a GCS object exists (no download).
 * @param {string} source - GCS object path or gs:// URI
 * @returns {Promise<boolean>}
 */
async function objectExists(source) {
  const path = source.startsWith('gs://') ? source.replace(`gs://${bucketName}/`, '') : source;
  const [exists] = await getBucket().file(path).exists();
  return !!exists;
}

/**
 * Delete all objects under a prefix.
 * @param {string} prefix
 */
async function deletePrefix(prefix) {
  await getBucket().deleteFiles({ prefix, force: true });
}

/**
 * Save JSON data to GCS.
 * @param {object} data
 * @param {string} destination
 * @returns {Promise<string>}
 */
async function saveJson(data, destination) {
  return uploadBuffer(Buffer.from(JSON.stringify(data, null, 2)), destination, 'application/json');
}

/**
 * Load JSON data from GCS.
 * @param {string} source
 * @returns {Promise<object>}
 */
async function loadJson(source) {
  const buffer = await downloadBuffer(source);
  return JSON.parse(buffer.toString('utf-8'));
}

module.exports = {
  uploadBuffer,
  uploadBufferIfAbsent,
  uploadFromUrl,
  downloadBuffer,
  parseGcsObjectUrl,
  readGcsObject,
  getSignedUrl,
  objectExists,
  deletePrefix,
  saveJson,
  loadJson,
  getBucket,
};
