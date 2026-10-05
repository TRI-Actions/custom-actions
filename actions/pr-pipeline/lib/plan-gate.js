'use strict';

// External id that matches the plan check runs by check name only, with any or no external_id.
const ANY_EXTERNAL_ID = '*';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function describeError(err) {
  const status = err && err.status ? `HTTP ${err.status} ` : '';
  return `${status}${(err && err.message) || String(err)}`;
}

function parseList(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean);
}

// Parses an ISO 8601 timestamp with a time zone (e.g. 2026-10-01T12:00:00Z) into epoch
// milliseconds, or returns NaN. Out-of-range fields such as Feb 30 or 24:00 are rejected
// instead of being rolled over.
function parseTimestamp(value) {
  const match = TIMESTAMP_PATTERN.exec(String(value ?? ''));
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return NaN;
  if (hour > 23 || minute > 59 || second > 59) return NaN;
  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return NaN;
  return Date.parse(match[0]);
}

function checkUrl(run) {
  return run.html_url || run.details_url || '';
}

// Decides whether every required plan succeeded on the commit. For each external id
// (or for all runs with the check name when the id is '*'), only the newest run (highest
// id) counts: it must be completed with conclusion success and, when notAfter (epoch
// milliseconds) is set, must have completed at or before notAfter. Older runs are
// ignored, including runs that never completed.
function evaluate(runs, { sha, checkName, externalIds, notAfter = null }) {
  if (!Array.isArray(externalIds) || !externalIds.length) {
    throw new Error('externalIds must list at least one external id or "*"');
  }
  const sha7 = String(sha).slice(0, 7);
  const named = runs.filter((run) => run.name === checkName);
  let firstUrl = '';

  for (const id of externalIds) {
    const subject = id === ANY_EXTERNAL_ID ? '' : ` for ${id}`;
    const matching = id === ANY_EXTERNAL_ID ? named : named.filter((run) => run.external_id === id);

    if (!matching.length) {
      return {
        passed: false,
        reason: `No \`${checkName}\` check${subject} on commit ${sha7}. Push a commit or close and reopen the PR to re-plan.`,
        checkUrl: '',
      };
    }

    const newest = matching.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    const url = checkUrl(newest);

    if (newest.status !== 'completed') {
      return {
        passed: false,
        reason: `The plan${subject} on commit ${sha7} is still running. Wait for the \`${checkName}\` check to complete, then try again.`,
        checkUrl: url,
      };
    }

    if (newest.conclusion !== 'success') {
      const title = ((newest.output && newest.output.title) || '').trim().replace(/\.+$/, '');
      return {
        passed: false,
        reason:
          `The latest plan${subject} on commit ${sha7} ended with ${newest.conclusion || 'no conclusion'}` +
          `${title ? `: ${title}` : ''}.${url ? ` See ${url}` : ''}`,
        checkUrl: url,
      };
    }

    // A missing or unparseable completed_at compares as NaN and blocks.
    if (notAfter !== null && !(parseTimestamp(newest.completed_at) <= notAfter)) {
      return {
        passed: false,
        reason:
          `The plan${subject} on commit ${sha7} finished after the command was posted, so it may include ` +
          'changes made after you commented. Review the latest plan and post the command again.',
        checkUrl: url,
      };
    }

    if (!firstUrl) firstUrl = url;
  }

  return { passed: true, reason: '', checkUrl: firstUrl };
}

// Reads and validates the inputs. Throws on misconfiguration.
function parseInputs(env) {
  const sha = (env.PRP_SHA || '').trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Input "sha" must be a full 40-character commit SHA, got ${JSON.stringify(sha)}.`);
  }

  const checkName = (env.PRP_CHECK_NAME || '').trim();
  if (!checkName) throw new Error('Input "check-name" is required.');

  const externalIds = parseList(env.PRP_EXTERNAL_IDS);
  if (!externalIds.length) {
    throw new Error(
      'Input "external-ids" is required: list the external ids that each need a successful plan, ' +
        'or pass "*" to match by check name only.',
    );
  }
  if (externalIds.length > 1 && externalIds.includes(ANY_EXTERNAL_ID)) {
    throw new Error(
      `Input "external-ids" must be either "*" alone or a list of external ids, got ${JSON.stringify(externalIds.join(' '))}.`,
    );
  }

  const notAfterText = (env.PRP_NOT_AFTER || '').trim();
  let notAfter = null;
  if (notAfterText) {
    notAfter = parseTimestamp(notAfterText);
    if (Number.isNaN(notAfter)) {
      throw new Error(
        `Input "not-after" must be an ISO 8601 timestamp with a time zone, such as 2026-10-01T12:00:00Z, got ${JSON.stringify(notAfterText)}.`,
      );
    }
  }

  return { sha, checkName, externalIds, notAfter };
}

function setResult(core, { passed, reason, checkUrl: url }) {
  core.setOutput('passed', passed ? 'true' : 'false');
  core.setOutput('reason', reason);
  core.setOutput('check-url', url);
}

async function run({ github, context, core, env }) {
  const fail = (reason) => {
    setResult(core, { passed: false, reason, checkUrl: '' });
    core.setFailed(reason);
  };

  let inputs;
  try {
    inputs = parseInputs(env);
  } catch (err) {
    return fail(err.message);
  }
  const { sha, checkName } = inputs;

  let runs;
  try {
    runs = await github.paginate(github.rest.checks.listForRef, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: sha,
      check_name: checkName,
      filter: 'all',
      per_page: 100,
    });
  } catch (err) {
    return fail(`Failed to list \`${checkName}\` check runs for commit ${sha}: ${describeError(err)}`);
  }

  const result = evaluate(runs, inputs);
  setResult(core, result);
  if (result.passed) {
    core.info(`Plan gate passed for \`${checkName}\` on ${sha}.`);
  } else {
    core.info(`Plan gate blocked: ${result.reason}`);
  }
}

module.exports = { ANY_EXTERNAL_ID, parseList, parseTimestamp, parseInputs, evaluate, run };
