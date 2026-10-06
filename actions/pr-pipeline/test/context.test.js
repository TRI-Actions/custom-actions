'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFromPullRequest, parseBoolean, run } = require('../lib/context.js');

const OWNER = 'TRI-IE';
const REPO = 'infra';
const HEAD_SHA = 'a'.repeat(40);
const OVERRIDE_SHA = 'b'.repeat(40);

function makePr(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    merged: false,
    user: { login: 'alice' },
    head: { sha: HEAD_SHA, ref: 'feature/x', repo: { full_name: `${OWNER}/${REPO}` } },
    base: { sha: 'c'.repeat(40), ref: 'main' },
    ...overrides,
  };
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

function fakeGithub({ pr, error } = {}) {
  const calls = [];
  return {
    calls,
    paginate: async (method, params) => {
      const res = await method(params);
      return res.data;
    },
    rest: {
      pulls: {
        get: async (params) => {
          calls.push(params);
          if (error) throw error;
          return { data: pr };
        },
      },
    },
  };
}

function makeContext(eventName, payload) {
  return { eventName, payload, repo: { owner: OWNER, repo: REPO } };
}

async function runWith({ eventName, payload, env = {}, github = fakeGithub() }) {
  const core = fakeCore();
  await run({ github, context: makeContext(eventName, payload), core, env });
  return { core, github };
}

test('resolveFromPullRequest maps a same-repo pull request', () => {
  const out = resolveFromPullRequest(makePr(), { owner: OWNER, repo: REPO, sha: '' });
  assert.deepEqual(out, {
    'pr-number': '7',
    'head-sha': HEAD_SHA,
    'head-ref': 'feature/x',
    'base-ref': 'main',
    'base-sha': 'c'.repeat(40),
    state: 'open',
    merged: 'false',
    author: 'alice',
    'is-fork': 'false',
  });
});

test('resolveFromPullRequest compares the head repo case-insensitively', () => {
  const pr = makePr({ head: { sha: HEAD_SHA, ref: 'x', repo: { full_name: 'tri-ie/INFRA' } } });
  assert.equal(resolveFromPullRequest(pr, { owner: OWNER, repo: REPO })['is-fork'], 'false');
});

test('resolveFromPullRequest flags a fork and a deleted head repo', () => {
  const fork = makePr({ head: { sha: HEAD_SHA, ref: 'x', repo: { full_name: 'mallory/infra' } } });
  assert.equal(resolveFromPullRequest(fork, { owner: OWNER, repo: REPO })['is-fork'], 'true');
  const deleted = makePr({ head: { sha: HEAD_SHA, ref: 'x', repo: null } });
  assert.equal(resolveFromPullRequest(deleted, { owner: OWNER, repo: REPO })['is-fork'], 'true');
});

test('resolveFromPullRequest uses the sha override and reports merged', () => {
  const out = resolveFromPullRequest(makePr({ merged: true, state: 'closed' }), {
    owner: OWNER,
    repo: REPO,
    sha: OVERRIDE_SHA,
  });
  assert.equal(out['head-sha'], OVERRIDE_SHA);
  assert.equal(out.merged, 'true');
  assert.equal(out.state, 'closed');
});

test('parseBoolean follows GitHub expression case-insensitivity and rejects junk', () => {
  assert.equal(parseBoolean('x', 'TRUE'), true);
  assert.equal(parseBoolean('x', 'false'), false);
  assert.throws(() => parseBoolean('x', 'yes'), /x must be "true" or "false"/);
});

for (const eventName of ['pull_request', 'pull_request_target']) {
  test(`run reads the pull request from a ${eventName} payload`, async () => {
    const { core, github } = await runWith({
      eventName,
      payload: { pull_request: makePr() },
      env: { PRP_CHECKOUT: 'true' },
    });
    assert.deepEqual(core.failures, []);
    assert.equal(github.calls.length, 0);
    assert.equal(core.outputs['pr-number'], '7');
    assert.equal(core.outputs['head-sha'], HEAD_SHA);
    assert.equal(core.outputs['base-ref'], 'main');
    assert.equal(core.outputs['is-fork'], 'false');
  });
}

test('run fetches the pull request for an issue_comment on a PR', async () => {
  const github = fakeGithub({ pr: makePr({ merged: true }) });
  const { core } = await runWith({
    eventName: 'issue_comment',
    payload: { issue: { number: 7, pull_request: { url: 'x' } }, comment: { body: '/plan' } },
    github,
  });
  assert.deepEqual(core.failures, []);
  assert.deepEqual(github.calls, [{ owner: OWNER, repo: REPO, pull_number: 7 }]);
  assert.equal(core.outputs['head-ref'], 'feature/x');
  assert.equal(core.outputs.merged, 'true');
  assert.equal(core.outputs.author, 'alice');
});

test('run fails for an issue_comment on a plain issue', async () => {
  const { core, github } = await runWith({
    eventName: 'issue_comment',
    payload: { issue: { number: 3 }, comment: { body: '/plan' } },
  });
  assert.deepEqual(core.failures, ['not a pull request comment']);
  assert.equal(github.calls.length, 0);
  assert.deepEqual(core.outputs, {});
});

test('run fails closed when pulls.get errors', async () => {
  const error = Object.assign(new Error('Not Found'), { status: 404 });
  const { core } = await runWith({
    eventName: 'issue_comment',
    payload: { issue: { number: 7, pull_request: {} } },
    github: fakeGithub({ error }),
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /pull request #7 \(status 404\): Not Found/);
  assert.deepEqual(core.outputs, {});
});

test('run fails for unsupported events', async () => {
  const { core } = await runWith({ eventName: 'push', payload: {} });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /unsupported event "push"/);
});

test('run applies the sha override', async () => {
  const { core } = await runWith({
    eventName: 'pull_request',
    payload: { pull_request: makePr() },
    env: { PRP_SHA: ` ${OVERRIDE_SHA}\n` },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs['head-sha'], OVERRIDE_SHA);
});

test('run rejects a sha override that is not a full commit SHA', async () => {
  for (const sha of ['abc1234', 'main', `${HEAD_SHA}x`]) {
    const { core } = await runWith({
      eventName: 'pull_request',
      payload: { pull_request: makePr() },
      env: { PRP_SHA: sha },
    });
    assert.equal(core.failures.length, 1, sha);
    assert.match(core.failures[0], /sha must be a full 40 or 64 character commit SHA/);
    assert.deepEqual(core.outputs, {});
  }
});

test('run refuses to check out a fork, including a deleted head repo', async () => {
  for (const repo of [{ full_name: 'mallory/infra' }, null]) {
    for (const checkout of [undefined, 'true', 'TRUE']) {
      const env = checkout === undefined ? {} : { PRP_CHECKOUT: checkout };
      const { core } = await runWith({
        eventName: 'pull_request_target',
        payload: { pull_request: makePr({ head: { sha: HEAD_SHA, ref: 'x', repo } }) },
        env,
      });
      assert.deepEqual(core.failures, ['refusing to check out code from a fork']);
      assert.equal(core.outputs['is-fork'], 'true');
    }
  }
});

test('run allows a fork when checkout is false', async () => {
  const { core } = await runWith({
    eventName: 'pull_request',
    payload: { pull_request: makePr({ head: { sha: HEAD_SHA, ref: 'x', repo: { full_name: 'mallory/infra' } } }) },
    env: { PRP_CHECKOUT: 'false' },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs['is-fork'], 'true');
});

test('run rejects an invalid checkout value', async () => {
  const { core } = await runWith({
    eventName: 'pull_request',
    payload: { pull_request: makePr() },
    env: { PRP_CHECKOUT: 'yes' },
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /checkout must be "true" or "false"/);
});
