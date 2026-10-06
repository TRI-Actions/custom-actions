'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseInputs, mergeError, confirmationError, run } = require('../lib/merge.js');

const CONTEXT = { repo: { owner: 'tri', repo: 'infra' }, serverUrl: 'https://ghe.example', runId: 42 };
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const MERGE_SHA = '0123456789abcdef0123456789abcdef01234567';

function httpError(status, message) {
  const err = new Error(`${message} - https://docs.github.com/rest/pulls/pulls#merge-a-pull-request`);
  err.status = status;
  err.response = { status, data: { message } };
  return err;
}

// result: an Error to throw, a response to resolve with, or null for a successful merge.
function fakeGithub(result) {
  const calls = [];
  const github = {
    rest: {
      pulls: {
        merge: async (params) => {
          calls.push(params);
          if (result instanceof Error) throw result;
          return result || { data: { sha: MERGE_SHA, merged: true, message: 'Pull Request successfully merged' } };
        },
      },
    },
    paginate: async () => {
      throw new Error('paginate is not used by merge-pr');
    },
  };
  return { github, calls };
}

function fakeCore() {
  return {
    outputs: {},
    failed: null,
    setOutput(name, value) {
      this.outputs[name] = value;
    },
    setFailed(message) {
      this.failed = message;
    },
    info() {},
    warning() {},
  };
}

async function runWith(result, envOverrides = {}) {
  const { github, calls } = fakeGithub(result);
  const core = fakeCore();
  const env = { PRP_PR_NUMBER: '12', PRP_SHA: SHA, PRP_METHOD: 'squash', ...envOverrides };
  await run({ github, context: CONTEXT, core, env });
  return { calls, core };
}

test('success merges at the given sha and reports the merge sha', async () => {
  const { calls, core } = await runWith(null);
  assert.deepEqual(calls, [{ owner: 'tri', repo: 'infra', pull_number: 12, sha: SHA, merge_method: 'squash' }]);
  assert.equal(core.failed, null);
  assert.deepEqual(core.outputs, { merged: 'true', 'merge-sha': MERGE_SHA, error: '' });
});

test('method defaults to merge', async () => {
  const { calls } = await runWith(null, { PRP_METHOD: '' });
  assert.equal(calls[0].merge_method, 'merge');
});

test('409 reports that the head moved since the expected sha', async () => {
  const { core } = await runWith(httpError(409, 'Head branch was modified. Review and try the merge again.'));
  const expected = 'GitHub refused to merge PR #12 (409): the head moved since abcdef1 (Head branch was modified. Review and try the merge again.)';
  assert.deepEqual(core.outputs, { merged: 'false', 'merge-sha': '', error: expected });
  assert.equal(core.failed, expected);
});

test('405 reports the GitHub message', async () => {
  const { core } = await runWith(httpError(405, 'Pull Request is not mergeable'));
  const expected = 'GitHub refused to merge PR #12 (405): Pull Request is not mergeable';
  assert.deepEqual(core.outputs, { merged: 'false', 'merge-sha': '', error: expected });
  assert.equal(core.failed, expected);
});

test('network error without status still fails closed', async () => {
  const err = new Error('getaddrinfo ENOTFOUND ghe.example');
  err.code = 'ENOTFOUND';
  const { core } = await runWith(err);
  const expected = 'Could not merge PR #12 (no HTTP status): getaddrinfo ENOTFOUND ghe.example';
  assert.deepEqual(core.outputs, { merged: 'false', 'merge-sha': '', error: expected });
  assert.equal(core.failed, expected);
});

test('200 with merged false fails closed', async () => {
  const { core } = await runWith({ data: { sha: null, merged: false, message: 'Pull Request is not mergeable' } });
  const expected = 'GitHub did not confirm the merge of PR #12: Pull Request is not mergeable';
  assert.deepEqual(core.outputs, { merged: 'false', 'merge-sha': '', error: expected });
  assert.equal(core.failed, expected);
});

test('200 without a merge sha fails closed', async () => {
  const { core } = await runWith({ data: { merged: true, message: 'Pull Request successfully merged' } });
  const expected = 'GitHub did not confirm the merge of PR #12: Pull Request successfully merged';
  assert.deepEqual(core.outputs, { merged: 'false', 'merge-sha': '', error: expected });
  assert.equal(core.failed, expected);
});

test('200 with an empty body fails closed', async () => {
  for (const data of [undefined, null, '', '<html>proxy page</html>']) {
    const { core } = await runWith({ data });
    const expected = 'GitHub did not confirm the merge of PR #12: the response has no message';
    assert.deepEqual(core.outputs, { merged: 'false', 'merge-sha': '', error: expected }, `data ${JSON.stringify(data)}`);
    assert.equal(core.failed, expected);
  }
});

test('confirmationError requires merged true and a 40-character hex sha', () => {
  const ok = { merged: true, sha: MERGE_SHA, message: 'Pull Request successfully merged' };
  assert.equal(confirmationError(3, ok), '');
  assert.equal(confirmationError(3, { ...ok, sha: MERGE_SHA.toUpperCase() }), '');
  const bad = [
    { ...ok, merged: 'true' },
    { ...ok, merged: undefined },
    { ...ok, sha: MERGE_SHA.slice(0, 7) },
    { ...ok, sha: `${MERGE_SHA}0` },
    { ...ok, sha: `${MERGE_SHA.slice(0, 39)}g` },
    { ...ok, sha: '' },
    { ...ok, sha: 12345 },
  ];
  for (const data of bad) {
    assert.equal(confirmationError(3, data), 'GitHub did not confirm the merge of PR #3: Pull Request successfully merged',
      `data ${JSON.stringify(data)}`);
  }
  assert.equal(confirmationError(3, { merged: false, message: '' }),
    'GitHub did not confirm the merge of PR #3: the response has no message');
});

test('mergeError falls back to the error message when the response has no body', () => {
  const err = new Error('Bad Gateway');
  err.status = 502;
  assert.equal(mergeError(3, SHA, err), 'GitHub refused to merge PR #3 (502): Bad Gateway');
  assert.equal(mergeError(3, SHA, 'boom'), 'Could not merge PR #3 (no HTTP status): boom');
});

test('parseInputs validates pr-number, sha and method', () => {
  assert.deepEqual(parseInputs({ PRP_PR_NUMBER: ' 5 ', PRP_SHA: SHA.toUpperCase(), PRP_METHOD: 'rebase' }),
    { prNumber: 5, sha: SHA.toUpperCase(), method: 'rebase' });
  assert.throws(() => parseInputs({ PRP_PR_NUMBER: '0', PRP_SHA: SHA }), /pr-number must be a positive integer/);
  assert.throws(() => parseInputs({ PRP_PR_NUMBER: '5', PRP_SHA: 'abcdef1' }), /sha must be a full 40-character commit SHA/);
  assert.throws(() => parseInputs({ PRP_PR_NUMBER: '5', PRP_SHA: SHA, PRP_METHOD: 'fast-forward' }), /method must be one of merge, squash, rebase/);
});

test('invalid inputs fail without calling the API', async () => {
  const { calls, core } = await runWith(null, { PRP_SHA: '' });
  assert.deepEqual(calls, []);
  assert.equal(core.outputs.merged, 'false');
  assert.match(core.outputs.error, /^merge-pr: sha must be a full 40-character commit SHA/);
  assert.equal(core.failed, core.outputs.error);
});
