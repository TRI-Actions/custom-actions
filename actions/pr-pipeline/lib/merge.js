'use strict';

const METHODS = ['merge', 'squash', 'rebase'];

// GitHub refuses a merge while another merge into the same base branch is landing, with
// 405 "Base branch was modified. Review and try the merge again." Two pipelines merging
// at the same moment hit it. Retrying is safe: the sha pin still refuses a moved head.
const BASE_MODIFIED = /base branch was modified/i;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000];

function isBaseModified(err) {
  const data = err && err.response && err.response.data;
  const message = (data && typeof data.message === 'string' && data.message) || (err && err.message) || '';
  return Boolean(err) && err.status === 405 && BASE_MODIFIED.test(message);
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseInputs(env) {
  const prNumber = (env.PRP_PR_NUMBER || '').trim();
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new Error(`pr-number must be a positive integer, got ${JSON.stringify(prNumber)}`);
  }
  const sha = (env.PRP_SHA || '').trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`sha must be a full 40-character commit SHA, got ${JSON.stringify(sha)}`);
  }
  const method = (env.PRP_METHOD || '').trim() || 'merge';
  if (!METHODS.includes(method)) {
    throw new Error(`method must be one of ${METHODS.join(', ')}, got ${JSON.stringify(method)}`);
  }
  return { prNumber: Number(prNumber), sha, method };
}

// Human-readable reason for a failed pulls.merge call.
function mergeError(prNumber, sha, err) {
  const status = err && err.status;
  const data = err && err.response && err.response.data;
  const message = data && typeof data.message === 'string' && data.message
    ? data.message
    : (err && err.message) || String(err);
  if (!status) {
    return `Could not merge PR #${prNumber} (no HTTP status): ${message}`;
  }
  const reason = status === 409 ? `the head moved since ${sha.slice(0, 7)} (${message})` : message;
  return `GitHub refused to merge PR #${prNumber} (${status}): ${reason}`;
}

// Reason a resolved pulls.merge response does not prove the merge, or '' if it does.
function confirmationError(prNumber, data) {
  if (data && data.merged === true && typeof data.sha === 'string' && /^[0-9a-f]{40}$/i.test(data.sha)) {
    return '';
  }
  const message = data && typeof data.message === 'string' && data.message
    ? data.message
    : 'the response has no message';
  return `GitHub did not confirm the merge of PR #${prNumber}: ${message}`;
}

async function run({ github, context, core, env, sleep = sleepMs }) {
  const fail = (error) => {
    core.setOutput('merged', 'false');
    core.setOutput('merge-sha', '');
    core.setOutput('error', error);
    core.setFailed(error);
  };

  let inputs;
  try {
    inputs = parseInputs(env);
  } catch (err) {
    fail(`merge-pr: ${err.message}`);
    return;
  }

  let data;
  for (let attempt = 0; ; attempt += 1) {
    try {
      ({ data } = await github.rest.pulls.merge({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: inputs.prNumber,
        sha: inputs.sha,
        merge_method: inputs.method,
      }));
      break;
    } catch (err) {
      if (isBaseModified(err) && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        core.info(`Another merge into the base branch was landing; trying again in ${delay / 1000}s.`);
        await sleep(delay);
        continue;
      }
      fail(mergeError(inputs.prNumber, inputs.sha, err));
      return;
    }
  }

  const error = confirmationError(inputs.prNumber, data);
  if (error) {
    fail(error);
    return;
  }
  core.setOutput('merged', 'true');
  core.setOutput('merge-sha', data.sha);
  core.setOutput('error', '');
}

module.exports = { parseInputs, mergeError, confirmationError, isBaseModified, RETRY_DELAYS_MS, run };
