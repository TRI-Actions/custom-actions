'use strict';

const fs = require('fs');
const path = require('path');

const KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/;
const MODES = ['upsert', 'recreate', 'delete'];
const DEFAULT_MAX_LENGTH = 60000;
const DEFAULT_AUTHOR = 'github-actions[bot]';

// Hidden marker that identifies the sticky comment for a key.
function marker(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error(`invalid key ${JSON.stringify(key)}: must match ${KEY_PATTERN}`);
  }
  return `<!-- tri-pr-pipeline:${key} -->`;
}

// Cuts text from the middle so the result is at most max characters.
// note(n) returns the line inserted in place of the n removed characters.
function truncate(text, max, note) {
  if (text.length <= max) return text;
  // note(text.length) is the longest note any cut can produce, so budgeting
  // for it guarantees the result fits.
  const keep = max - note(text.length).length - 2;
  if (keep < 0) {
    throw new Error(`max length ${max} is too small to fit the truncation note`);
  }
  let headLen = Math.ceil(keep / 2);
  let tailLen = keep - headLen;
  // Never split a UTF-16 surrogate pair.
  if (headLen > 0 && isHighSurrogate(text.charCodeAt(headLen - 1))) headLen -= 1;
  if (tailLen > 0 && isLowSurrogate(text.charCodeAt(text.length - tailLen))) tailLen -= 1;
  const cut = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n${note(cut)}\n${text.slice(text.length - tailLen)}`;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

// Comments by author whose body starts with the marker line for key, oldest first.
// author '*' matches any author; logins are compared case-insensitively.
function findMatches(comments, key, author) {
  const m = marker(key);
  const login = author.toLowerCase();
  const startsWithMarker = (body) =>
    body === m || body.startsWith(`${m}\n`) || body.startsWith(`${m}\r\n`);
  const byAuthor = (user) =>
    author === '*' || (Boolean(user) && typeof user.login === 'string' && user.login.toLowerCase() === login);
  return comments
    .filter((c) => typeof c.body === 'string' && startsWithMarker(c.body) && byAuthor(c.user))
    .sort((a, b) => a.id - b.id);
}

function apiError(what, err) {
  const status = err && err.status ? err.status : 'no HTTP status';
  const data = err && err.response && err.response.data;
  const message = data && typeof data.message === 'string' && data.message
    ? data.message
    : (err && err.message) || String(err);
  return new Error(`failed to ${what} (${status}): ${message}`);
}

async function api(what, fn) {
  try {
    return await fn();
  } catch (err) {
    throw apiError(what, err);
  }
}

function parseInputs(env) {
  const prNumber = (env.PRP_PR_NUMBER || '').trim();
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new Error(`pr-number must be a positive integer, got ${JSON.stringify(prNumber)}`);
  }
  const key = (env.PRP_KEY || '').trim();
  marker(key);
  const mode = (env.PRP_MODE || '').trim() || 'upsert';
  if (!MODES.includes(mode)) {
    throw new Error(`mode must be one of ${MODES.join(', ')}, got ${JSON.stringify(mode)}`);
  }
  const maxLength = (env.PRP_MAX_LENGTH || '').trim() || String(DEFAULT_MAX_LENGTH);
  if (!/^[1-9][0-9]*$/.test(maxLength)) {
    throw new Error(`max-length must be a positive integer, got ${JSON.stringify(maxLength)}`);
  }
  return {
    prNumber: Number(prNumber),
    key,
    mode,
    maxLength: Number(maxLength),
    body: env.PRP_BODY || '',
    bodyFile: (env.PRP_BODY_FILE || '').trim(),
    author: (env.PRP_COMMENT_AUTHOR || '').trim() || DEFAULT_AUTHOR,
  };
}

function readContent(inputs, env) {
  let content = inputs.body;
  if (inputs.bodyFile) {
    const file = path.resolve(env.GITHUB_WORKSPACE || process.cwd(), inputs.bodyFile);
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`cannot read body-file ${file}: ${err.message}`);
    }
  }
  if (content.trim() === '') {
    throw new Error(`body or body-file is required (and must not be empty) for mode ${inputs.mode}`);
  }
  return content;
}

function buildBody(key, content, maxLength, runUrl) {
  const m = marker(key);
  const note = (n) =>
    `... ${n} characters truncated, see the [workflow run](${runUrl}) for the full output ...`;
  // Truncate the content only, so the marker always survives.
  let text;
  try {
    text = truncate(content, maxLength - m.length - 1, note);
  } catch (err) {
    throw new Error(`max-length ${maxLength} is too small to fit the marker and the truncation note`);
  }
  return `${m}\n${text}`;
}

async function deleteComment(github, repo, id) {
  try {
    await github.rest.issues.deleteComment({ ...repo, comment_id: id });
  } catch (err) {
    // Already gone, for example removed by a concurrent run.
    if (err && err.status === 404) return;
    throw apiError(`delete comment ${id}`, err);
  }
}

async function run({ github, context, core, env }) {
  try {
    const inputs = parseInputs(env);
    const repo = { owner: context.repo.owner, repo: context.repo.repo };
    let body = null;
    if (inputs.mode !== 'delete') {
      const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
      body = buildBody(inputs.key, readContent(inputs, env), inputs.maxLength, runUrl);
    }

    const comments = await api(`list comments on PR #${inputs.prNumber}`, () =>
      github.paginate(github.rest.issues.listComments, {
        ...repo,
        issue_number: inputs.prNumber,
        per_page: 100,
      }));
    const matches = findMatches(comments, inputs.key, inputs.author);

    let comment = null;
    let stale = matches;
    if (inputs.mode === 'upsert' && matches.length > 0) {
      const [oldest, ...rest] = matches;
      stale = rest;
      comment = oldest;
      if (oldest.body !== body) {
        const res = await api(`update comment ${oldest.id}`, () =>
          github.rest.issues.updateComment({ ...repo, comment_id: oldest.id, body }));
        comment = res.data;
      }
    }

    for (const c of stale) {
      await deleteComment(github, repo, c.id);
    }

    if (inputs.mode !== 'delete' && comment === null) {
      const res = await api(`create comment on PR #${inputs.prNumber}`, () =>
        github.rest.issues.createComment({ ...repo, issue_number: inputs.prNumber, body }));
      comment = res.data;
    }

    core.setOutput('comment-id', comment ? String(comment.id) : '');
    core.setOutput('comment-url', comment ? comment.html_url : '');
  } catch (err) {
    core.setFailed(`sticky-comment: ${err.message}`);
  }
}

module.exports = { marker, truncate, findMatches, parseInputs, buildBody, run };
