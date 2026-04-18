/**
 * Worker Version — resolves a stable identifier for the running worker build.
 * Injected into every progress/completion callback so the standalone app can
 * record which worker revision produced a given book.
 */

const fs = require('fs');
const path = require('path');

function resolveVersion() {
  if (process.env.WORKER_VERSION) return process.env.WORKER_VERSION;

  let sha = process.env.GIT_SHA || '';
  if (!sha) {
    try {
      const shaFile = path.join(__dirname, '..', 'GIT_SHA');
      if (fs.existsSync(shaFile)) sha = fs.readFileSync(shaFile, 'utf8').trim();
    } catch (_) {
      // ignore
    }
  }

  const pkg = require('../package.json');
  return sha ? `${pkg.version}+${sha.slice(0, 7)}` : pkg.version;
}

const WORKER_VERSION = resolveVersion();

module.exports = { WORKER_VERSION };
