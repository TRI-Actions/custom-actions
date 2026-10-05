'use strict';

// Parses a PR comment command such as `!deploy 123456789012`.
// Pure helpers are exported for unit tests; run() is the github-script entry point.

const MAX_MESSAGE_ARG_LENGTH = 60;
const DEFAULT_ARG_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

// Strip backticks (so the value cannot break out of a Markdown code span) and
// control/format characters (C0, C1, DEL, zero-width and bidi overrides), then cap the length.
function sanitizeForMessage(value) {
  const chars = Array.from(String(value).replace(/[`\p{Cc}\p{Cf}]/gu, ''));
  if (chars.length <= MAX_MESSAGE_ARG_LENGTH) return chars.join('');
  return `${chars.slice(0, MAX_MESSAGE_ARG_LENGTH - 3).join('')}...`;
}

function firstNonEmptyLine(body) {
  for (const line of String(body ?? '').replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function pluralArgs(n) {
  return n === 1 ? 'argument' : 'arguments';
}

function describeArgCount(command, minArgs, maxArgs, got) {
  let expected;
  if (maxArgs === 0) expected = 'no arguments';
  else if (minArgs === maxArgs) expected = `exactly ${minArgs} ${pluralArgs(minArgs)}`;
  else if (minArgs === 0) expected = `at most ${maxArgs} ${pluralArgs(maxArgs)}`;
  else expected = `between ${minArgs} and ${maxArgs} arguments`;
  return `\`${command}\` takes ${expected}, got ${got}`;
}

// Returns { matched, valid, args, error }. args is only populated when valid.
function parseCommand(body, { command, argPattern, minArgs, maxArgs }) {
  const line = firstNonEmptyLine(body);
  const tokens = line ? line.split(/\s+/) : [];
  if (tokens[0] !== command) {
    return { matched: false, valid: false, args: [], error: '' };
  }

  const args = tokens.slice(1);
  if (args.length < minArgs || args.length > maxArgs) {
    return {
      matched: true,
      valid: false,
      args: [],
      error: describeArgCount(command, minArgs, maxArgs, args.length),
    };
  }

  const invalid = args.find((arg) => !argPattern.test(arg));
  if (invalid !== undefined) {
    return {
      matched: true,
      valid: false,
      args: [],
      error: `Invalid argument \`${sanitizeForMessage(invalid)}\``,
    };
  }

  return { matched: true, valid: true, args, error: '' };
}

// Compiles arg-pattern so that it must match a whole argument. A leading ^ and an
// unescaped trailing $ are stripped, and the rest is compiled on its own first, so an
// unbalanced ")" (e.g. "a)|(b") throws instead of closing the wrapping group early.
// The result is ^(?:...)$ with the u flag.
function compileArgPattern(source) {
  let body = String(source);
  if (body.startsWith('^')) body = body.slice(1);
  if (/(?:^|[^\\])(?:\\\\)*\$$/.test(body)) body = body.slice(0, -1);
  const inner = new RegExp(body, 'u');
  return new RegExp(`^(?:${inner.source})$`, 'u');
}

function parseCount(name, value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  }
  return Number(text);
}

// Reads and validates the caller-controlled configuration. Throws on misconfiguration.
function loadConfig(env) {
  const command = String(env.PRP_COMMAND ?? '').trim();
  if (!command || /\s/.test(command)) {
    throw new Error(`command must be a single non-empty token, got "${env.PRP_COMMAND ?? ''}"`);
  }

  const patternSource = env.PRP_ARG_PATTERN ?? DEFAULT_ARG_PATTERN;
  if (!String(patternSource).trim()) {
    throw new Error('arg-pattern must not be empty');
  }
  let argPattern;
  try {
    argPattern = compileArgPattern(patternSource);
  } catch (err) {
    throw new Error(`arg-pattern "${patternSource}" is not a valid regular expression: ${err.message}`);
  }

  const minArgs = parseCount('min-args', env.PRP_MIN_ARGS ?? '0');
  const maxArgs = parseCount('max-args', env.PRP_MAX_ARGS ?? '1');
  if (minArgs > maxArgs) {
    throw new Error(`min-args (${minArgs}) must not be greater than max-args (${maxArgs})`);
  }

  return { command, argPattern, minArgs, maxArgs };
}

function setOutputs(core, { matched, valid, args, error }) {
  core.setOutput('matched', matched ? 'true' : 'false');
  core.setOutput('valid', valid ? 'true' : 'false');
  core.setOutput('args', JSON.stringify(args));
  core.setOutput('arg', args.length > 0 ? args[0] : '');
  core.setOutput('error', error);
}

async function run({ core, env }) {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    const message = `parse-command: ${err.message}`;
    setOutputs(core, { matched: false, valid: false, args: [], error: message });
    core.setFailed(message);
    return;
  }

  const result = parseCommand(env.PRP_BODY, config);
  setOutputs(core, result);
  core.info(`parse-command: matched=${result.matched} valid=${result.valid}${result.error ? ` error=${result.error}` : ''}`);
}

module.exports = {
  DEFAULT_ARG_PATTERN,
  compileArgPattern,
  sanitizeForMessage,
  firstNonEmptyLine,
  describeArgCount,
  parseCommand,
  loadConfig,
  run,
};
