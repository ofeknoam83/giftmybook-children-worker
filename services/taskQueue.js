/**
 * Cloud Tasks integration for parallel spread generation
 */

const { CloudTasksClient } = require('@google-cloud/tasks');

const client = new CloudTasksClient();
const PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0521120270';
const LOCATION = process.env.GCP_LOCATION || 'europe-west1';
const QUEUE = process.env.TASK_QUEUE || 'children-book-generation';

function getQueuePath() {
  return client.queuePath(PROJECT, LOCATION, QUEUE);
}

/**
 * Enqueue a spread generation job.
 * @param {string} bookId
 * @param {object} spreadPlan - { spreadNumber, text, illustrationDescription, layoutType, mood }
 * @param {object} characterRef - { refUrl, faceEmbeddingUrl, artStyle }
 * @param {string} workerUrl - Children worker base URL
 * @param {object} apiKeys
 */
async function enqueueSpreadJob(bookId, spreadPlan, characterRef, workerUrl, apiKeys = {}) {
  const payload = {
    bookId,
    spreadPlan,
    characterRef,
    apiKeys,
  };

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${workerUrl}/generate-spread`,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
    scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 2 },
  };

  if (process.env.WORKER_SA_EMAIL) {
    task.httpRequest.oidcToken = {
      serviceAccountEmail: process.env.WORKER_SA_EMAIL,
      audience: workerUrl,
    };
  }

  const [response] = await client.createTask({
    parent: getQueuePath(),
    task,
  });

  console.log(`[TaskQueue] Enqueued spread ${spreadPlan.spreadNumber} for book ${bookId}: ${response.name}`);
  return response.name;
}

/**
 * Enqueue a finalize job (after all spreads are generated).
 * @param {string} bookId
 * @param {string} workerUrl
 * @param {object} opts - { callbackUrl, apiKeys }
 */
async function enqueueFinalizeJob(bookId, workerUrl, opts = {}) {
  const payload = {
    bookId,
    callbackUrl: opts.callbackUrl,
    apiKeys: opts.apiKeys || {},
  };

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: `${workerUrl}/finalize-book`,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
    },
    scheduleTime: { seconds: Math.floor(Date.now() / 1000) + 5 },
  };

  if (process.env.WORKER_SA_EMAIL) {
    task.httpRequest.oidcToken = {
      serviceAccountEmail: process.env.WORKER_SA_EMAIL,
      audience: workerUrl,
    };
  }

  const [response] = await client.createTask({
    parent: getQueuePath(),
    task,
  });

  console.log(`[TaskQueue] Enqueued finalize for book ${bookId}: ${response.name}`);
  return response.name;
}

module.exports = { enqueueSpreadJob, enqueueFinalizeJob };
