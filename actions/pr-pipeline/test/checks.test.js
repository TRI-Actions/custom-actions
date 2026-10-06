'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checks = require(path.join(__dirname, '..', 'lib', 'checks.js'));

const SHA = '0123456789abcdef0123456789abcdef01234567';

function fakeCore() {
  return {
    outputs: {},
    failed: [],
    notices: [],
    warnings: [],
    infos: [],
    setOutput(name, value) {
      this.outputs[name] = value;
    },
    setFailed(message) {
      this.failed.push(message);
    },
    notice(message) {
      this.notices.push(message);
    },
    warning(message) {
      this.warnings.push(message);
    },
    info(message) {
      this.infos.push(message);
    },
  };
}

function fakeGithub({ createError, updateError, createdId = 777 } = {}) {
  const calls = { create: [], update: [] };
  return {
    calls,
    paginate: async () => {
      throw new Error('paginate is not used by check-run');
    },
    rest: {
      checks: {
        create: async (params) => {
          calls.create.push(params);
          if (createError) throw createError;
          return { data: { id: createdId } };
        },
        update: async (params) => {
          calls.update.push(params);
          if (updateError) throw updateError;
          return { data: { id: params.check_run_id } };
        },
      },
    },
  };
}

const context = {
  repo: { owner: 'acme', repo: 'infra' },
  serverUrl: 'https://ghes.example.com',
  runId: 4242,
};

function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function tempFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-test-'));
  const file = path.join(dir, 'summary.md');
  fs.writeFileSync(file, content);
  return file;
}

test('truncateSummary leaves short and exact-limit text unchanged', () => {
  assert.equal(checks.truncateSummary('hello'), 'hello');
  const exact = 'a'.repeat(checks.MAX_SUMMARY_BYTES);
  assert.equal(checks.truncateSummary(exact), exact);
});

test('truncateSummary cuts long text to the limit with a trailing note', () => {
  const out = checks.truncateSummary('a'.repeat(checks.MAX_SUMMARY_BYTES + 1));
  assert.ok(out.endsWith(checks.TRUNCATION_NOTE));
  assert.equal(Buffer.byteLength(out, 'utf8'), checks.MAX_SUMMARY_BYTES);
});

test('truncateSummary never splits a multibyte character', () => {
  // 3-byte characters: the byte budget does not land on a character boundary.
  const out = checks.truncateSummary('€'.repeat(30000));
  assert.ok(Buffer.byteLength(out, 'utf8') <= checks.MAX_SUMMARY_BYTES);
  assert.ok(out.endsWith(checks.TRUNCATION_NOTE));
  assert.ok(!out.includes('\uFFFD'));
  const body = out.slice(0, -checks.TRUNCATION_NOTE.length);
  assert.match(body, /^€+$/);
});

test('invalid mode fails', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({ github, context, core, env: { PRP_MODE: 'begin' } });
  assert.equal(core.failed.length, 1);
  assert.match(core.failed[0], /Invalid mode "begin"/);
  assert.equal(github.calls.create.length, 0);
  assert.equal(github.calls.update.length, 0);
});

test('start creates an in_progress check run and outputs its id', async () => {
  const core = fakeCore();
  const github = fakeGithub({ createdId: 123 });
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'start', PRP_NAME: 'plan', PRP_SHA: SHA },
  });
  assert.deepEqual(core.failed, []);
  assert.deepEqual(github.calls.create, [
    {
      owner: 'acme',
      repo: 'infra',
      name: 'plan',
      head_sha: SHA,
      status: 'in_progress',
      details_url: 'https://ghes.example.com/acme/infra/actions/runs/4242',
    },
  ]);
  assert.equal(core.outputs.id, '123');
});

test('start passes external_id and output when set', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: {
      PRP_MODE: 'start',
      PRP_NAME: 'plan',
      PRP_SHA: SHA,
      PRP_EXTERNAL_ID: 'prod-stack',
      PRP_TITLE: 'Planning',
      PRP_SUMMARY: 'Running terraform plan',
    },
  });
  const params = github.calls.create[0];
  assert.equal(params.external_id, 'prod-stack');
  assert.deepEqual(params.output, { title: 'Planning', summary: 'Running terraform plan' });
});

test('start without title omits output and warns about an ignored summary', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'start', PRP_NAME: 'plan', PRP_SHA: SHA, PRP_SUMMARY: 'ignored' },
  });
  assert.ok(!('output' in github.calls.create[0]));
  assert.ok(!('external_id' in github.calls.create[0]));
  assert.equal(core.warnings.length, 1);
});

test('start with title but no summary uses the title as summary', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'start', PRP_NAME: 'plan', PRP_SHA: SHA, PRP_TITLE: 'Planning' },
  });
  assert.deepEqual(github.calls.create[0].output, { title: 'Planning', summary: 'Planning' });
});

test('start requires name and sha', async () => {
  for (const env of [
    { PRP_MODE: 'start', PRP_SHA: SHA },
    { PRP_MODE: 'start', PRP_NAME: 'plan', PRP_SHA: '  ' },
  ]) {
    const core = fakeCore();
    const github = fakeGithub();
    await checks.run({ github, context, core, env });
    assert.equal(core.failed.length, 1);
    assert.equal(github.calls.create.length, 0);
    assert.ok(!('id' in core.outputs));
  }
});

test('start API error fails with the status and sets no id', async () => {
  const core = fakeCore();
  const github = fakeGithub({ createError: apiError(403, 'Resource not accessible by integration') });
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'start', PRP_NAME: 'plan', PRP_SHA: SHA },
  });
  assert.equal(core.failed.length, 1);
  assert.match(core.failed[0], /HTTP 403/);
  assert.match(core.failed[0], /Resource not accessible by integration/);
  assert.ok(!('id' in core.outputs));
});

test('finish with an empty id does nothing and succeeds', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: '', PRP_CONCLUSION: 'success' },
  });
  assert.deepEqual(core.failed, []);
  assert.equal(core.notices.length, 1);
  assert.equal(github.calls.update.length, 0);
});

test('finish with an empty id ignores an invalid conclusion', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({ github, context, core, env: { PRP_MODE: 'finish', PRP_CONCLUSION: 'bogus' } });
  assert.deepEqual(core.failed, []);
  assert.equal(github.calls.update.length, 0);
});

test('finish rejects an invalid conclusion without calling the API', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: '55', PRP_CONCLUSION: 'passed' },
  });
  assert.equal(core.failed.length, 1);
  assert.match(core.failed[0], /Invalid conclusion "passed"/);
  assert.equal(github.calls.update.length, 0);
});

test('finish rejects a non-numeric id', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: 'abc', PRP_CONCLUSION: 'success' },
  });
  assert.equal(core.failed.length, 1);
  assert.equal(github.calls.update.length, 0);
});

test('finish accepts every valid conclusion', async () => {
  for (const conclusion of checks.CONCLUSIONS) {
    const core = fakeCore();
    const github = fakeGithub();
    await checks.run({
      github,
      context,
      core,
      env: { PRP_MODE: 'finish', PRP_ID: '9', PRP_CONCLUSION: conclusion },
    });
    assert.deepEqual(core.failed, [], conclusion);
    assert.equal(github.calls.update[0].conclusion, conclusion);
  }
});

test('finish completes the check run with defaults', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: '55', PRP_CONCLUSION: 'failure', PRP_SUMMARY: 'Plan failed' },
  });
  assert.deepEqual(core.failed, []);
  const params = github.calls.update[0];
  assert.equal(params.owner, 'acme');
  assert.equal(params.repo, 'infra');
  assert.equal(params.check_run_id, 55);
  assert.equal(params.status, 'completed');
  assert.equal(params.conclusion, 'failure');
  assert.equal(new Date(params.completed_at).toISOString(), params.completed_at);
  assert.deepEqual(params.output, { title: 'failure', summary: 'Plan failed' });
  assert.equal(core.outputs.id, '55');
});

test('finish uses the given title and a default summary when none is given', async () => {
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: '55', PRP_CONCLUSION: 'success', PRP_TITLE: 'No changes' },
  });
  assert.deepEqual(github.calls.update[0].output, {
    title: 'No changes',
    summary: 'Concluded with success.',
  });
});

test('finish reads the summary from summary-file over summary', async () => {
  const file = tempFile('## Plan\n\n3 to add');
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: {
      PRP_MODE: 'finish',
      PRP_ID: '55',
      PRP_CONCLUSION: 'success',
      PRP_SUMMARY: 'inline',
      PRP_SUMMARY_FILE: file,
    },
  });
  assert.equal(github.calls.update[0].output.summary, '## Plan\n\n3 to add');
});

test('finish resolves a relative summary-file against GITHUB_WORKSPACE', async () => {
  const file = tempFile('relative plan');
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: {
      PRP_MODE: 'finish',
      PRP_ID: '55',
      PRP_CONCLUSION: 'success',
      PRP_SUMMARY_FILE: path.basename(file),
      GITHUB_WORKSPACE: path.dirname(file),
    },
  });
  assert.deepEqual(core.warnings, []);
  assert.equal(github.calls.update[0].output.summary, 'relative plan');
});

test('finish truncates a long summary-file', async () => {
  const file = tempFile('x'.repeat(checks.MAX_SUMMARY_BYTES * 2));
  const core = fakeCore();
  const github = fakeGithub();
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: '55', PRP_CONCLUSION: 'success', PRP_SUMMARY_FILE: file },
  });
  const summary = github.calls.update[0].output.summary;
  assert.equal(summary.length, checks.MAX_SUMMARY_BYTES);
  assert.ok(summary.endsWith(checks.TRUNCATION_NOTE));
});

test('finish still completes the check run when summary-file is missing', async () => {
  const missing = path.join(os.tmpdir(), 'does-not-exist', 'summary.md');
  for (const [summary, expected] of [
    ['inline fallback', 'inline fallback'],
    ['', `Summary file \`${missing}\` could not be read.`],
  ]) {
    const core = fakeCore();
    const github = fakeGithub();
    await checks.run({
      github,
      context,
      core,
      env: {
        PRP_MODE: 'finish',
        PRP_ID: '55',
        PRP_CONCLUSION: 'cancelled',
        PRP_SUMMARY: summary,
        PRP_SUMMARY_FILE: missing,
      },
    });
    assert.deepEqual(core.failed, []);
    assert.equal(core.warnings.length, 1);
    assert.equal(github.calls.update[0].output.summary, expected);
  }
});

test('finish API error fails with the status', async () => {
  const core = fakeCore();
  const github = fakeGithub({ updateError: apiError(404, 'Not Found') });
  await checks.run({
    github,
    context,
    core,
    env: { PRP_MODE: 'finish', PRP_ID: '55', PRP_CONCLUSION: 'success' },
  });
  assert.equal(core.failed.length, 1);
  assert.match(core.failed[0], /check run 55: HTTP 404 Not Found/);
  assert.ok(!('id' in core.outputs));
});
