'use strict';

const fs = require('fs');
const path = require('path');

const CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
];

// GitHub rejects check run summaries above 65535. Measured in UTF-8 bytes so
// multibyte output can never exceed the limit, whichever unit GitHub counts.
const MAX_SUMMARY_BYTES = 65535;
const TRUNCATION_NOTE =
  '\n\n... (truncated: the full output exceeds the GitHub check run summary limit)';

function describeError(err) {
  const status = err && err.status ? `HTTP ${err.status} ` : '';
  return `${status}${(err && err.message) || String(err)}`;
}

function truncateSummary(text, limit = MAX_SUMMARY_BYTES) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return text;
  let end = limit - Buffer.byteLength(TRUNCATION_NOTE, 'utf8');
  // Step back off UTF-8 continuation bytes so a character is never split.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8') + TRUNCATION_NOTE;
}

function buildCreateParams({ owner, repo, name, sha, externalId, title, summary, detailsUrl }) {
  const params = {
    owner,
    repo,
    name,
    head_sha: sha,
    status: 'in_progress',
    details_url: detailsUrl,
  };
  if (externalId) params.external_id = externalId;
  if (title) params.output = { title, summary: truncateSummary(summary || title) };
  return params;
}

function buildUpdateParams({ owner, repo, id, conclusion, title, summary, completedAt }) {
  return {
    owner,
    repo,
    check_run_id: id,
    status: 'completed',
    conclusion,
    completed_at: completedAt,
    output: {
      title: title || conclusion,
      summary: truncateSummary(summary || `Concluded with ${conclusion}.`),
    },
  };
}

async function start({ github, context, core, env }) {
  const name = (env.PRP_NAME || '').trim();
  const sha = (env.PRP_SHA || '').trim();
  if (!name) return core.setFailed('Input "name" is required when mode is start.');
  if (!sha) return core.setFailed('Input "sha" is required when mode is start.');

  const title = (env.PRP_TITLE || '').trim();
  if (!title && env.PRP_SUMMARY) {
    core.warning('Input "summary" is ignored on start because "title" is empty.');
  }
  const { owner, repo } = context.repo;
  const params = buildCreateParams({
    owner,
    repo,
    name,
    sha,
    externalId: (env.PRP_EXTERNAL_ID || '').trim(),
    title,
    summary: env.PRP_SUMMARY || '',
    detailsUrl: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
  });

  let data;
  try {
    ({ data } = await github.rest.checks.create(params));
  } catch (err) {
    return core.setFailed(`Failed to create check run "${name}" on ${sha}: ${describeError(err)}`);
  }
  core.setOutput('id', String(data.id));
  core.info(`Started check run "${name}" (id ${data.id}) on ${sha}.`);
}

async function finish({ github, context, core, env }) {
  const id = (env.PRP_ID || '').trim();
  if (!id) {
    core.notice('No check run id given (the start step was skipped); nothing to finish.');
    return;
  }
  if (!/^\d+$/.test(id)) return core.setFailed(`Invalid check run id "${id}".`);

  const conclusion = (env.PRP_CONCLUSION || '').trim();
  if (!CONCLUSIONS.includes(conclusion)) {
    return core.setFailed(
      `Invalid conclusion "${conclusion}". Expected one of: ${CONCLUSIONS.join(', ')}.`,
    );
  }

  let summary = env.PRP_SUMMARY || '';
  const summaryFile = (env.PRP_SUMMARY_FILE || '').trim();
  if (summaryFile) {
    try {
      summary = fs.readFileSync(path.resolve(env.GITHUB_WORKSPACE || process.cwd(), summaryFile), 'utf8');
    } catch (err) {
      // Still complete the check run; a stuck in_progress run would block the gate.
      core.warning(`Could not read summary-file "${summaryFile}": ${err.message}`);
      summary = summary || `Summary file \`${summaryFile}\` could not be read.`;
    }
  }

  const { owner, repo } = context.repo;
  const params = buildUpdateParams({
    owner,
    repo,
    id: Number(id),
    conclusion,
    title: (env.PRP_TITLE || '').trim(),
    summary,
    completedAt: new Date().toISOString(),
  });

  try {
    await github.rest.checks.update(params);
  } catch (err) {
    return core.setFailed(`Failed to complete check run ${id}: ${describeError(err)}`);
  }
  core.setOutput('id', id);
  core.info(`Completed check run ${id} with ${conclusion}.`);
}

async function run({ github, context, core, env }) {
  const mode = (env.PRP_MODE || '').trim();
  if (mode === 'start') return start({ github, context, core, env });
  if (mode === 'finish') return finish({ github, context, core, env });
  core.setFailed(`Invalid mode "${mode}". Expected start or finish.`);
}

module.exports = {
  CONCLUSIONS,
  MAX_SUMMARY_BYTES,
  TRUNCATION_NOTE,
  truncateSummary,
  buildCreateParams,
  buildUpdateParams,
  run,
};
