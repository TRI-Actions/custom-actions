'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const gate = require(path.join(__dirname, '..', 'lib', 'plan-gate.js'));

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const NAME = 'plan';
const COMPLETED_AT = '2026-10-01T12:00:00Z';

function checkRun(
  id,
  { externalId = null, status = 'completed', conclusion = 'success', title, name = NAME, completedAt = COMPLETED_AT } = {},
) {
  return {
    id,
    name,
    external_id: externalId,
    status,
    conclusion: status === 'completed' ? conclusion : null,
    completed_at: status === 'completed' ? completedAt : null,
    html_url: `https://ghes.example.com/acme/infra/runs/${id}`,
    output: { title: title === undefined ? null : title },
  };
}

function evaluate(runs, externalIds = ['*'], notAfter = null) {
  return gate.evaluate(runs, { sha: SHA, checkName: NAME, externalIds, notAfter });
}

function fakeCore() {
  return {
    outputs: {},
    failed: [],
    infos: [],
    setOutput(name, value) {
      this.outputs[name] = value;
    },
    setFailed(message) {
      this.failed.push(message);
    },
    info(message) {
      this.infos.push(message);
    },
  };
}

function fakeGithub({ runs = [], error } = {}) {
  const calls = [];
  const listForRef = async () => {
    throw new Error('listForRef must be called through paginate');
  };
  return {
    calls,
    listForRef,
    paginate: async (method, params) => {
      calls.push({ method, params });
      if (error) throw error;
      return runs;
    },
    rest: { checks: { listForRef } },
  };
}

const context = { repo: { owner: 'acme', repo: 'infra' } };

test('parseList splits on any whitespace and drops empties', () => {
  assert.deepEqual(gate.parseList(''), []);
  assert.deepEqual(gate.parseList(undefined), []);
  assert.deepEqual(gate.parseList('  a\n b\t\tc  '), ['a', 'b', 'c']);
});

test('older success and newer failure fails', () => {
  const result = evaluate(
    [
      checkRun(10, { externalId: 'prod' }),
      checkRun(20, { externalId: 'prod', conclusion: 'failure', title: 'Plan failed.' }),
    ],
    ['prod'],
  );
  assert.equal(result.passed, false);
  assert.equal(
    result.reason,
    'The latest plan for prod on commit abcdef0 ended with failure (Plan failed). See [the plan check](https://ghes.example.com/acme/infra/runs/20).',
  );
  assert.equal(result.checkUrl, 'https://ghes.example.com/acme/infra/runs/20');
});

test('newest is chosen by highest id regardless of order', () => {
  const result = evaluate(
    [
      checkRun(30, { externalId: 'prod', conclusion: 'failure' }),
      checkRun(5, { externalId: 'prod' }),
    ],
    ['prod'],
  );
  assert.equal(result.passed, false);
  assert.equal(
    result.reason,
    'The latest plan for prod on commit abcdef0 ended with failure. See [the plan check](https://ghes.example.com/acme/infra/runs/30).',
  );
});

test('older failure and newer success passes', () => {
  const result = evaluate(
    [checkRun(20, { externalId: 'prod' }), checkRun(10, { externalId: 'prod', conclusion: 'failure' })],
    ['prod'],
  );
  assert.deepEqual(result, {
    passed: true,
    reason: '',
    checkUrl: 'https://ghes.example.com/acme/infra/runs/20',
  });
});

test('a newer in-progress run blocks even when an older run succeeded', () => {
  for (const status of ['in_progress', 'queued']) {
    const result = evaluate(
      [checkRun(10, { externalId: 'prod' }), checkRun(20, { externalId: 'prod', status })],
      ['prod'],
    );
    assert.deepEqual(
      result,
      {
        passed: false,
        reason:
          'The plan for prod on commit abcdef0 is still running. Wait for the `plan` check to complete, then try again.',
        checkUrl: 'https://ghes.example.com/acme/infra/runs/20',
      },
      status,
    );
  }
});

test('an orphaned older run that never completed is ignored when a newer run succeeded', () => {
  for (const status of ['in_progress', 'queued']) {
    const result = evaluate(
      [checkRun(20, { externalId: 'prod' }), checkRun(10, { externalId: 'prod', status })],
      ['prod'],
    );
    assert.deepEqual(
      result,
      { passed: true, reason: '', checkUrl: 'https://ghes.example.com/acme/infra/runs/20' },
      status,
    );
  }
});

test('an orphaned older run does not hide a newer failure', () => {
  const result = evaluate(
    [
      checkRun(10, { externalId: 'prod', status: 'in_progress' }),
      checkRun(20, { externalId: 'prod', conclusion: 'failure' }),
    ],
    ['prod'],
  );
  assert.equal(result.passed, false);
  assert.match(result.reason, /^The latest plan for prod on commit abcdef0 ended with failure\./);
});

test('a cancelled newest run blocks', () => {
  const result = evaluate(
    [checkRun(10, { externalId: 'prod' }), checkRun(11, { externalId: 'prod', conclusion: 'cancelled' })],
    ['prod'],
  );
  assert.equal(result.passed, false);
  assert.match(result.reason, /ended with cancelled\./);
});

test('runs with a foreign external_id are ignored', () => {
  const result = evaluate(
    [
      checkRun(10, { externalId: 'prod' }),
      checkRun(20, { externalId: 'staging', conclusion: 'failure' }),
      checkRun(30, { externalId: 'dev', status: 'in_progress' }),
    ],
    ['prod'],
  );
  assert.equal(result.passed, true);
  assert.equal(result.checkUrl, 'https://ghes.example.com/acme/infra/runs/10');
});

test('runs with a different check name are ignored', () => {
  const result = evaluate([checkRun(10, { externalId: 'prod', name: 'apply' })], ['prod']);
  assert.equal(result.passed, false);
  assert.match(result.reason, /^No `plan` check for prod/);
});

test('a missing external id fails with a re-plan hint', () => {
  const result = evaluate([checkRun(10, { externalId: 'staging' })], ['prod']);
  assert.deepEqual(result, {
    passed: false,
    reason:
      'No `plan` check for prod on commit abcdef0. Push a commit or close and reopen the PR to re-plan.',
    checkUrl: '',
  });
});

test('every external id is required', () => {
  const runs = [checkRun(10, { externalId: 'prod' }), checkRun(11, { externalId: 'staging' })];
  assert.equal(evaluate(runs, ['prod', 'staging']).passed, true);
  assert.equal(
    evaluate(runs, ['prod', 'staging']).checkUrl,
    'https://ghes.example.com/acme/infra/runs/10',
  );

  const missing = evaluate(runs, ['prod', 'staging', 'dev']);
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /^No `plan` check for dev on commit abcdef0\./);

  const failed = evaluate(
    [...runs, checkRun(12, { externalId: 'staging', conclusion: 'failure' })],
    ['prod', 'staging'],
  );
  assert.equal(failed.passed, false);
  assert.match(failed.reason, /^The latest plan for staging/);
});

test('"*" matches by check name only, with any or no external_id', () => {
  const pass = evaluate([checkRun(10, { externalId: 'whatever' }), checkRun(5)]);
  assert.equal(pass.passed, true);
  assert.equal(pass.checkUrl, 'https://ghes.example.com/acme/infra/runs/10');

  const noId = evaluate([checkRun(7)]);
  assert.equal(noId.passed, true);
  assert.equal(noId.checkUrl, 'https://ghes.example.com/acme/infra/runs/7');

  const newestAcrossIds = evaluate([
    checkRun(10, { externalId: 'prod' }),
    checkRun(11, { externalId: 'staging', conclusion: 'failure' }),
  ]);
  assert.equal(newestAcrossIds.passed, false);
  assert.match(newestAcrossIds.reason, /^The latest plan on commit abcdef0 ended with failure\./);

  const otherName = evaluate([checkRun(10, { name: 'apply' })]);
  assert.equal(otherName.passed, false);
  assert.match(otherName.reason, /^No `plan` check on commit abcdef0\./);

  const literalStar = evaluate([checkRun(10, { externalId: 'prod' })], ['prod']);
  assert.equal(literalStar.passed, true);

  const missing = evaluate([]);
  assert.equal(
    missing.reason,
    'No `plan` check on commit abcdef0. Push a commit or close and reopen the PR to re-plan.',
  );

  const running = evaluate([checkRun(10, { status: 'in_progress' })]);
  assert.match(running.reason, /^The plan on commit abcdef0 is still running\./);

  const failed = evaluate([checkRun(10), checkRun(11, { conclusion: 'timed_out', title: 'Timed out' })]);
  assert.match(failed.reason, /^The latest plan on commit abcdef0 ended with timed_out \(Timed out\)\./);
});

test('evaluate refuses an empty external id list instead of passing vacuously', () => {
  for (const externalIds of [[], undefined]) {
    assert.throws(
      () => gate.evaluate([checkRun(10)], { sha: SHA, checkName: NAME, externalIds }),
      /externalIds must list at least one external id/,
    );
  }
});

const NOT_AFTER_REASON =
  'The plan for prod on commit abcdef0 finished after the command was posted, so it may include changes made ' +
  'after you commented. Review the latest plan and post the command again.';

test('not-after passes a plan that completed before the command', () => {
  const result = evaluate(
    [checkRun(10, { externalId: 'prod', completedAt: '2026-10-01T11:59:59Z' })],
    ['prod'],
    Date.parse('2026-10-01T12:00:00Z'),
  );
  assert.deepEqual(result, { passed: true, reason: '', checkUrl: 'https://ghes.example.com/acme/infra/runs/10' });
});

test('not-after passes a plan that completed at the same instant as the command', () => {
  const result = evaluate(
    [checkRun(10, { externalId: 'prod', completedAt: '2026-10-01T12:00:00Z' })],
    ['prod'],
    gate.parseTimestamp('2026-10-01T14:00:00+02:00'),
  );
  assert.equal(result.passed, true);
});

test('not-after blocks a plan that completed after the command', () => {
  const result = evaluate(
    [
      checkRun(10, { externalId: 'prod', completedAt: '2026-10-01T11:00:00Z' }),
      checkRun(20, { externalId: 'prod', completedAt: '2026-10-01T12:00:01Z' }),
    ],
    ['prod'],
    Date.parse('2026-10-01T12:00:00Z'),
  );
  assert.deepEqual(result, {
    passed: false,
    reason: NOT_AFTER_REASON,
    checkUrl: 'https://ghes.example.com/acme/infra/runs/20',
  });
});

test('not-after is checked for every external id and in "*" mode', () => {
  const notAfter = Date.parse('2026-10-01T12:00:00Z');
  const late = evaluate(
    [
      checkRun(10, { externalId: 'staging', completedAt: '2026-10-01T11:00:00Z' }),
      checkRun(11, { externalId: 'prod', completedAt: '2026-10-01T13:00:00Z' }),
    ],
    ['staging', 'prod'],
    notAfter,
  );
  assert.equal(late.passed, false);
  assert.equal(late.reason, NOT_AFTER_REASON);
  assert.equal(late.checkUrl, 'https://ghes.example.com/acme/infra/runs/11');

  const any = evaluate([checkRun(10, { completedAt: '2026-10-01T13:00:00Z' })], ['*'], notAfter);
  assert.equal(any.passed, false);
  assert.match(any.reason, /^The plan on commit abcdef0 finished after the command was posted, /);
});

test('not-after blocks a completed plan without a usable completed_at', () => {
  const missing = checkRun(10, { externalId: 'prod' });
  delete missing.completed_at;
  const runs = [null, '', 'yesterday']
    .map((completedAt) => checkRun(10, { externalId: 'prod', completedAt }))
    .concat([missing]);
  for (const run of runs) {
    const result = evaluate([run], ['prod'], Date.parse('2026-10-01T12:00:00Z'));
    assert.equal(result.passed, false, String(run.completed_at));
    assert.equal(result.reason, NOT_AFTER_REASON, String(run.completed_at));
  }
});

test('not-after does not hide a failed or running plan', () => {
  const notAfter = Date.parse('2026-10-01T12:00:00Z');
  const failed = evaluate(
    [checkRun(10, { externalId: 'prod', conclusion: 'failure', completedAt: '2026-10-01T13:00:00Z' })],
    ['prod'],
    notAfter,
  );
  assert.match(failed.reason, /^The latest plan for prod on commit abcdef0 ended with failure\./);

  const running = evaluate([checkRun(10, { externalId: 'prod', status: 'in_progress' })], ['prod'], notAfter);
  assert.match(running.reason, /^The plan for prod on commit abcdef0 is still running\./);
});

test('parseTimestamp accepts ISO 8601 timestamps with a time zone', () => {
  assert.equal(gate.parseTimestamp('2026-10-01T12:00:00Z'), Date.UTC(2026, 9, 1, 12, 0, 0));
  assert.equal(gate.parseTimestamp('2026-10-01T12:00:00.250Z'), Date.UTC(2026, 9, 1, 12, 0, 0, 250));
  assert.equal(gate.parseTimestamp('2026-10-01T14:30:00+02:30'), Date.UTC(2026, 9, 1, 12, 0, 0));
  assert.equal(gate.parseTimestamp('2026-10-01T07:00:00-05:00'), Date.UTC(2026, 9, 1, 12, 0, 0));
  assert.equal(gate.parseTimestamp('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29));
});

test('parseTimestamp rejects anything else', () => {
  for (const value of [
    '',
    undefined,
    'yesterday',
    '1790856000',
    '2026-10-01',
    '2026-10-01T12:00:00',
    '2026-10-01 12:00:00Z',
    'Thu, 01 Oct 2026 12:00:00 GMT',
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-01T24:00:00Z',
    '2026-10-01T12:60:00Z',
    '2026-10-01T12:00:60Z',
    '2026-10-01T12:00:00+24:00',
    '2026-10-01T12:00:00+05:60',
    ' 2026-10-01T12:00:00Z',
  ]) {
    assert.ok(Number.isNaN(gate.parseTimestamp(value)), String(value));
  }
});

test('run lists check runs through paginate and sets outputs', async () => {
  const core = fakeCore();
  const github = fakeGithub({ runs: [checkRun(10, { externalId: 'a' }), checkRun(11, { externalId: 'b' })] });
  await gate.run({
    github,
    context,
    core,
    env: { PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'a\nb' },
  });
  assert.equal(github.calls.length, 1);
  assert.equal(github.calls[0].method, github.listForRef);
  assert.deepEqual(github.calls[0].params, {
    owner: 'acme',
    repo: 'infra',
    ref: SHA,
    check_name: NAME,
    filter: 'all',
    per_page: 100,
  });
  assert.deepEqual(core.failed, []);
  assert.deepEqual(core.outputs, {
    passed: 'true',
    reason: '',
    'check-url': 'https://ghes.example.com/acme/infra/runs/10',
  });
});

test('run reports a blocked gate through outputs without failing the step', async () => {
  const core = fakeCore();
  const github = fakeGithub({ runs: [] });
  await gate.run({ github, context, core, env: { PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'a' } });
  assert.deepEqual(core.failed, []);
  assert.equal(core.outputs.passed, 'false');
  assert.match(core.outputs.reason, /^No `plan` check for a/);
  assert.equal(core.outputs['check-url'], '');
});

test('run applies not-after and accepts an uppercase sha', async () => {
  const runs = [checkRun(10, { externalId: 'prod', completedAt: '2026-10-01T12:00:05Z' })];
  const upper = SHA.toUpperCase();

  const late = fakeCore();
  const lateGithub = fakeGithub({ runs });
  await gate.run({
    github: lateGithub,
    context,
    core: late,
    env: { PRP_SHA: upper, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod', PRP_NOT_AFTER: ' 2026-10-01T12:00:00Z ' },
  });
  assert.deepEqual(late.failed, []);
  assert.equal(lateGithub.calls[0].params.ref, upper);
  assert.deepEqual(late.outputs, {
    passed: 'false',
    reason: NOT_AFTER_REASON.replace('abcdef0', 'ABCDEF0'),
    'check-url': 'https://ghes.example.com/acme/infra/runs/10',
  });

  const onTime = fakeCore();
  await gate.run({
    github: fakeGithub({ runs }),
    context,
    core: onTime,
    env: { PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod', PRP_NOT_AFTER: '2026-10-01T12:00:05Z' },
  });
  assert.deepEqual(onTime.failed, []);
  assert.equal(onTime.outputs.passed, 'true');

  const unset = fakeCore();
  await gate.run({
    github: fakeGithub({ runs }),
    context,
    core: unset,
    env: { PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod', PRP_NOT_AFTER: '' },
  });
  assert.equal(unset.outputs.passed, 'true');
});

test('run matches by check name only with external-ids "*"', async () => {
  const core = fakeCore();
  const github = fakeGithub({ runs: [checkRun(10), checkRun(11, { externalId: 'prod' })] });
  await gate.run({ github, context, core, env: { PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: ' * ' } });
  assert.deepEqual(core.failed, []);
  assert.equal(core.outputs.passed, 'true');
  assert.equal(core.outputs['check-url'], 'https://ghes.example.com/acme/infra/runs/11');
});

async function runInvalid(env) {
  const core = fakeCore();
  const github = fakeGithub({ runs: [checkRun(10, { externalId: 'prod' })] });
  await gate.run({ github, context, core, env });
  assert.equal(github.calls.length, 0, 'no API call on bad configuration');
  assert.equal(core.failed.length, 1);
  assert.deepEqual(core.outputs, { passed: 'false', reason: core.failed[0], 'check-url': '' });
  return core.failed[0];
}

test('run fails the step on a sha that is not a full commit SHA, before any API call', async () => {
  for (const sha of [
    '',
    'abcdef0',
    `${SHA}0`,
    SHA.slice(0, 39),
    `${SHA.slice(0, 39)}g`,
    'HEAD',
    'refs/heads/main',
    `${SHA.slice(0, 20)} ${SHA.slice(21)}`,
    '0'.repeat(64),
  ]) {
    const message = await runInvalid({ PRP_SHA: sha, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod' });
    assert.equal(message, `Input "sha" must be a full 40-character commit SHA, got ${JSON.stringify(sha.trim())}.`);
  }
});

test('run fails the step when external-ids is empty', async () => {
  for (const ids of [undefined, '', '  \n\t ']) {
    const message = await runInvalid({ PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: ids });
    assert.equal(
      message,
      'Input "external-ids" is required: list the external ids that each need a successful plan, ' +
        'or pass "*" to match by check name only.',
    );
  }
});

test('run fails the step when "*" is combined with other external ids', async () => {
  const message = await runInvalid({ PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod\n*' });
  assert.equal(message, 'Input "external-ids" must be either "*" alone or a list of external ids, got "prod *".');
});

test('run fails the step on an invalid not-after', async () => {
  for (const notAfter of ['yesterday', '2026-10-01', '2026-10-01T12:00:00', '2026-02-30T00:00:00Z', '1790856000']) {
    const message = await runInvalid({
      PRP_SHA: SHA,
      PRP_CHECK_NAME: NAME,
      PRP_EXTERNAL_IDS: 'prod',
      PRP_NOT_AFTER: notAfter,
    });
    assert.equal(
      message,
      'Input "not-after" must be an ISO 8601 timestamp with a time zone, such as 2026-10-01T12:00:00Z, ' +
        `got ${JSON.stringify(notAfter)}.`,
    );
  }
});

test('run fails closed on an API error', async () => {
  const err = new Error('Bad credentials');
  err.status = 401;
  const core = fakeCore();
  const github = fakeGithub({ error: err });
  await gate.run({ github, context, core, env: { PRP_SHA: SHA, PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod' } });
  assert.equal(core.failed.length, 1);
  assert.match(core.failed[0], /HTTP 401 Bad credentials/);
  assert.equal(core.outputs.passed, 'false');
  assert.equal(core.outputs.reason, core.failed[0]);
});

test('run fails when required inputs are missing', async () => {
  for (const env of [
    { PRP_CHECK_NAME: NAME, PRP_EXTERNAL_IDS: 'prod' },
    { PRP_SHA: SHA, PRP_CHECK_NAME: ' ', PRP_EXTERNAL_IDS: 'prod' },
    { PRP_SHA: SHA, PRP_EXTERNAL_IDS: 'prod' },
  ]) {
    await runInvalid(env);
  }
});
