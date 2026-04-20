#!/usr/bin/env node
/**
 * Capture the last 3 git commits on the branch being deployed and write them
 * to `commits.json` at the repo root. The running Cloud Run worker reads this
 * file at startup to expose "what was fixed in this version" metadata on every
 * progress/completion callback.
 *
 * Intended to run in CI (GitHub Actions) before `gcloud run deploy --source .`
 * so the generated JSON ships inside the build context. If git is unavailable
 * (e.g. local dev, buildpack cache), the script writes a placeholder and exits
 * 0 so the deploy is never blocked.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.resolve(__dirname, '..', 'commits.json');
const COMMIT_COUNT = 3;
const DELIMITER = '<<COMMIT_SEP>>';

function runGit(args) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function captureCommits() {
  const fmt = ['%H', '%h', '%s', '%an', '%aI'].join(DELIMITER);
  const raw = runGit(`log -n ${COMMIT_COUNT} --pretty=format:${JSON.stringify(fmt)}`);
  if (!raw) return [];

  return raw
    .split('\n')
    .map(line => {
      const [sha, shortSha, subject, author, authorDate] = line.split(DELIMITER);
      if (!sha) return null;
      return { sha, shortSha, subject, author, authorDate };
    })
    .filter(Boolean);
}

function main() {
  const commits = captureCommits();
  const payload = {
    capturedAt: new Date().toISOString(),
    branch: runGit('rev-parse --abbrev-ref HEAD') || null,
    headSha: runGit('rev-parse HEAD') || null,
    commits,
  };

  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[captureCommits] Wrote ${commits.length} commit(s) to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main();
