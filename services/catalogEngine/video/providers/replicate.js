/**
 * Replicate adapter (gift video, gv-1 — the DEFAULT host; docs/GIFT_VIDEO_PLAN.md
 * §4.4, open decision 1): the account the app already holds.
 *
 * Contract (shared by every adapter):
 *   submit(job) → {jobId}
 *   poll(jobId) → {status: 'queued'|'running'|'done'|'failed'|'filtered', videoUrl?, error?, reasons?}
 *   download(url) → Buffer
 *
 * Transport is plain `fetch` on the predictions API: `POST /v1/models/
 * {owner}/{name}/predictions` returns the prediction with its `urls.get`
 * poll URL; `GET` it until `succeeded` / `failed` / `canceled`. A vendor
 * moderation refusal comes back as a FAILED prediction whose error names
 * the filter — it is classified `filtered` (never retried as a transient
 * error). The token is `REPLICATE_API_TOKEN` on the revision, or the copy
 * the app injects into the request body (job.token).
 */

const API = 'https://api.replicate.com/v1';
const FILTER_RE = /moderat|nsfw|safety|sensitive|prohibit|policy|flagged|inappropriate|violat/i;

/**
 * The API token: the revision's env, else the request-injected copy.
 * @param {{token?: string|null}} [job]
 * @returns {string}
 */
function tokenFor(job) {
  const t = process.env.REPLICATE_API_TOKEN || (job && job.token) || '';
  if (!t) {
    const e = new Error('REPLICATE_API_TOKEN is not configured on the worker (and no token rode the request)');
    e.failureCode = 'video_provider_unavailable';
    throw e;
  }
  return t;
}

async function fetchJson(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: resp.ok, status: resp.status, data, text };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Replicate API timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit one clip job.
 * @param {{model: string, input: object, token?: string|null}} job
 * @returns {Promise<{jobId: string, pollUrl: string}>}
 */
async function submit(job) {
  const [owner, name] = String(job.model).split('/');
  if (!owner || !name) throw new Error(`invalid Replicate model id '${job.model}'`);
  const r = await fetchJson(`${API}/models/${owner}/${name}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenFor(job)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: job.input }),
  }, 60000);
  if (!r.ok || !r.data || !r.data.id) {
    const detail = (r.data && (r.data.detail || r.data.error)) || r.text.slice(0, 300);
    const e = new Error(`Replicate refused the prediction (HTTP ${r.status}): ${detail}`);
    // 422 = the input schema rejected our fields — a configuration problem,
    // not a transient one; the admin fixes it with CATALOG_VIDEO_MODEL_INPUT_JSON.
    e.failureCode = r.status === 422 ? 'video_provider_input_rejected' : (r.status === 401 || r.status === 402 || r.status === 403 ? 'video_provider_unavailable' : 'video_provider_error');
    e.statusCode = r.status;
    throw e;
  }
  return { jobId: r.data.id, pollUrl: (r.data.urls && r.data.urls.get) || `${API}/predictions/${r.data.id}` };
}

/**
 * Poll one job.
 * @param {{jobId: string, pollUrl?: string, token?: string|null}} ref
 * @returns {Promise<{status: string, videoUrl: string|null, error: string|null, reasons: string[]|null}>}
 */
async function poll(ref) {
  const r = await fetchJson(ref.pollUrl || `${API}/predictions/${ref.jobId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenFor(ref)}` },
  }, 30000);
  if (!r.ok || !r.data) {
    throw new Error(`Replicate poll failed (HTTP ${r.status}): ${(r.data && (r.data.detail || r.data.error)) || r.text.slice(0, 200)}`);
  }
  const d = r.data;
  if (d.status === 'succeeded') {
    const out = Array.isArray(d.output) ? d.output.find(x => typeof x === 'string') : (typeof d.output === 'string' ? d.output : (d.output && typeof d.output === 'object' && typeof d.output.url === 'string' ? d.output.url : null));
    if (!out) return { status: 'failed', videoUrl: null, error: 'prediction succeeded without a video output', reasons: null };
    return { status: 'done', videoUrl: out, error: null, reasons: null };
  }
  if (d.status === 'failed' || d.status === 'canceled') {
    const msg = typeof d.error === 'string' ? d.error : (d.error ? JSON.stringify(d.error) : `prediction ${d.status}`);
    return FILTER_RE.test(msg)
      ? { status: 'filtered', videoUrl: null, error: msg.slice(0, 300), reasons: [msg.slice(0, 200)] }
      : { status: 'failed', videoUrl: null, error: msg.slice(0, 300), reasons: null };
  }
  return { status: d.status === 'starting' ? 'queued' : 'running', videoUrl: null, error: null, reasons: null };
}

/**
 * Download the finished clip.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`clip download failed: HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { name: 'replicate', submit, poll, download, tokenFor, FILTER_RE };
