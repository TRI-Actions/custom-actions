'use strict';

const { execFileSync } = require('child_process');

const NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_LISTED_PATHS = 50;
const FULL_HISTORY_MESSAGE = 'needs full history: check out with fetch-depth: 0';

// Splits the paths input on any whitespace (newlines included).
function parsePaths(raw) {
  return String(raw || '')
    .split(/\s+/)
    .filter(Boolean);
}

// Parses a true/false input the way GitHub expressions compare strings (case-insensitive).
function parseBoolean(name, value) {
  const lower = String(value).toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

// Throws when an input could be read by git as an option or is not a plain name.
function validateInputs({ baseRef, remote, paths }) {
  for (const [name, value] of [
    ['base-ref', baseRef],
    ['remote', remote],
  ]) {
    if (typeof value !== 'string' || !NAME_PATTERN.test(value) || value.startsWith('-')) {
      throw new Error(`invalid ${name} ${JSON.stringify(value)}: must match ${NAME_PATTERN} and not start with "-"`);
    }
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('paths must list at least one pathspec');
  }
  const bad = paths.find((p) => p.startsWith('-'));
  if (bad !== undefined) {
    throw new Error(`invalid path ${JSON.stringify(bad)}: must not start with "-"`);
  }
}

// Joins changed files with newlines, listing at most max of them.
function formatChangedPaths(files, max = MAX_LISTED_PATHS) {
  if (files.length <= max) return files.join('\n');
  return [...files.slice(0, max), `... and ${files.length - max} more`].join('\n');
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = String(err.stderr || err.message).trim();
    const wrapped = new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    wrapped.status = err.status;
    throw wrapped;
  }
}

// Compares the paths between the merge base of HEAD and <remote>/<baseRef>, and <remote>/<baseRef>.
// Returns { stale, changedPaths, mergeBase, baseSha }; throws with a clear message on any failure.
function freshness({ cwd, baseRef, remote = 'origin', paths, fetch = true }) {
  validateInputs({ baseRef, remote, paths });
  const remoteRef = `refs/remotes/${remote}/${baseRef}`;

  // A shallow history can hide the real merge base, so refuse it up front.
  if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error(FULL_HISTORY_MESSAGE);
  }
  if (fetch) {
    git(cwd, ['fetch', '--no-tags', remote, `+refs/heads/${baseRef}:${remoteRef}`]);
  }
  const baseSha = git(cwd, ['rev-parse', '--verify', `${remoteRef}^{commit}`]).trim();

  let mergeBase;
  try {
    mergeBase = git(cwd, ['merge-base', baseSha, 'HEAD']).trim();
  } catch (err) {
    throw new Error(`${FULL_HISTORY_MESSAGE} (${err.message})`);
  }

  const changedPaths = git(cwd, ['diff', '--name-only', '--no-renames', '-z', mergeBase, baseSha, '--', ...paths])
    .split('\0')
    .filter(Boolean);

  return { stale: changedPaths.length > 0, changedPaths, mergeBase, baseSha };
}

async function run({ core, env }) {
  try {
    const result = freshness({
      cwd: env.GITHUB_WORKSPACE || process.cwd(),
      baseRef: (env.PRP_BASE_REF || '').trim(),
      remote: (env.PRP_REMOTE || 'origin').trim(),
      paths: parsePaths(env.PRP_PATHS),
      fetch: parseBoolean('fetch', env.PRP_FETCH === undefined ? 'true' : env.PRP_FETCH),
    });
    core.setOutput('stale', result.stale ? 'true' : 'false');
    core.setOutput('changed-paths', formatChangedPaths(result.changedPaths));
    core.setOutput('merge-base', result.mergeBase);
    core.setOutput('base-sha', result.baseSha);
  } catch (err) {
    core.setFailed(err.message);
  }
}

module.exports = { parsePaths, parseBoolean, validateInputs, formatChangedPaths, freshness, run };
