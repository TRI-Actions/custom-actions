'use strict';

// Decides whether the author of a PR comment command may run it: either via active
// membership in one of the given teams, or, when the commenter has write access, via an
// approval of the PR head commit by a reviewer with write access who is neither the PR
// author nor an author or committer of any commit in the PR.
// Pure helpers are exported for unit tests; run() is the github-script entry point.

const QUALIFYING_ROLES = new Set(['admin', 'maintain', 'write']);
const IGNORED_REVIEW_STATES = new Set(['COMMENTED', 'PENDING']);
// GitHub's committer identity for commits made in the web UI (merges, "Update branch", edits).
const WEB_FLOW_LOGIN = 'web-flow';
// The pull request commits API lists at most this many commits.
const MAX_PR_COMMITS = 250;

function parseTeams(value) {
  return String(value ?? '')
    .split(',')
    .map((team) => team.trim())
    .filter(Boolean);
}

function parseBoolean(name, value) {
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new Error(`${name} must be 'true' or 'false', got "${value}"`);
}

function sameLogin(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function submittedAt(review) {
  const time = Date.parse(review.submitted_at);
  return Number.isNaN(time) ? -Infinity : time;
}

function isLaterReview(a, b) {
  const ta = submittedAt(a);
  const tb = submittedAt(b);
  if (ta !== tb) return ta > tb;
  return a.id > b.id;
}

// Returns the lowercased logins that authored or committed any of `commits`, without web-flow.
// Commits whose author or committer is not linked to a GitHub account have no login and add nothing.
function commitLogins(commits) {
  const logins = new Set();
  for (const commit of commits) {
    for (const login of [commit.author?.login, commit.committer?.login]) {
      if (!login) continue;
      const key = login.toLowerCase();
      if (key !== WEB_FLOW_LOGIN) logins.add(key);
    }
  }
  return logins;
}

// Returns the logins whose latest non-comment review approves `sha` and who are neither the
// PR author nor in `excluded` (compared case-insensitively).
function evaluateApprovals(reviews, { sha, author, excluded = [] }) {
  const latest = new Map();
  for (const review of reviews) {
    const login = review.user && review.user.login;
    if (!login || IGNORED_REVIEW_STATES.has(review.state)) continue;
    const key = login.toLowerCase();
    const current = latest.get(key);
    if (!current || isLaterReview(review, current)) latest.set(key, review);
  }

  const headSha = String(sha).toLowerCase();
  const excludedKeys = new Set([...excluded].map((login) => String(login).toLowerCase()));
  return [...latest.values()]
    .filter(
      (review) =>
        review.state === 'APPROVED' &&
        String(review.commit_id).toLowerCase() === headSha &&
        !sameLogin(review.user.login, author) &&
        !excludedKeys.has(review.user.login.toLowerCase()),
    )
    .map((review) => review.user.login);
}

function statusOf(err) {
  return err && err.status !== undefined ? err.status : 'unknown';
}

function describeError(err) {
  return `status ${statusOf(err)}: ${err && err.message ? err.message : err}`;
}

async function isActiveTeamMember(github, org, teamSlug, username) {
  try {
    const { data } = await github.rest.teams.getMembershipForUserInOrg({ org, team_slug: teamSlug, username });
    return data.state === 'active';
  } catch (err) {
    if (err && err.status === 404) return false;
    throw err;
  }
}

async function hasWriteAccess(github, owner, repo, username) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return QUALIFYING_ROLES.has(data.role_name || data.permission);
  } catch (err) {
    if (err && err.status === 404) return false;
    throw err;
  }
}

// `actorHasWrite` is false only when approval-based authorization was skipped because the
// commenter lacks write access.
function denialReason({ actor, org, teams, allowApproval, sha, actorHasWrite = true }) {
  const teamPart = teams.length
    ? `\`${actor}\` is not an active member of ${teams.length === 1 ? 'team' : 'any of the teams'} ${teams
        .map((team) => `\`${org}/${team}\``)
        .join(', ')}`
    : 'no authorized teams are configured';
  let approvalPart;
  if (!allowApproval) {
    approvalPart = 'approval-based authorization is disabled';
  } else if (!actorHasWrite) {
    approvalPart = `\`${actor}\` does not have write access to the repository, which approval-based authorization requires`;
  } else {
    approvalPart =
      `the head commit \`${sha.slice(0, 7)}\` has no approval from a reviewer with write access ` +
      '(other than the PR author and the authors and committers of its commits)';
  }
  return `Not authorized: ${teamPart}, and ${approvalPart}.`;
}

// Reads and validates the caller-controlled configuration. Throws on misconfiguration.
function loadConfig(env, context) {
  const actor = String(env.PRP_ACTOR ?? '').trim();
  if (!actor) throw new Error('actor is required');

  const config = {
    actor,
    triggeringActor: String(env.PRP_TRIGGERING_ACTOR ?? '').trim(),
    teams: parseTeams(env.PRP_TEAMS),
    org: String(env.PRP_ORG ?? '').trim() || context.repo.owner,
    allowApproval: parseBoolean('allow-approval', env.PRP_ALLOW_APPROVAL ?? 'true'),
    sha: String(env.PRP_SHA ?? '').trim().toLowerCase(),
    prAuthor: String(env.PRP_PR_AUTHOR ?? '').trim(),
    prNumber: String(env.PRP_PR_NUMBER ?? '').trim(),
  };

  if (config.allowApproval) {
    if (!/^[0-9a-f]{40}$/.test(config.sha)) {
      throw new Error(`sha must be the full 40-character head commit SHA when allow-approval is true, got "${env.PRP_SHA ?? ''}"`);
    }
    if (!config.prAuthor) throw new Error('pr-author is required when allow-approval is true');
    if (!/^[1-9]\d*$/.test(config.prNumber)) {
      throw new Error(`pr-number must be a positive integer when allow-approval is true, got "${env.PRP_PR_NUMBER ?? ''}"`);
    }
    config.prNumber = Number(config.prNumber);
  }

  return config;
}

async function run({ github, context, core, env }) {
  const finish = (authorized, via, reason) => {
    core.setOutput('authorized', authorized ? 'true' : 'false');
    core.setOutput('via', via);
    core.setOutput('reason', reason);
    core.info(`authorize: authorized=${authorized}${via ? ` via=${via}` : ''} - ${reason}`);
  };
  const failClosed = (message) => {
    finish(false, '', message);
    core.setFailed(message);
  };

  let config;
  try {
    config = loadConfig(env, context);
  } catch (err) {
    failClosed(`authorize: ${err.message}`);
    return;
  }
  const { actor, triggeringActor, teams, org, allowApproval, sha, prAuthor, prNumber } = config;

  if (triggeringActor && !sameLogin(triggeringActor, actor)) {
    finish(
      false,
      '',
      `This run was triggered by \`${triggeringActor}\`, but the command was posted by \`${actor}\`. ` +
        "Re-running another user's command is not allowed; post a new comment with the command instead.",
    );
    return;
  }

  for (const team of teams) {
    let member;
    try {
      member = await isActiveTeamMember(github, org, team, actor);
    } catch (err) {
      failClosed(`authorize: checking membership of \`${actor}\` in team \`${org}/${team}\` failed (${describeError(err)})`);
      return;
    }
    if (member) {
      finish(true, `team:${team}`, `\`${actor}\` is an active member of team \`${org}/${team}\``);
      return;
    }
  }

  if (allowApproval) {
    const { owner, repo } = context.repo;

    let actorHasWrite;
    try {
      actorHasWrite = await hasWriteAccess(github, owner, repo, actor);
    } catch (err) {
      failClosed(`authorize: checking repository permission of \`${actor}\` failed (${describeError(err)})`);
      return;
    }
    if (!actorHasWrite) {
      finish(false, '', denialReason({ actor, org, teams, allowApproval, sha, actorHasWrite }));
      return;
    }

    let reviews;
    try {
      reviews = await github.paginate(github.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
    } catch (err) {
      failClosed(`authorize: listing reviews for PR #${prNumber} failed (${describeError(err)})`);
      return;
    }

    let commits;
    try {
      commits = await github.paginate(github.rest.pulls.listCommits, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
    } catch (err) {
      failClosed(`authorize: listing commits for PR #${prNumber} failed (${describeError(err)})`);
      return;
    }
    if (commits.length >= MAX_PR_COMMITS) {
      failClosed(
        `authorize: PR #${prNumber} has at least ${MAX_PR_COMMITS} commits, the most the GitHub API lists, ` +
          'so the authors and committers of its commits cannot all be excluded as approvers',
      );
      return;
    }

    const approvers = evaluateApprovals(reviews, { sha, author: prAuthor, excluded: commitLogins(commits) });
    for (const login of approvers) {
      let qualifies;
      try {
        qualifies = await hasWriteAccess(github, owner, repo, login);
      } catch (err) {
        failClosed(`authorize: checking repository permission of \`${login}\` failed (${describeError(err)})`);
        return;
      }
      if (qualifies) {
        finish(true, `approval:${login}`, `head commit \`${sha.slice(0, 7)}\` is approved by \`${login}\``);
        return;
      }
    }
  }

  finish(false, '', denialReason({ actor, org, teams, allowApproval, sha }));
}

module.exports = {
  parseTeams,
  commitLogins,
  evaluateApprovals,
  denialReason,
  loadConfig,
  run,
};
