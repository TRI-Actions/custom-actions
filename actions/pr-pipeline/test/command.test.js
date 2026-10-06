'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ARG_PATTERN,
  compileArgPattern,
  sanitizeForMessage,
  describeArgCount,
  parseCommand,
  loadConfig,
  run,
} = require('../lib/command.js');

const ACCOUNT = '^\\d{12}$';

function deploy(body, overrides = {}) {
  return parseCommand(body, {
    command: '!deploy',
    argPattern: compileArgPattern(ACCOUNT),
    minArgs: 1,
    maxArgs: 1,
    ...overrides,
  });
}

function fakeCore() {
  const outputs = {};
  const failures = [];
  return {
    outputs,
    failures,
    setOutput(name, value) {
      outputs[name] = value;
    },
    setFailed(message) {
      failures.push(message);
    },
    info() {},
    warning() {},
    debug() {},
  };
}

async function runWith(env) {
  const core = fakeCore();
  await run({ github: {}, context: {}, core, env });
  return core;
}

const NOT_MATCHED = { matched: false, valid: false, args: [], error: '' };

test('valid command with one argument', () => {
  assert.deepEqual(deploy('!deploy 123456789012'), {
    matched: true,
    valid: true,
    args: ['123456789012'],
    error: '',
  });
});

test('CRLF line endings are stripped', () => {
  assert.deepEqual(deploy('!deploy 123456789012\r\n\r\nthanks\r\n').args, ['123456789012']);
});

test('leading blank and whitespace-only lines are skipped', () => {
  assert.deepEqual(deploy('\n\r\n   \n\t\n  !deploy 123456789012  \n').args, ['123456789012']);
});

test('Reviewable trailer lines after the command are ignored', () => {
  const body = [
    '!deploy 123456789012',
    '',
    '---',
    '',
    '*Comments from [Reviewable](https://reviewable.io/reviews/org/repo/12)*',
    '<!-- Sent from Reviewable.io -->',
  ].join('\n');
  assert.equal(deploy(body).valid, true);
});

test('command not on the first non-empty line is not matched', () => {
  assert.deepEqual(deploy('LGTM\n!deploy 123456789012'), NOT_MATCHED);
});

test('command quoted in backticks is not matched', () => {
  assert.deepEqual(deploy('`!deploy 123456789012`'), NOT_MATCHED);
});

test('command match is case-sensitive', () => {
  assert.deepEqual(deploy('!Deploy 123456789012'), NOT_MATCHED);
  assert.deepEqual(deploy('!DEPLOY 123456789012'), NOT_MATCHED);
});

test('command with a suffix is not matched', () => {
  assert.deepEqual(deploy('!deployx 123456789012'), NOT_MATCHED);
  assert.deepEqual(deploy('!deploy123456789012'), NOT_MATCHED);
});

test('quoted reply of the command is not matched', () => {
  assert.deepEqual(deploy('> !deploy 123456789012'), NOT_MATCHED);
});

test('extra spaces and tabs between tokens are tolerated', () => {
  assert.deepEqual(deploy('  !deploy \t  123456789012\t ').args, ['123456789012']);
});

test('shell injection arguments are rejected by a 12-digit pattern', () => {
  for (const arg of ['$(echo', '123456789012;', ';', '`id`', '12345678901', '1234567890123', '12345678901a']) {
    const result = deploy(`!deploy ${arg}`);
    assert.equal(result.matched, true, arg);
    assert.equal(result.valid, false, arg);
    assert.deepEqual(result.args, [], arg);
    assert.match(result.error, /^Invalid argument `/, arg);
  }
});

test('$(echo x) splits into two tokens and is rejected', () => {
  const result = deploy('!deploy $(echo x)');
  assert.equal(result.valid, false);
  assert.equal(result.error, '`!deploy` takes exactly 1 argument, got 2');

  const single = deploy('!deploy $(echo x)', { maxArgs: 2 });
  assert.equal(single.valid, false);
  assert.equal(single.error, 'Invalid argument `$(echo`');
});

test('too many arguments', () => {
  const result = deploy('!deploy 123456789012 123456789013');
  assert.deepEqual(result, {
    matched: true,
    valid: false,
    args: [],
    error: '`!deploy` takes exactly 1 argument, got 2',
  });
});

test('too few arguments', () => {
  assert.equal(deploy('!deploy').error, '`!deploy` takes exactly 1 argument, got 0');
  assert.equal(deploy('!deploy\n123456789012').error, '`!deploy` takes exactly 1 argument, got 0');
});

test('argument count wording adapts to min and max', () => {
  assert.equal(describeArgCount('!merge', 0, 0, 1), '`!merge` takes no arguments, got 1');
  assert.equal(describeArgCount('!deploy', 2, 2, 1), '`!deploy` takes exactly 2 arguments, got 1');
  assert.equal(describeArgCount('!deploy', 0, 1, 2), '`!deploy` takes at most 1 argument, got 2');
  assert.equal(describeArgCount('!deploy', 0, 3, 4), '`!deploy` takes at most 3 arguments, got 4');
  assert.equal(describeArgCount('!deploy', 1, 3, 0), '`!deploy` takes between 1 and 3 arguments, got 0');
});

test('command without arguments when none are allowed', () => {
  const result = deploy('!merge', { command: '!merge', minArgs: 0, maxArgs: 0 });
  assert.deepEqual(result, { matched: true, valid: true, args: [], error: '' });
  assert.equal(deploy('!merge now', { command: '!merge', minArgs: 0, maxArgs: 0 }).error, '`!merge` takes no arguments, got 1');
});

test('empty, whitespace-only and missing bodies are not matched', () => {
  assert.deepEqual(deploy(''), NOT_MATCHED);
  assert.deepEqual(deploy(' \r\n\t\n'), NOT_MATCHED);
  assert.deepEqual(deploy(undefined), NOT_MATCHED);
});

test('error text sanitizes backticks and control characters', () => {
  const result = deploy('!deploy 12`3\u0007\u001b[31m\u202e\u200b45\u009b');
  assert.equal(result.error, 'Invalid argument `123[31m45`');
});

test('error text caps long arguments at 60 characters', () => {
  const long = 'a'.repeat(200);
  const result = deploy(`!deploy ${long}`);
  const shown = result.error.slice('Invalid argument `'.length, -1);
  assert.equal(shown.length, 60);
  assert.ok(shown.endsWith('...'));
  assert.equal(sanitizeForMessage('a'.repeat(60)), 'a'.repeat(60));
  assert.equal(sanitizeForMessage('\u{1F600}'.repeat(70)), `${'\u{1F600}'.repeat(57)}...`);
});

test('an unanchored arg-pattern must match the whole argument', () => {
  const argPattern = compileArgPattern('[0-9]{12}');
  assert.equal(deploy('!deploy 123456789012', { argPattern }).valid, true);
  for (const arg of ['123456789012x', 'x123456789012', '1234567890123', '123456789012\u200b']) {
    const result = deploy(`!deploy ${arg}`, { argPattern });
    assert.equal(result.valid, false, arg);
    assert.match(result.error, /^Invalid argument `/, arg);
  }
});

test('already-anchored arg-patterns still work', () => {
  for (const source of ['^[0-9]{12}$', '^[0-9]{12}', '[0-9]{12}$', '^\\d{12}$']) {
    const argPattern = compileArgPattern(source);
    assert.equal(argPattern.source, source.includes('\\d') ? '^(?:\\d{12})$' : '^(?:[0-9]{12})$', source);
    assert.equal(argPattern.flags, 'u', source);
    assert.equal(deploy('!deploy 123456789012', { argPattern }).valid, true, source);
    assert.equal(deploy('!deploy 123456789012x', { argPattern }).valid, false, source);
    assert.equal(deploy('!deploy x123456789012', { argPattern }).valid, false, source);
  }
});

test('arg-pattern alternation is anchored as a whole', () => {
  for (const source of ['dev|prod', '^dev|prod$']) {
    const argPattern = compileArgPattern(source);
    for (const arg of ['dev', 'prod']) assert.equal(deploy(`!deploy ${arg}`, { argPattern }).valid, true, `${source} ${arg}`);
    for (const arg of ['devx', 'xprod', 'xdev', 'prodx']) {
      assert.equal(deploy(`!deploy ${arg}`, { argPattern }).valid, false, `${source} ${arg}`);
    }
  }
});

test('an escaped trailing dollar stays literal', () => {
  const literal = compileArgPattern('cost\\$');
  assert.equal(literal.source, '^(?:cost\\$)$');
  assert.equal(literal.test('cost$'), true);
  assert.equal(literal.test('cost'), false);

  const backslashThenEnd = compileArgPattern('a\\\\$');
  assert.equal(backslashThenEnd.source, '^(?:a\\\\)$');
  assert.equal(backslashThenEnd.test('a\\'), true);
});

test('an arg-pattern cannot close the wrapping group to escape the anchors', () => {
  assert.throws(() => compileArgPattern('x)|(.*'), /Invalid regular expression/);
  assert.throws(
    () => loadConfig({ PRP_COMMAND: '!deploy', PRP_ARG_PATTERN: '[0-9]{12})|(.*' }),
    /arg-pattern .* is not a valid regular expression/,
  );
});

test('the default arg-pattern allows only safe identifier characters', () => {
  const { argPattern } = loadConfig({ PRP_COMMAND: '!deploy' });
  for (const arg of ['prod', 'my-stack_1.2', '123456789012', 'A.b-C_d']) {
    assert.equal(deploy(`!deploy ${arg}`, { argPattern }).valid, true, arg);
  }
  for (const arg of ['$(x)', '`id`', ';', 'a;b', 'a/b', '../x', 'a|b', '$HOME', "'x'", '\u00e9', 'x\u200b']) {
    const result = deploy(`!deploy ${arg}`, { argPattern });
    assert.equal(result.valid, false, arg);
    assert.match(result.error, /^Invalid argument `/, arg);
  }
});

test('default arg-pattern rejects dot paths and option-like arguments', () => {
  const config = loadConfig({ PRP_COMMAND: '!deploy' });
  for (const arg of ['.', '..', '-x', '--yes', '.hidden', '_x']) {
    const result = parseCommand(`!deploy ${arg}`, config);
    assert.equal(result.valid, false, arg);
  }
  assert.equal(parseCommand('!deploy svc', config).valid, true);
  assert.equal(parseCommand('!deploy a.b-c_d', config).valid, true);
});

test('loadConfig applies defaults and validates', () => {
  const config = loadConfig({ PRP_COMMAND: '!deploy' });
  assert.equal(config.minArgs, 0);
  assert.equal(config.maxArgs, 1);
  assert.equal(DEFAULT_ARG_PATTERN, '^[A-Za-z0-9][A-Za-z0-9._-]*$');
  assert.equal(config.argPattern.source, '^(?:[A-Za-z0-9][A-Za-z0-9._-]*)$');
  assert.equal(config.argPattern.flags, 'u');

  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_ARG_PATTERN: '' }), /arg-pattern must not be empty/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_ARG_PATTERN: '  ' }), /arg-pattern must not be empty/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_ARG_PATTERN: '^\\-$' }), /arg-pattern .* is not a valid regular expression/);

  assert.throws(() => loadConfig({ PRP_COMMAND: '' }), /command must be a single non-empty token/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!de ploy' }), /command must be a single non-empty token/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_ARG_PATTERN: '^(\\d+$' }), /arg-pattern .* is not a valid regular expression/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_MIN_ARGS: 'one' }), /min-args must be a non-negative integer/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_MAX_ARGS: '1.5' }), /max-args must be a non-negative integer/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_MAX_ARGS: '-1' }), /max-args must be a non-negative integer/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_MIN_ARGS: '' }), /min-args must be a non-negative integer/);
  assert.throws(() => loadConfig({ PRP_COMMAND: '!deploy', PRP_MIN_ARGS: '2', PRP_MAX_ARGS: '1' }), /must not be greater than/);
});

test('run sets outputs for a valid command', async () => {
  const core = await runWith({
    PRP_BODY: '!deploy 123456789012\r\n<!-- Sent from Reviewable.io -->',
    PRP_COMMAND: '!deploy',
    PRP_ARG_PATTERN: ACCOUNT,
    PRP_MIN_ARGS: '1',
    PRP_MAX_ARGS: '1',
  });
  assert.deepEqual(core.failures, []);
  assert.deepEqual(core.outputs, {
    matched: 'true',
    valid: 'true',
    args: '["123456789012"]',
    arg: '123456789012',
    error: '',
  });
});

test('run reports invalid user input via outputs without failing', async () => {
  const core = await runWith({
    PRP_BODY: '!deploy ;rm',
    PRP_COMMAND: '!deploy',
    PRP_ARG_PATTERN: ACCOUNT,
    PRP_MIN_ARGS: '1',
    PRP_MAX_ARGS: '1',
  });
  assert.deepEqual(core.failures, []);
  assert.deepEqual(core.outputs, {
    matched: 'true',
    valid: 'false',
    args: '[]',
    arg: '',
    error: 'Invalid argument `;rm`',
  });
});

test('run reports an unrelated comment as not matched without failing', async () => {
  const core = await runWith({ PRP_BODY: 'looks good', PRP_COMMAND: '!deploy', PRP_MIN_ARGS: '0', PRP_MAX_ARGS: '1' });
  assert.deepEqual(core.failures, []);
  assert.deepEqual(core.outputs, { matched: 'false', valid: 'false', args: '[]', arg: '', error: '' });
});

test('run fails the step on a bad arg-pattern', async () => {
  const core = await runWith({ PRP_BODY: '!deploy 1', PRP_COMMAND: '!deploy', PRP_ARG_PATTERN: '[', PRP_MIN_ARGS: '0', PRP_MAX_ARGS: '1' });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /arg-pattern "\[" is not a valid regular expression/);
  assert.equal(core.outputs.matched, 'false');
  assert.equal(core.outputs.valid, 'false');
});

test('run rejects a partial match of an unanchored arg-pattern without failing', async () => {
  for (const arg of ['123456789012x', 'x123456789012']) {
    const core = await runWith({
      PRP_BODY: `!deploy ${arg}`,
      PRP_COMMAND: '!deploy',
      PRP_ARG_PATTERN: '[0-9]{12}',
      PRP_MIN_ARGS: '1',
      PRP_MAX_ARGS: '1',
    });
    assert.deepEqual(core.failures, [], arg);
    assert.deepEqual(core.outputs, { matched: 'true', valid: 'false', args: '[]', arg: '', error: `Invalid argument \`${arg}\`` }, arg);
  }
});

test('run uses the default arg-pattern when none is given', async () => {
  const bad = await runWith({ PRP_BODY: '!deploy $(x)', PRP_COMMAND: '!deploy', PRP_MIN_ARGS: '1', PRP_MAX_ARGS: '1' });
  assert.deepEqual(bad.failures, []);
  assert.equal(bad.outputs.valid, 'false');
  assert.equal(bad.outputs.error, 'Invalid argument `$(x)`');

  const good = await runWith({ PRP_BODY: '!deploy my-stack', PRP_COMMAND: '!deploy', PRP_MIN_ARGS: '1', PRP_MAX_ARGS: '1' });
  assert.equal(good.outputs.valid, 'true');
  assert.equal(good.outputs.arg, 'my-stack');
});

test('run fails the step on non-integer min-args or max-args', async () => {
  const core = await runWith({ PRP_BODY: '!deploy 1', PRP_COMMAND: '!deploy', PRP_MIN_ARGS: 'x', PRP_MAX_ARGS: '1' });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /min-args must be a non-negative integer, got "x"/);
});
