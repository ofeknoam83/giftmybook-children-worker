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
  // Return a signed URL (valid 30 days) instead of gs:// URI
  try {
    const [signedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    return signedUrl;
  } catch (err) {
    console.warn(`[gcsStorage] Signed URL failed for ${destination}, using public URL:`, err.message);
    return `https://storage.googleapis.com/${bucketName}/${destination}`;
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
 * Download a file from GCS as a buffer.
 * @param {string} source - GCS object path or gs:// URI
 * @returns {Promise<Buffer>}
 */
async function downloadBuffer(source) {
  // Handle signed URLs and public URLs via fetch
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
  uploadFromUrl,
  downloadBuffer,
  getSignedUrl,
  deletePrefix,
  saveJson,
  loadJson,
  getBucket,
};
