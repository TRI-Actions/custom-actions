'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parsePaths,
  parseBoolean,
  validateInputs,
  formatChangedPaths,
  freshness,
  run,
} = require('../lib/freshness.js');

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configure(repo) {
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'commit.gpgsign', 'false');
}

function commit(repo, files, message) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', message);
  return sh(repo, 'rev-parse', 'HEAD');
}

function clone(root, remote, name, extraArgs = []) {
  const dir = path.join(root, name);
  sh(root, 'clone', '-q', ...extraArgs, remote, dir);
  configure(dir);
  return dir;
}

function fakeCore() {
  const outputs = {};
  const failures = [];
  return {
    outputs,
    failures,
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setFailed: (message) => {
      failures.push(message);
    },
    info: () => {},
    warning: () => {},
  };
}

// remote.git (bare) <- seed pushes:
//   c0: A/a.txt, B/b.txt                     (main at first)
//   feature: c0 + F/f.txt                     (cut before main advances)
//   c1: main changes A/ only                  (main now)
//   fresh: c1 + F/g.txt                       (already contains the change)
// "early" is cloned before c1, "late" after; "lonely" has unrelated history.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prp-freshness-'));
const remote = path.join(root, 'remote.git');
const repos = {};
const shas = {};

test.before(() => {
  sh(root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  const seed = path.join(root, 'seed');
  sh(root, 'init', '-q', '--initial-branch=main', seed);
  configure(seed);
  sh(seed, 'remote', 'add', 'origin', remote);

  shas.c0 = commit(seed, { 'A/a.txt': 'one\n', 'B/b.txt': 'one\n' }, 'c0');
  sh(seed, 'push', '-q', 'origin', 'main');
  sh(seed, 'checkout', '-q', '-b', 'feature');
  commit(seed, { 'F/f.txt': 'feature\n' }, 'feature');
  sh(seed, 'push', '-q', 'origin', 'feature');

  repos.early = clone(root, remote, 'early');
  sh(repos.early, 'checkout', '-q', 'feature');

  sh(seed, 'checkout', '-q', 'main');
  shas.c1 = commit(seed, { 'A/a.txt': 'two\n', 'A/with space ü.txt': 'x\n' }, 'c1');
  sh(seed, 'push', '-q', 'origin', 'main');
  sh(seed, 'checkout', '-q', '-b', 'fresh');
  commit(seed, { 'F/g.txt': 'fresh\n' }, 'fresh');
  sh(seed, 'push', '-q', 'origin', 'fresh');

  repos.late = clone(root, remote, 'late');
  // --depth is ignored for plain local paths, so clone through a file:// URL.
  repos.shallow = clone(root, `file://${remote}`, 'shallow', ['--depth', '1', '--branch', 'feature']);

  repos.lonely = clone(root, remote, 'lonely');
  sh(repos.lonely, 'checkout', '-q', '--orphan', 'lonely');
  sh(repos.lonely, 'rm', '-rqf', '.');
  commit(repos.lonely, { 'Z/z.txt': 'z\n' }, 'unrelated');
});

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('parsePaths splits on newlines and other whitespace', () => {
  assert.deepEqual(parsePaths('123456789012/\n  shared/\tPipfile\n\n'), ['123456789012/', 'shared/', 'Pipfile']);
  assert.deepEqual(parsePaths(''), []);
  assert.deepEqual(parsePaths(undefined), []);
});

test('parseBoolean is case-insensitive and rejects junk', () => {
  assert.equal(parseBoolean('fetch', 'True'), true);
  assert.equal(parseBoolean('fetch', 'FALSE'), false);
  assert.throws(() => parseBoolean('fetch', '1'), /fetch must be "true" or "false"/);
});

test('formatChangedPaths lists at most 50 files', () => {
  const files = Array.from({ length: 53 }, (_, i) => `A/f${i}.txt`);
  assert.equal(formatChangedPaths(files.slice(0, 50)), files.slice(0, 50).join('\n'));
  const lines = formatChangedPaths(files).split('\n');
  assert.equal(lines.length, 51);
  assert.equal(lines[49], 'A/f49.txt');
  assert.equal(lines[50], '... and 3 more');
  assert.equal(formatChangedPaths([]), '');
});

test('validateInputs rejects option-like or malformed names and paths', () => {
  const ok = { baseRef: 'release/v1.2_x-y', remote: 'origin', paths: ['A/'] };
  validateInputs(ok);
  for (const baseRef of ['', 'main;rm -rf /', 'main main', '-main', '--upload-pack=x', 'ma$in']) {
    assert.throws(() => validateInputs({ ...ok, baseRef }), /invalid base-ref/, baseRef);
  }
  for (const remote of ['', '-u', 'orig in']) {
    assert.throws(() => validateInputs({ ...ok, remote }), /invalid remote/, remote);
  }
  assert.throws(() => validateInputs({ ...ok, paths: [] }), /paths must list at least one pathspec/);
  assert.throws(() => validateInputs({ ...ok, paths: ['A/', '--output=x'] }), /invalid path "--output=x"/);
});

test('branch cut before main changed A/ is stale for A/ only', () => {
  sh(repos.late, 'checkout', '-q', 'feature');
  const stale = freshness({ cwd: repos.late, baseRef: 'main', paths: ['A/'] });
  assert.deepEqual(stale, {
    stale: true,
    changedPaths: ['A/a.txt', 'A/with space ü.txt'],
    mergeBase: shas.c0,
    baseSha: shas.c1,
  });

  const fresh = freshness({ cwd: repos.late, baseRef: 'main', paths: ['B/'] });
  assert.deepEqual(fresh, { stale: false, changedPaths: [], mergeBase: shas.c0, baseSha: shas.c1 });

  const mixed = freshness({ cwd: repos.late, baseRef: 'main', paths: ['B/', 'A/a.txt'] });
  assert.deepEqual(mixed.changedPaths, ['A/a.txt']);
});

test('branch that already contains the change is not stale', () => {
  sh(repos.late, 'checkout', '-q', 'fresh');
  const result = freshness({ cwd: repos.late, baseRef: 'main', paths: ['A/', 'B/'] });
  assert.deepEqual(result, { stale: false, changedPaths: [], mergeBase: shas.c1, baseSha: shas.c1 });
});

test('fetch picks up base branch commits the clone has not seen', () => {
  const noFetch = freshness({ cwd: repos.early, baseRef: 'main', paths: ['A/'], fetch: false });
  assert.equal(noFetch.stale, false);
  assert.equal(noFetch.baseSha, shas.c0);

  const fetched = freshness({ cwd: repos.early, baseRef: 'main', paths: ['A/'], fetch: true });
  assert.equal(fetched.stale, true);
  assert.equal(fetched.baseSha, shas.c1);
  assert.equal(sh(repos.early, 'rev-parse', 'refs/remotes/origin/main'), shas.c1);
});

test('shallow clone fails with a clear message', () => {
  assert.equal(sh(repos.shallow, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.throws(
    () => freshness({ cwd: repos.shallow, baseRef: 'main', paths: ['A/'] }),
    { message: 'needs full history: check out with fetch-depth: 0' },
  );
});

test('missing merge base fails with the full history message', () => {
  assert.throws(
    () => freshness({ cwd: repos.lonely, baseRef: 'main', paths: ['A/'], fetch: false }),
    /^Error: needs full history: check out with fetch-depth: 0 \(git merge-base .* failed/,
  );
});

test('unknown base branch fails', () => {
  assert.throws(
    () => freshness({ cwd: repos.late, baseRef: 'nope', paths: ['A/'] }),
    /git fetch --no-tags origin \+refs\/heads\/nope:refs\/remotes\/origin\/nope failed/,
  );
});

test('bad base-ref is rejected before running git', () => {
  assert.throws(
    () => freshness({ cwd: path.join(root, 'does-not-exist'), baseRef: 'main;id', paths: ['A/'] }),
    /invalid base-ref "main;id"/,
  );
});

test('run sets outputs from the PRP_* env', async () => {
  sh(repos.late, 'checkout', '-q', 'feature');
  const core = fakeCore();
  await run({
    github: {},
    context: {},
    core,
    env: { GITHUB_WORKSPACE: repos.late, PRP_BASE_REF: 'main\n', PRP_PATHS: 'A/\nB/\n', PRP_FETCH: 'true' },
  });
  assert.deepEqual(core.failures, []);
  assert.deepEqual(core.outputs, {
    stale: 'true',
    'changed-paths': 'A/a.txt\nA/with space ü.txt',
    'merge-base': shas.c0,
    'base-sha': shas.c1,
  });
});

test('run fails the step on invalid input without setting outputs', async () => {
  for (const env of [
    { GITHUB_WORKSPACE: repos.late, PRP_BASE_REF: '-main', PRP_PATHS: 'A/' },
    { GITHUB_WORKSPACE: repos.late, PRP_BASE_REF: 'main', PRP_PATHS: ' \n ' },
    { GITHUB_WORKSPACE: repos.late, PRP_BASE_REF: 'main', PRP_PATHS: 'A/', PRP_FETCH: 'yes' },
  ]) {
    const core = fakeCore();
    await run({ github: {}, context: {}, core, env });
    assert.equal(core.failures.length, 1, JSON.stringify(env));
    assert.deepEqual(core.outputs, {});
  }
});

test('run reports the shallow clone failure', async () => {
  const core = fakeCore();
  await run({
    github: {},
    context: {},
    core,
    env: { GITHUB_WORKSPACE: repos.shallow, PRP_BASE_REF: 'main', PRP_PATHS: 'A/' },
  });
  assert.deepEqual(core.failures, ['needs full history: check out with fetch-depth: 0']);
  assert.deepEqual(core.outputs, {});
});
