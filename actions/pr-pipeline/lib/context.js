'use strict';

// actions/checkout only treats full SHA-1 (40) or SHA-256 (64) hex strings as commits.
const SHA_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

// Maps a pull request object (webhook payload or pulls.get response) to the action outputs.
// A missing head repository means the fork was deleted, so it counts as a fork.
function resolveFromPullRequest(pr, { owner, repo, sha }) {
  const headRepo = pr.head && pr.head.repo;
  const isFork =
    !headRepo ||
    String(headRepo.full_name || '').toLowerCase() !== `${owner}/${repo}`.toLowerCase();
  return {
    'pr-number': String(pr.number),
    'head-sha': sha || pr.head.sha,
    'head-ref': pr.head.ref,
    'base-ref': pr.base.ref,
    'base-sha': pr.base.sha,
    state: pr.state,
    merged: pr.merged ? 'true' : 'false',
    author: pr.user ? pr.user.login : '',
    'is-fork': isFork ? 'true' : 'false',
  };
}

// Parses a true/false input the way GitHub expressions compare strings (case-insensitive).
function parseBoolean(name, value) {
  const lower = String(value).toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

async function loadPullRequest({ github, context, owner, repo }) {
  const event = context.eventName;
  if (event === 'pull_request' || event === 'pull_request_target') {
    const pr = context.payload.pull_request;
    if (!pr) throw new Error(`${event} event payload has no pull_request`);
    return pr;
  }
  if (event === 'issue_comment') {
    const issue = context.payload.issue;
    if (!issue || !issue.pull_request) throw new Error('not a pull request comment');
    try {
      const res = await github.rest.pulls.get({ owner, repo, pull_number: issue.number });
      return res.data;
    } catch (err) {
      throw new Error(
        `failed to get pull request #${issue.number} (status ${err.status || 'unknown'}): ${err.message}`,
      );
    }
  }
  throw new Error(
    `unsupported event "${event}": expected pull_request, pull_request_target or issue_comment`,
  );
}

async function run({ github, context, core, env }) {
  try {
    const { owner, repo } = context.repo;
    const checkout = parseBoolean('checkout', env.PRP_CHECKOUT === undefined ? 'true' : env.PRP_CHECKOUT);
    const sha = (env.PRP_SHA || '').trim();
    if (sha && !SHA_PATTERN.test(sha)) {
      throw new Error(`sha must be a full 40 or 64 character commit SHA, got ${JSON.stringify(sha)}`);
    }

    const pr = await loadPullRequest({ github, context, owner, repo });
    const outputs = resolveFromPullRequest(pr, { owner, repo, sha });
    for (const [name, value] of Object.entries(outputs)) core.setOutput(name, value);

    if (checkout && outputs['is-fork'] === 'true') {
      throw new Error('refusing to check out code from a fork');
    }
  } catch (err) {
    core.setFailed(err.message);
  }
}

module.exports = { resolveFromPullRequest, parseBoolean, run };
