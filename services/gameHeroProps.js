/**
 * Hero-prop 3D asset pipeline.
 *
 * Generates book-specific 3D props (the 1-3 named "hero" items from the
 * story — e.g. a magic hat, a specific toy) via Meshy.ai's text-to-3D API.
 * Uploads the returned glTF + thumbnail to GCS and persists a compact
 * manifest the 3D game client can load on boot.
 *
 * Meshy API reference: https://docs.meshy.ai/api/text-to-3d
 *
 * Env:
 *   - MESHY_API_KEY : bearer token for the Meshy REST API. When unset the
 *     function returns a "skipped" stub manifest with a known fallback item
 *     id, so the rest of the prewarm pipeline stays green.
 *
 * Output shape (one entry per hero prop):
 *   { id, itemId?, roomId?, name, glbUrl, thumbUrl, interaction?: { pose, holdMs, ... } }
 */

const { fetchWithTimeout } = require('./illustrationGenerator');
const { uploadBuffer } = require('./gcsStorage');

const MESHY_BASE = 'https://api.meshy.ai/openapi/v2';
const TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 6000;
const MAX_POLLS = 40;

function meshyKey() {
  return process.env.MESHY_API_KEY || '';
}

async function createMeshyTask({ apiKey, prompt, style }) {
  const resp = await fetchWithTimeout(`${MESHY_BASE}/text-to-3d`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      mode: 'preview',
      prompt,
      art_style: style || 'cartoon',
      negative_prompt: 'ugly, low quality, watermark',
      topology: 'quad',
      target_polycount: 8000,
    }),
  }, 30000);
  if (!resp.ok) throw new Error(`Meshy create ${resp.status}: ${await resp.text().catch(() => '')}`);
  const data = await resp.json();
  return data.result || data.id || null;
}

async function pollMeshyTask({ apiKey, taskId }) {
  for (let i = 0; i < MAX_POLLS; i++) {
    const resp = await fetchWithTimeout(`${MESHY_BASE}/text-to-3d/${taskId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 20000);
    if (!resp.ok) throw new Error(`Meshy poll ${resp.status}`);
    const data = await resp.json();
    if (data.status === 'SUCCEEDED') return data;
    if (data.status === 'FAILED') throw new Error(`Meshy task failed: ${data.task_error || 'unknown'}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Meshy task timed out');
}

async function downloadToBuffer(url, timeout = 60000) {
  const resp = await fetchWithTimeout(url, { method: 'GET' }, timeout);
  if (!resp.ok) throw new Error(`Download ${url} ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Generate a single hero prop and upload it to GCS.
 *
 * Input:  { bookId, prop: { id, name, prompt, itemId?, roomId?, interaction? } }
 * Output: { id, itemId?, roomId?, name, glbUrl, thumbUrl, interaction? }
 */
async function generateHeroProp({ bookId, prop }) {
  if (!bookId) throw new Error('bookId required');
  if (!prop || !prop.id || !prop.prompt) throw new Error('prop { id, prompt } required');
  const apiKey = meshyKey();
  const slug = prop.id.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();

  if (!apiKey) {
    console.warn(`[heroProps] MESHY_API_KEY not set — skipping 3D generation for ${prop.id}`);
    return {
      id: prop.id,
      itemId: prop.itemId || null,
      roomId: prop.roomId || null,
      name: prop.name || prop.id,
      glbUrl: null,
      thumbUrl: null,
      interaction: prop.interaction || null,
      skipped: true,
    };
  }

  const taskId = await createMeshyTask({
    apiKey,
    prompt: prop.prompt,
    style: prop.style || 'cartoon',
  });
  if (!taskId) throw new Error('Meshy did not return a task id');
  const task = await pollMeshyTask({ apiKey, taskId });

  const glbSrc = task.model_urls?.glb || task.model_urls?.gltf || task.model_url;
  const thumbSrc = task.thumbnail_url || null;
  if (!glbSrc) throw new Error('No glTF URL in Meshy response');

  const glbBuf = await downloadToBuffer(glbSrc);
  const glbUrl = await uploadBuffer(
    glbBuf,
    `game-hero-props/${bookId}/${slug}.glb`,
    'model/gltf-binary'
  );

  let thumbUrl = null;
  if (thumbSrc) {
    try {
      const thumbBuf = await downloadToBuffer(thumbSrc, 30000);
      thumbUrl = await uploadBuffer(
        thumbBuf,
        `game-hero-props/${bookId}/${slug}.png`,
        'image/png'
      );
    } catch (e) {
      console.warn(`[heroProps] thumbnail upload failed: ${e.message}`);
    }
  }

  return {
    id: prop.id,
    itemId: prop.itemId || null,
    roomId: prop.roomId || null,
    name: prop.name || prop.id,
    glbUrl,
    thumbUrl,
    interaction: prop.interaction || null,
  };
}

/**
 * Generate a list of hero props in series (Meshy rate limits parallel calls
 * hard). Returns `{ props: [...], partialFailures: [...] }`.
 */
async function generateHeroProps({ bookId, props }) {
  if (!Array.isArray(props) || props.length === 0) {
    return { props: [], partialFailures: [] };
  }
  const generated = [];
  const partialFailures = [];
  for (const p of props) {
    try {
      const out = await generateHeroProp({ bookId, prop: p });
      generated.push(out);
    } catch (e) {
      console.warn(`[heroProps] ${p.id} failed: ${e.message}`);
      partialFailures.push({ id: p.id, error: e.message });
    }
  }
  return { props: generated, partialFailures };
}

module.exports = { generateHeroProp, generateHeroProps };
