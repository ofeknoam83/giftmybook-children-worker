/** Deliver exactly one result, including during Cloud Run's shutdown grace period. */
function createVideoDelivery({ stable, costTracker, send }) {
  let delivered = false;
  const deliver = (payload, options) => {
    if (delivered) return Promise.resolve(false);
    delivered = true;
    return send(payload, options);
  };
  return {
    complete: payload => deliver(payload),
    interrupt: () => deliver({
      ...stable, success: false, video: null, plan: [], stills: [], textGate: [],
      unresolved: [], advisories: [], warnings: [], costs: costTracker.getSummary(),
      failureCode: 'worker_interrupted',
      error: 'The video worker was shut down. Completed shots and saved provider jobs are retained for resume.',
      recovery: {
        version: 1, status: 'verification_pending', stage: 'video_generation', provider: 'cloud_run',
        reason: 'worker_interrupted', nextAction: 'resume_saved_work', retryable: true,
        issues: [{ status: 'interrupted', reason: 'Cloud Run shut down the worker during video generation.' }],
      },
    }, { timeoutMs: 2500, attempts: 2, retryDelayMs: 250 }),
  };
}

module.exports = { createVideoDelivery };
