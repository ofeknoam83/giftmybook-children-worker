const fs = require('fs');
const path = require('path');

const COMMITS_PATH = path.resolve(__dirname, '..', '..', 'commits.json');

describe('workerCommits', () => {
  let savedCommitsFile = null;

  beforeEach(() => {
    jest.resetModules();
    if (fs.existsSync(COMMITS_PATH)) {
      savedCommitsFile = fs.readFileSync(COMMITS_PATH, 'utf8');
      fs.unlinkSync(COMMITS_PATH);
    } else {
      savedCommitsFile = null;
    }
  });

  afterEach(() => {
    if (fs.existsSync(COMMITS_PATH)) fs.unlinkSync(COMMITS_PATH);
    if (savedCommitsFile !== null) {
      fs.writeFileSync(COMMITS_PATH, savedCommitsFile);
    }
  });

  test('returns empty array when commits.json is missing', () => {
    const { getWorkerCommits } = require('../../services/workerCommits');
    expect(getWorkerCommits()).toEqual([]);
  });

  test('loads up to 3 commits from commits.json', () => {
    fs.writeFileSync(
      COMMITS_PATH,
      JSON.stringify({
        capturedAt: '2026-04-20T00:00:00Z',
        commits: [
          { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'one',   author: 'x', authorDate: '2026-04-20' },
          { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'two',   author: 'x', authorDate: '2026-04-19' },
          { sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'three', author: 'x', authorDate: '2026-04-18' },
          { sha: 'd'.repeat(40), shortSha: 'ddddddd', subject: 'four',  author: 'x', authorDate: '2026-04-17' },
        ],
      }),
    );
    const { getWorkerCommits } = require('../../services/workerCommits');
    const got = getWorkerCommits();
    expect(got).toHaveLength(3);
    expect(got.map(c => c.subject)).toEqual(['one', 'two', 'three']);
    expect(got[0].shortSha).toBe('aaaaaaa');
  });

  test('drops entries without a subject and derives shortSha when missing', () => {
    fs.writeFileSync(
      COMMITS_PATH,
      JSON.stringify({
        commits: [
          { sha: 'abcdef0123456789', subject: 'has subject' },
          { sha: 'deadbeefcafebabe' },
          null,
        ],
      }),
    );
    const { getWorkerCommits } = require('../../services/workerCommits');
    const got = getWorkerCommits();
    expect(got).toHaveLength(1);
    expect(got[0].subject).toBe('has subject');
    expect(got[0].shortSha).toBe('abcdef0');
  });

  test('returns empty array when commits.json is malformed', () => {
    fs.writeFileSync(COMMITS_PATH, 'not-json');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { getWorkerCommits } = require('../../services/workerCommits');
    expect(getWorkerCommits()).toEqual([]);
  });
});
