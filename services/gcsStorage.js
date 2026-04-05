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
  try {
    await file.save(buffer, { contentType, resumable: false, predefinedAcl: 'publicRead' });
    return `https://storage.googleapis.com/${bucketName}/${destination}`;
  } catch (err) {
    // Uniform bucket-level access blocks per-object ACLs — upload without ACL
    console.warn(`[gcsStorage] Public ACL failed for ${destination}, uploading without ACL:`, err.message);
    await file.save(buffer, { contentType, resumable: false });
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
  // Try to extract GCS path from signed URLs and use SDK (faster + more reliable from Cloud Run)
  if (source.startsWith('https://storage.googleapis.com/')) {
    try {
      const url = new URL(source);
      // Path format: /bucket-name/path/to/file
      const pathParts = url.pathname.split('/');
      const bucket = pathParts[1];
      const filePath = pathParts.slice(2).join('/');
      if (bucket === bucketName && filePath) {
        console.log(`[gcsStorage] Downloading via SDK: ${filePath.slice(0, 60)}`);
        const [buffer] = await getBucket().file(decodeURIComponent(filePath)).download();
        return buffer;
      }
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
