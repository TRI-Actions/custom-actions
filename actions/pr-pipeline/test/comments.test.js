'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { marker, truncate, findMatches, run } = require('../lib/comments.js');

const CONTEXT = { repo: { owner: 'tri', repo: 'infra' }, serverUrl: 'https://ghe.example', runId: 42 };
const RUN_URL = 'https://ghe.example/tri/infra/actions/runs/42';

function httpError(status, message) {
  const err = new Error(`${message} - https://docs.github.com/rest`);
  err.status = status;
  err.response = { status, data: { message } };
  return err;
}

function fakeGithub(initial = [], fail = {}) {
  const state = { comments: initial.map((c) => ({ ...c })), nextId: 1000, calls: [] };
  const url = (id) => `https://ghe.example/tri/infra/pull/7#issuecomment-${id}`;
  const rest = {
    issues: {
      listComments: async () => {
        throw new Error('listComments must be called through paginate');
      },
      createComment: async ({ owner, repo, issue_number, body }) => {
        state.calls.push(['create', { owner, repo, issue_number }]);
        if (fail.create) throw fail.create;
        const c = { id: state.nextId++, body, html_url: url(state.nextId - 1) };
        state.comments.push(c);
        return { data: { ...c } };
      },
      updateComment: async ({ comment_id, body }) => {
        state.calls.push(['update', comment_id]);
        if (fail.update) throw fail.update;
        const c = state.comments.find((x) => x.id === comment_id);
        c.body = body;
        return { data: { ...c } };
      },
      deleteComment: async ({ comment_id }) => {
        state.calls.push(['delete', comment_id]);
        if (fail.delete) throw fail.delete;
        state.comments = state.comments.filter((x) => x.id !== comment_id);
        return { data: undefined };
      },
    },
  };
  const github = {
    rest,
    paginate: async (method, params) => {
      assert.equal(method, rest.issues.listComments);
      state.calls.push(['list', params]);
      if (fail.list) throw fail.list;
      return state.comments.map((c) => ({ ...c }));
    },
  };
  return { github, state };
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

function env(overrides = {}) {
  return { PRP_PR_NUMBER: '7', PRP_KEY: 'plan:1', PRP_BODY: 'hello', ...overrides };
}

const BOT = 'github-actions[bot]';

function existing(id, key, text = 'old', login = BOT) {
  return {
    id,
    body: `${marker(key)}\n${text}`,
    html_url: `https://ghe.example/tri/infra/pull/7#issuecomment-${id}`,
    user: { login, type: login.endsWith('[bot]') ? 'Bot' : 'User' },
  };
}

// Compact call log: 'list', 'create', 'update:<id>', 'delete:<id>'.
function ops(state) {
  return state.calls.map(([op, arg]) => (op === 'update' || op === 'delete' ? `${op}:${arg}` : op));
}

async function runWith(comments, envOverrides, fail) {
  const { github, state } = fakeGithub(comments, fail);
  const core = fakeCore();
  await run({ github, context: CONTEXT, core, env: env(envOverrides) });
  return { state, core };
}

const note = (n) => `... ${n} characters truncated, see the [workflow run](${RUN_URL}) for the full output ...`;

test('marker embeds the key in a hidden HTML comment', () => {
  assert.equal(marker('plan:1'), '<!-- tri-pr-pipeline:plan:1 -->');
  assert.equal(marker('a.b_c-d:e'), '<!-- tri-pr-pipeline:a.b_c-d:e -->');
});

test('marker rejects invalid keys', () => {
  for (const key of ['', 'Plan', '-plan', ':plan', 'plan 1', 'plan/1', 'x -->', undefined]) {
    assert.throws(() => marker(key), /invalid key/, `key ${JSON.stringify(key)}`);
  }
});

test('findMatches isolates keys that share a prefix', () => {
  const comments = [
    existing(3, 'plan:12'),
    existing(2, 'plan:1'),
    { id: 4, body: 'a user comment mentioning tri-pr-pipeline:plan:1', user: { login: BOT } },
    { id: 5, body: null, user: { login: BOT } },
    existing(1, 'plan:1'),
  ];
  assert.deepEqual(findMatches(comments, 'plan:1', BOT).map((c) => c.id), [1, 2]);
  assert.deepEqual(findMatches(comments, 'plan:12', BOT).map((c) => c.id), [3]);
  assert.deepEqual(findMatches(comments, 'plan', BOT), []);
});

test('findMatches only matches the marker as the whole first line', () => {
  const m = marker('k');
  const user = { login: BOT };
  const comments = [
    { id: 1, body: m, user },
    { id: 2, body: `${m}\nbody`, user },
    { id: 3, body: `${m}\r\nedited in the web UI`, user },
    { id: 4, body: `> quoted\n${m}\nbody`, user },
    { id: 5, body: `see ${m}`, user },
    { id: 6, body: ` ${m}\nbody`, user },
    { id: 7, body: `${m} trailing\nbody`, user },
    { id: 8, body: `${m}x`, user },
  ];
  assert.deepEqual(findMatches(comments, 'k', BOT).map((c) => c.id), [1, 2, 3]);
});

test('findMatches ignores the same marker posted by another author', () => {
  const comments = [
    existing(1, 'k', 'planted', 'mallory'),
    existing(2, 'k'),
    existing(3, 'k', 'ghost', BOT),
    existing(4, 'k', 'other app', 'other-app[bot]'),
  ];
  comments[2].user = null;
  assert.deepEqual(findMatches(comments, 'k', BOT).map((c) => c.id), [2]);
  assert.deepEqual(findMatches(comments, 'k', 'mallory').map((c) => c.id), [1]);
});

test('findMatches compares the author case-insensitively', () => {
  const comments = [existing(1, 'k', 'old', 'GitHub-Actions[bot]'), existing(2, 'k', 'old', 'svc-pat-user')];
  assert.deepEqual(findMatches(comments, 'k', BOT).map((c) => c.id), [1]);
  assert.deepEqual(findMatches(comments, 'k', 'SVC-PAT-User').map((c) => c.id), [2]);
});

test('findMatches with author * matches any author', () => {
  const comments = [
    existing(3, 'k', 'old', 'mallory'),
    existing(1, 'k'),
    { id: 2, body: `${marker('k')}\nghost`, user: null },
    { ...existing(4, 'k'), body: `quoted\n${marker('k')}` },
  ];
  assert.deepEqual(findMatches(comments, 'k', '*').map((c) => c.id), [1, 2, 3]);
});

test('truncate leaves text that fits unchanged', () => {
  assert.equal(truncate('abc', 3, note), 'abc');
  assert.equal(truncate('', 10, note), '');
});

test('truncate stays within the bound and reports the exact cut', () => {
  for (const len of [200, 999, 1000, 1001, 5000, 123457]) {
    const text = 'H'.repeat(Math.floor(len / 2)) + 'T'.repeat(len - Math.floor(len / 2));
    for (const max of [note(len).length + 2, 150, 199, 500, 4096, 60000]) {
      if (max < note(len).length + 2 || len <= max) continue;
      const out = truncate(text, max, note);
      assert.ok(out.length <= max, `len=${len} max=${max} got ${out.length}`);
      assert.ok(out.length >= max - 3, `len=${len} max=${max} wasted space: ${out.length}`);
      const [head, line, tail] = out.split('\n');
      const n = Number(line.match(/^\.\.\. (\d+) characters truncated/)[1]);
      assert.equal(n, len - head.length - tail.length);
      assert.equal(line, note(n));
    }
  }
});

test('truncate keeps both ends of the text', () => {
  const text = `START-${'x'.repeat(10000)}-END`;
  const out = truncate(text, 1000, note);
  assert.ok(out.startsWith('START-'));
  assert.ok(out.endsWith('-END'));
  assert.ok(out.includes(`[workflow run](${RUN_URL})`));
  assert.ok(out.length <= 1000);
});

test('truncate does not split surrogate pairs', () => {
  const text = '\u{1F600}'.repeat(5000);
  for (const max of [300, 301, 302, 303]) {
    const out = truncate(text, max, note);
    assert.ok(out.length <= max);
    assert.ok(out.isWellFormed(), `max=${max} produced a lone surrogate`);
  }
});

test('truncate throws when the note cannot fit', () => {
  assert.throws(() => truncate('x'.repeat(500), 20, note), /too small/);
});

test('upsert creates a comment when none exists', async () => {
  const { state, core } = await runWith([existing(1, 'plan:12')], {});
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list', 'create']);
  assert.deepEqual(state.calls[0][1], { owner: 'tri', repo: 'infra', issue_number: 7, per_page: 100 });
  const created = state.comments.find((c) => c.id === 1000);
  assert.equal(created.body, '<!-- tri-pr-pipeline:plan:1 -->\nhello');
  assert.equal(core.outputs['comment-id'], '1000');
  assert.equal(core.outputs['comment-url'], 'https://ghe.example/tri/infra/pull/7#issuecomment-1000');
  assert.equal(state.comments.find((c) => c.id === 1).body, `${marker('plan:12')}\nold`);
});

test('upsert updates the oldest match and deletes duplicates', async () => {
  const comments = [
    { id: 4, body: 'user comment' },
    existing(9, 'plan:1', 'dup'),
    existing(3, 'plan:1', 'oldest'),
    existing(5, 'plan:12'),
    existing(6, 'plan:1', 'dup2'),
  ];
  const { state, core } = await runWith(comments, { PRP_BODY: 'new plan' });
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list', 'update:3', 'delete:6', 'delete:9']);
  assert.deepEqual(state.comments.map((c) => c.id).sort(), [3, 4, 5]);
  assert.equal(state.comments.find((c) => c.id === 3).body, `${marker('plan:1')}\nnew plan`);
  assert.equal(core.outputs['comment-id'], '3');
  assert.equal(core.outputs['comment-url'], 'https://ghe.example/tri/infra/pull/7#issuecomment-3');
});

test('upsert skips the update when the body is unchanged', async () => {
  const { state, core } = await runWith([existing(3, 'plan:1', 'hello')], {});
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list']);
  assert.equal(core.outputs['comment-id'], '3');
});

test('recreate deletes every match then creates a new comment', async () => {
  const comments = [existing(3, 'plan:1'), existing(5, 'plan:12'), existing(6, 'plan:1')];
  const { state, core } = await runWith(comments, { PRP_MODE: 'recreate' });
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list', 'delete:3', 'delete:6', 'create']);
  assert.deepEqual(state.comments.map((c) => c.id), [5, 1000]);
  assert.equal(core.outputs['comment-id'], '1000');
});

test('delete removes every match and clears outputs', async () => {
  const comments = [existing(3, 'plan:1'), existing(5, 'plan:12'), existing(6, 'plan:1')];
  const { state, core } = await runWith(comments, { PRP_MODE: 'delete', PRP_BODY: '' });
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list', 'delete:3', 'delete:6']);
  assert.deepEqual(state.comments.map((c) => c.id), [5]);
  assert.deepEqual(core.outputs, { 'comment-id': '', 'comment-url': '' });
});

test('delete with nothing to delete succeeds without writes', async () => {
  const { state, core } = await runWith([existing(5, 'plan:12')], { PRP_MODE: 'delete', PRP_BODY: '' });
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list']);
  assert.deepEqual(core.outputs, { 'comment-id': '', 'comment-url': '' });
});

test('delete tolerates a comment already removed by a concurrent run', async () => {
  const { core } = await runWith([existing(3, 'plan:1')], { PRP_MODE: 'delete' }, { delete: httpError(404, 'Not Found') });
  assert.equal(core.failed, null);
});

test('upsert leaves a marker comment by another author alone', async () => {
  const comments = [existing(3, 'plan:1', 'planted', 'mallory'), existing(5, 'plan:1', 'quoted', BOT)];
  comments[1].body = `> ${marker('plan:1')}\nquoted`;
  const { state, core } = await runWith(comments, {});
  assert.equal(core.failed, null);
  assert.deepEqual(ops(state), ['list', 'create']);
  assert.equal(state.comments.find((c) => c.id === 3).body, `${marker('plan:1')}\nplanted`);
  assert.equal(core.outputs['comment-id'], '1000');
});

test('recreate and delete only remove comments by comment-author', async () => {
  const comments = () => [existing(3, 'plan:1', 'planted', 'mallory'), existing(4, 'plan:1')];
  let r = await runWith(comments(), { PRP_MODE: 'recreate' });
  assert.equal(r.core.failed, null);
  assert.deepEqual(ops(r.state), ['list', 'delete:4', 'create']);

  r = await runWith(comments(), { PRP_MODE: 'delete' });
  assert.equal(r.core.failed, null);
  assert.deepEqual(ops(r.state), ['list', 'delete:4']);
  assert.deepEqual(r.state.comments.map((c) => c.id), [3]);
});

test('comment-author selects the PAT user comment and defaults to github-actions[bot]', async () => {
  const comments = [existing(3, 'plan:1', 'from bot'), existing(4, 'plan:1', 'from pat', 'svc-pat-user')];
  let r = await runWith(comments, { PRP_COMMENT_AUTHOR: ' SVC-PAT-User ' });
  assert.equal(r.core.failed, null);
  assert.deepEqual(ops(r.state), ['list', 'update:4']);

  for (const author of [undefined, '', ' ']) {
    r = await runWith(comments, { PRP_COMMENT_AUTHOR: author });
    assert.equal(r.core.failed, null);
    assert.deepEqual(ops(r.state), ['list', 'update:3'], `author ${JSON.stringify(author)}`);
  }

  r = await runWith(comments, { PRP_COMMENT_AUTHOR: '*' });
  assert.equal(r.core.failed, null);
  assert.deepEqual(ops(r.state), ['list', 'update:3', 'delete:4']);
});

test('invalid key fails before any API call', async () => {
  const { state, core } = await runWith([], { PRP_KEY: 'Plan One' });
  assert.match(core.failed, /^sticky-comment: invalid key "Plan One"/);
  assert.deepEqual(state.calls, []);
});

test('missing body fails for upsert and recreate', async () => {
  for (const mode of ['', 'upsert', 'recreate']) {
    const { state, core } = await runWith([], { PRP_MODE: mode, PRP_BODY: ' \n' });
    assert.match(core.failed, /body or body-file is required/);
    assert.deepEqual(state.calls, []);
  }
});

test('invalid pr-number, mode and max-length fail', async () => {
  const cases = [
    [{ PRP_PR_NUMBER: '' }, /pr-number must be a positive integer/],
    [{ PRP_PR_NUMBER: '7abc' }, /pr-number must be a positive integer/],
    [{ PRP_MODE: 'append' }, /mode must be one of upsert, recreate, delete/],
    [{ PRP_MAX_LENGTH: '-1' }, /max-length must be a positive integer/],
    [{ PRP_MAX_LENGTH: '10', PRP_BODY: 'x'.repeat(100) }, /max-length 10 is too small/],
  ];
  for (const [overrides, pattern] of cases) {
    const { state, core } = await runWith([], overrides);
    assert.match(core.failed, pattern);
    assert.deepEqual(ops(state), []);
  }
});

test('body-file takes precedence over body and resolves against the workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comments-test-'));
  fs.writeFileSync(path.join(dir, 'plan.md'), 'from file');
  const { state, core } = await runWith([], { PRP_BODY_FILE: 'plan.md', GITHUB_WORKSPACE: dir });
  assert.equal(core.failed, null);
  assert.equal(state.comments[0].body, `${marker('plan:1')}\nfrom file`);
  fs.rmSync(dir, { recursive: true });
});

test('unreadable body-file fails', async () => {
  const { state, core } = await runWith([], { PRP_BODY_FILE: '/nonexistent/plan.md' });
  assert.match(core.failed, /cannot read body-file \/nonexistent\/plan\.md/);
  assert.deepEqual(state.calls, []);
});

test('long bodies are truncated to max-length with the marker intact', async () => {
  const content = `FIRST LINE\n${'y'.repeat(200000)}\nLAST LINE`;
  const { state, core } = await runWith([], { PRP_BODY: content, PRP_MAX_LENGTH: '5000' });
  assert.equal(core.failed, null);
  const body = state.comments[0].body;
  assert.ok(body.length <= 5000, `got ${body.length}`);
  assert.ok(body.startsWith(`${marker('plan:1')}\nFIRST LINE\n`));
  assert.ok(body.endsWith('\nLAST LINE'));
  assert.match(body, /\n\.\.\. \d+ characters truncated, see the \[workflow run\]\(https:\/\/ghe\.example\/tri\/infra\/actions\/runs\/42\) for the full output \.\.\.\n/);
});

test('default max-length is 60000', async () => {
  const { state, core } = await runWith([], { PRP_BODY: 'z'.repeat(70000) });
  assert.equal(core.failed, null);
  assert.ok(state.comments[0].body.length <= 60000);
  assert.ok(state.comments[0].body.length >= 59990);
});

test('API errors fail closed with the status', async () => {
  let r = await runWith([], {}, { list: httpError(403, 'Resource not accessible by integration') });
  assert.equal(r.core.failed, 'sticky-comment: failed to list comments on PR #7 (403): Resource not accessible by integration');
  assert.equal(r.core.outputs['comment-id'], undefined);

  r = await runWith([], {}, { create: httpError(422, 'Body is too long') });
  assert.equal(r.core.failed, 'sticky-comment: failed to create comment on PR #7 (422): Body is too long');

  r = await runWith([existing(3, 'plan:1')], {}, { update: httpError(404, 'Not Found') });
  assert.equal(r.core.failed, 'sticky-comment: failed to update comment 3 (404): Not Found');

  r = await runWith([existing(3, 'plan:1'), existing(4, 'plan:1')], {}, { delete: httpError(500, 'Server Error') });
  assert.equal(r.core.failed, 'sticky-comment: failed to delete comment 4 (500): Server Error');

  r = await runWith([], {}, { list: new Error('socket hang up') });
  assert.equal(r.core.failed, 'sticky-comment: failed to list comments on PR #7 (no HTTP status): socket hang up');
});
