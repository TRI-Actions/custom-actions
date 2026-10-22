'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const { parseTeams, commitLogins, evaluateApprovals, loadConfig, run } = require('../lib/authorize.js');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const CONTEXT = { repo: { owner: 'TRI-IE', repo: 'infra' } };
const WRITE = { role_name: 'write', permission: 'write' };
const READ = { role_name: 'read', permission: 'read' };

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function review(id, login, state, { commit = HEAD, at = `2026-10-01T10:00:${String(id).padStart(2, '0')}Z` } = {}) {
  return { id, user: login === null ? null : { login }, state, commit_id: commit, submitted_at: at };
}

// author / committer: login string, or null for an identity not linked to a GitHub account
function commit(sha, author, committer = author) {
  const user = (login) => (login === null ? null : { login });
  return { sha, author: user(author), committer: user(committer) };
}

// teams: { slug: { login: 'active' | 'pending' | <http status> } }, missing -> 404
// permissions: { login: { role_name, permission } | <http status> }, missing -> 404
// commits: PR commits, default one commit on HEAD by the PR author
function fakeGithub({
  teams = {},
  reviews = [],
  permissions = {},
  commits = [commit(HEAD, 'dave')],
  reviewsError,
  commitsError,
} = {}) {
  const calls = { teams: [], reviews: [], commits: [], permissions: [] };
  const github = {
    calls,
    paginate: async (method, params) => (await method(params)).data,
    rest: {
      teams: {
        getMembershipForUserInOrg: async (params) => {
          calls.teams.push(params);
          const value = (teams[params.team_slug] || {})[params.username];
          if (value === undefined) throw httpError(404);
          if (typeof value === 'number') throw httpError(value);
          return { status: 200, data: { state: value, role: 'member' } };
        },
      },
      pulls: {
        listReviews: async (params) => {
          calls.reviews.push(params);
          if (reviewsError) throw httpError(reviewsError);
          return { status: 200, data: reviews };
        },
        listCommits: async (params) => {
          calls.commits.push(params);
          if (commitsError) throw httpError(commitsError);
          return { status: 200, data: commits };
        },
      },
      repos: {
        getCollaboratorPermissionLevel: async (params) => {
          calls.permissions.push(params);
          const value = permissions[params.username];
          if (value === undefined) throw httpError(404);
          if (typeof value === 'number') throw httpError(value);
          return { status: 200, data: value };
        },
      },
    },
  };
  return github;
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

function baseEnv(overrides = {}) {
  return {
    PRP_ACTOR: 'carol',
    PRP_TRIGGERING_ACTOR: 'carol',
    PRP_TEAMS: 'ie',
    PRP_ORG: 'TRI-IE',
    PRP_ALLOW_APPROVAL: 'true',
    PRP_SHA: HEAD,
    PRP_PR_AUTHOR: 'dave',
    PRP_PR_NUMBER: '42',
    ...overrides,
  };
}

async function authorize(env, githubOptions) {
  const github = fakeGithub(githubOptions);
  const core = fakeCore();
  await run({ github, context: CONTEXT, core, env });
  return { github, core };
}

test('active team member is authorized without checking approvals', async () => {
  const { github, core } = await authorize(baseEnv({ PRP_TEAMS: 'platform, ie' }), {
    teams: { ie: { carol: 'active' } },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'team:ie');
  assert.deepEqual(
    github.calls.teams.map((call) => call.team_slug),
    ['platform', 'ie'],
  );
  assert.deepEqual(github.calls.teams[0], { org: 'TRI-IE', team_slug: 'platform', username: 'carol' });
  assert.equal(github.calls.reviews.length, 0);
});

test('pending team membership is not authorized', async () => {
  const { core } = await authorize(baseEnv({ PRP_ALLOW_APPROVAL: 'false' }), {
    teams: { ie: { carol: 'pending' } },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
});

test('non-member is authorized by a qualifying approval of the head commit', async () => {
  const { github, core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'approval:bob');
  assert.deepEqual(github.calls.reviews[0], { owner: 'TRI-IE', repo: 'infra', pull_number: 42, per_page: 100 });
  assert.deepEqual(github.calls.commits[0], { owner: 'TRI-IE', repo: 'infra', pull_number: 42, per_page: 100 });
  assert.deepEqual(github.calls.permissions, [
    { owner: 'TRI-IE', repo: 'infra', username: 'carol' },
    { owner: 'TRI-IE', repo: 'infra', username: 'bob' },
  ]);
});

test('approval on an older SHA does not authorize', async () => {
  const { github, core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED', { commit: OLD })],
    permissions: { carol: WRITE, bob: { role_name: 'admin', permission: 'admin' } },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(core.outputs.via, '');
  assert.equal(
    core.outputs.reason,
    'Not authorized: `carol` is not an active member of team `TRI-IE/ie`, and the head commit `aaaaaaa` has no approval from a reviewer with write access who is not the PR author and did not author or commit changes in the PR (an approval of an earlier commit does not count).',
  );
  assert.deepEqual(
    github.calls.permissions.map((call) => call.username),
    ['carol'],
  );
});

test('APPROVED then later CHANGES_REQUESTED is not an approval', () => {
  const reviews = [review(1, 'bob', 'APPROVED'), review(2, 'bob', 'CHANGES_REQUESTED')];
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave' }), []);
});

test('APPROVED then later COMMENTED is still an approval', () => {
  const reviews = [review(1, 'bob', 'APPROVED'), review(2, 'bob', 'COMMENTED'), review(3, 'bob', 'PENDING')];
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave' }), ['bob']);
});

test('APPROVED then later DISMISSED is not an approval', () => {
  const reviews = [review(1, 'bob', 'APPROVED'), review(2, 'bob', 'DISMISSED')];
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave' }), []);
});

test('latest review is chosen by submitted_at, then id, regardless of list order', () => {
  const later = review(1, 'bob', 'APPROVED', { at: '2026-10-01T12:00:00Z' });
  const earlier = review(2, 'bob', 'CHANGES_REQUESTED', { at: '2026-10-01T11:00:00Z' });
  assert.deepEqual(evaluateApprovals([later, earlier], { sha: HEAD, author: 'dave' }), ['bob']);

  const tieLow = review(5, 'bob', 'CHANGES_REQUESTED', { at: '2026-10-01T12:00:00Z' });
  const tieHigh = review(6, 'bob', 'APPROVED', { at: '2026-10-01T12:00:00Z' });
  assert.deepEqual(evaluateApprovals([tieHigh, tieLow], { sha: HEAD, author: 'dave' }), ['bob']);
});

test('reviewer logins are compared case-insensitively', () => {
  const reviews = [review(1, 'Bob', 'APPROVED'), review(2, 'bob', 'CHANGES_REQUESTED')];
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave' }), []);
});

test('reviews from deleted users are ignored', () => {
  const reviews = [review(1, null, 'APPROVED'), review(2, 'bob', 'APPROVED')];
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave' }), ['bob']);
});

test('PR author self-approval does not count', async () => {
  assert.deepEqual(evaluateApprovals([review(1, 'Dave', 'APPROVED')], { sha: HEAD, author: 'dave' }), []);

  const { github, core } = await authorize(baseEnv({ PRP_ACTOR: 'dave', PRP_TRIGGERING_ACTOR: 'dave' }), {
    reviews: [review(1, 'dave', 'APPROVED')],
    permissions: { dave: { role_name: 'admin', permission: 'admin' } },
  });
  assert.equal(core.outputs.authorized, 'false');
  assert.deepEqual(
    github.calls.permissions.map((call) => call.username),
    ['dave'],
  );
});

test('read-only and triage approvers are rejected', async () => {
  const { github, core } = await authorize(baseEnv(), {
    reviews: [review(1, 'reader', 'APPROVED'), review(2, 'triager', 'APPROVED'), review(3, 'stranger', 'APPROVED')],
    permissions: {
      carol: WRITE,
      reader: READ,
      triager: { role_name: 'triage', permission: 'read' },
    },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.deepEqual(
    github.calls.permissions.map((call) => call.username),
    ['carol', 'reader', 'triager', 'stranger'],
  );
});

test('first qualifying approver wins and permission falls back to the permission field', async () => {
  const { core } = await authorize(baseEnv(), {
    reviews: [review(1, 'reader', 'APPROVED'), review(2, 'maintainer', 'APPROVED'), review(3, 'admin', 'APPROVED')],
    permissions: {
      carol: WRITE,
      reader: READ,
      maintainer: { permission: 'write' },
      admin: { role_name: 'admin', permission: 'admin' },
    },
  });
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'approval:maintainer');
});

test('commitLogins collects authors and committers, lowercased, without web-flow or unlinked identities', () => {
  const commits = [
    commit('1', 'Dave', 'web-flow'),
    commit('2', 'erin', 'Bob'),
    commit('3', null, 'Web-Flow'),
    commit('4', 'frank', null),
  ];
  assert.deepEqual([...commitLogins(commits)].sort(), ['bob', 'dave', 'erin', 'frank']);
});

test('excluded logins are not approvers, compared case-insensitively', () => {
  const reviews = [review(1, 'Bob', 'APPROVED'), review(2, 'erin', 'APPROVED')];
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave', excluded: new Set(['bob']) }), ['erin']);
  assert.deepEqual(evaluateApprovals(reviews, { sha: HEAD, author: 'dave', excluded: ['BOB', 'Erin'] }), []);
});

test('approver who authored the head commit is excluded', async () => {
  const { github, core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    commits: [commit(OLD, 'dave'), commit(HEAD, 'bob')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.match(core.outputs.reason, /who is not the PR author and did not author or commit changes in the PR/);
  assert.deepEqual(
    github.calls.permissions.map((call) => call.username),
    ['carol'],
  );
});

test('approver who only committed is excluded', async () => {
  // bob rebased dave's commit: dave stays the author, bob becomes the committer
  const { core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    commits: [commit(OLD, 'dave'), commit(HEAD, 'dave', 'Bob')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
});

test('approver who clicked Update branch is excluded', async () => {
  // a merge commit made by "Update branch": the clicking user is the author, web-flow the committer
  const { core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED'), review(2, 'erin', 'APPROVED')],
    commits: [commit(OLD, 'dave'), commit(HEAD, 'bob', 'web-flow')],
    permissions: { carol: WRITE, bob: WRITE, erin: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'approval:erin');
});

test('web-flow as committer does not exclude anyone', async () => {
  const { core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    commits: [commit(OLD, 'dave', 'web-flow'), commit(HEAD, 'dave', 'web-flow')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'approval:bob');
});

test('commenter without write access is denied even with a qualifying approval', async () => {
  for (const carol of [READ, { role_name: 'triage', permission: 'read' }, undefined]) {
    const permissions = { bob: WRITE };
    if (carol) permissions.carol = carol;
    const { github, core } = await authorize(baseEnv(), { reviews: [review(1, 'bob', 'APPROVED')], permissions });
    const label = JSON.stringify(carol ?? 404);
    assert.deepEqual(core.failures, [], label);
    assert.equal(core.outputs.authorized, 'false', label);
    assert.equal(core.outputs.via, '', label);
    assert.equal(
      core.outputs.reason,
      'Not authorized: `carol` is not an active member of team `TRI-IE/ie`, and `carol` does not have write access to the repository, which approval-based authorization requires.',
      label,
    );
    assert.deepEqual(
      github.calls.permissions.map((call) => call.username),
      ['carol'],
      label,
    );
    assert.equal(github.calls.reviews.length + github.calls.commits.length, 0, label);
  }
});

test('commenter without write access is still authorized as a team member', async () => {
  const { github, core } = await authorize(baseEnv(), {
    teams: { ie: { carol: 'active' } },
    permissions: { carol: READ },
  });
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'team:ie');
  assert.equal(github.calls.permissions.length, 0);
});

test('triggering-actor mismatch is denied without any API call', async () => {
  const { github, core } = await authorize(baseEnv({ PRP_TRIGGERING_ACTOR: 'mallory' }), {
    teams: { ie: { carol: 'active' } },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(core.outputs.via, '');
  assert.match(core.outputs.reason, /triggered by `mallory`, but the command was posted by `carol`/);
  assert.match(core.outputs.reason, /post a new comment/);
  assert.equal(github.calls.teams.length, 0);
});

test('triggering-actor matching case-insensitively or unset proceeds', async () => {
  for (const triggeringActor of ['CAROL', '']) {
    const { core } = await authorize(baseEnv({ PRP_TRIGGERING_ACTOR: triggeringActor }), {
      teams: { ie: { carol: 'active' } },
    });
    assert.equal(core.outputs.authorized, 'true', triggeringActor);
  }
});

test('triggering-actor defaults to github.triggering_actor and reaches the script through env', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'authorize', 'action.yaml'), 'utf8');
  const block = /^  triggering-actor:\n((?:    .*\n)+)/m.exec(text);
  assert.ok(block, 'no triggering-actor input');
  assert.match(block[1], /^    default: \$\{\{ github\.triggering_actor \}\}$/m);
  assert.match(block[1], /^    required: false$/m);
  assert.match(text, /^\s+PRP_TRIGGERING_ACTOR: \$\{\{ inputs\.triggering-actor \}\}$/m);
});

test('team API 403 fails closed', async () => {
  const { github, core } = await authorize(baseEnv(), {
    teams: { ie: { carol: 403 } },
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /team `TRI-IE\/ie` failed \(status 403/);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(core.outputs.reason, core.failures[0]);
  assert.equal(github.calls.reviews.length, 0);
});

test('listReviews error fails closed', async () => {
  const { core } = await authorize(baseEnv({ PRP_TEAMS: '' }), { permissions: { carol: WRITE }, reviewsError: 502 });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /listing reviews for PR #42 failed \(status 502/);
  assert.equal(core.outputs.authorized, 'false');
});

test('permission API error other than 404 fails closed', async () => {
  const { core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: 500 },
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /permission of `bob` failed \(status 500/);
  assert.equal(core.outputs.authorized, 'false');
});

test('commenter permission API error other than 404 fails closed', async () => {
  const { github, core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: 502, bob: WRITE },
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /permission of `carol` failed \(status 502/);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(github.calls.reviews.length, 0);
});

test('listCommits error fails closed', async () => {
  const { github, core } = await authorize(baseEnv({ PRP_TEAMS: '' }), {
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: WRITE },
    commitsError: 500,
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /listing commits for PR #42 failed \(status 500/);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(core.outputs.reason, core.failures[0]);
  assert.deepEqual(
    github.calls.permissions.map((call) => call.username),
    ['carol'],
  );
});

test('a PR at the 250-commit API cap fails closed', async () => {
  const many = (count) => Array.from({ length: count }, (_, i) => commit(String(i), 'dave'));
  const { github, core } = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    commits: many(250),
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /PR #42 has at least 250 commits, the most the GitHub API lists/);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(core.outputs.reason, core.failures[0]);
  assert.deepEqual(
    github.calls.permissions.map((call) => call.username),
    ['carol'],
  );

  const below = await authorize(baseEnv(), {
    reviews: [review(1, 'bob', 'APPROVED')],
    commits: many(249),
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(below.core.failures, []);
  assert.equal(below.core.outputs.authorized, 'true');
});

test('empty teams with allow-approval false is denied', async () => {
  const { github, core } = await authorize(baseEnv({ PRP_TEAMS: ' , ', PRP_ALLOW_APPROVAL: 'false', PRP_SHA: '' }), {});
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.equal(
    core.outputs.reason,
    'Not authorized: no authorized teams are configured, and approval-based authorization is disabled.',
  );
  assert.equal(github.calls.teams.length + github.calls.reviews.length, 0);
});

test('denial reason lists every team checked', async () => {
  const { core } = await authorize(baseEnv({ PRP_TEAMS: 'ie,platform' }), {});
  assert.match(core.outputs.reason, /not an active member of any of the teams `TRI-IE\/ie`, `TRI-IE\/platform`/);
});

test('org defaults to the repository owner', () => {
  const config = loadConfig(baseEnv({ PRP_ORG: '' }), CONTEXT);
  assert.equal(config.org, 'TRI-IE');
  assert.deepEqual(parseTeams(' ie ,,platform '), ['ie', 'platform']);
});

test('misconfiguration fails the step', async () => {
  const cases = [
    [{ PRP_ACTOR: '' }, /actor is required/],
    [{ PRP_ALLOW_APPROVAL: 'yes' }, /allow-approval must be 'true' or 'false'/],
    [{ PRP_SHA: '' }, /sha must be the full 40-character head commit SHA/],
    [{ PRP_SHA: 'abc1234' }, /sha must be the full 40-character head commit SHA/],
    [{ PRP_PR_AUTHOR: '' }, /pr-author is required/],
    [{ PRP_PR_NUMBER: '' }, /pr-number must be a positive integer/],
    [{ PRP_PR_NUMBER: '4x' }, /pr-number must be a positive integer/],
  ];
  for (const [overrides, pattern] of cases) {
    const { github, core } = await authorize(baseEnv(overrides), { teams: { ie: { carol: 'active' } } });
    assert.equal(core.failures.length, 1, JSON.stringify(overrides));
    assert.match(core.failures[0], pattern);
    assert.equal(core.outputs.authorized, 'false');
    assert.equal(github.calls.teams.length, 0);
  }
});

test('with approver-teams, an approval from a write-access member of an approver team authorizes', async () => {
  const { github, core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'platform, ie' }), {
    teams: { ie: { bob: 'active' } },
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'approval:bob');
  // carol in the commenter teams, then bob in each approver team until one matches
  assert.deepEqual(
    github.calls.teams.map((call) => `${call.team_slug}:${call.username}`),
    ['ie:carol', 'platform:bob', 'ie:bob'],
  );
});

test('with approver-teams, an approval from a write-access reviewer outside the teams does not authorize', async () => {
  const { core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'ie' }), {
    teams: { ie: { eve: 'pending' } },
    reviews: [review(1, 'bob', 'APPROVED'), review(2, 'eve', 'APPROVED')],
    permissions: { carol: WRITE, bob: WRITE, eve: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.match(core.outputs.reason, /no approval from a member of team `TRI-IE\/ie` with write access/);
});

test('with approver-teams, an approver team member without write access does not authorize', async () => {
  const { github, core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'ie' }), {
    teams: { ie: { bob: 'active' } },
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: READ },
  });
  assert.equal(core.outputs.authorized, 'false');
  // write access is checked first, so bob's team membership is never looked up
  assert.deepEqual(
    github.calls.teams.map((call) => `${call.team_slug}:${call.username}`),
    ['ie:carol'],
  );
});

test('with approver-teams, an approval of an older SHA by a team member does not authorize', async () => {
  const { core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'ie' }), {
    teams: { ie: { bob: 'active' } },
    reviews: [review(1, 'bob', 'APPROVED', { commit: OLD })],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.equal(core.outputs.authorized, 'false');
});

test('with approver-teams, a team member who has commits in the PR still approves', async () => {
  // bob authored a commit, committed a rebase and clicked "Update branch"; the PR's commits are not even read
  const { github, core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'ie' }), {
    teams: { ie: { bob: 'active' } },
    reviews: [review(1, 'bob', 'APPROVED')],
    commits: [commit(OLD, 'bob'), commit(OLD, 'dave', 'bob'), commit(HEAD, 'bob', null)],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'true');
  assert.equal(core.outputs.via, 'approval:bob');
  assert.equal(github.calls.commits.length, 0);
});

test('with approver-teams, the PR author does not approve even as a team member', async () => {
  const { core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'ie' }), {
    teams: { ie: { dave: 'active' } },
    reviews: [review(1, 'dave', 'APPROVED')],
    permissions: { carol: WRITE, dave: WRITE },
  });
  assert.deepEqual(core.failures, []);
  assert.equal(core.outputs.authorized, 'false');
  assert.match(core.outputs.reason, /no approval from a member of team `TRI-IE\/ie` with write access who is not the PR author \(/);
});

test('with approver-teams, a team API error for an approver fails closed', async () => {
  const { core } = await authorize(baseEnv({ PRP_APPROVER_TEAMS: 'ie' }), {
    teams: { ie: { bob: 502 } },
    reviews: [review(1, 'bob', 'APPROVED')],
    permissions: { carol: WRITE, bob: WRITE },
  });
  assert.equal(core.failures.length, 1);
  assert.match(core.failures[0], /membership of `bob` in team `TRI-IE\/ie` failed \(status 502/);
  assert.equal(core.outputs.authorized, 'false');
});

test('approver-teams reaches the script through env and defaults to empty', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'authorize', 'action.yaml'), 'utf8');
  const block = /^  approver-teams:\n((?:    .*\n)+)/m.exec(text);
  assert.ok(block, 'no approver-teams input');
  assert.match(block[1], /^    default: ''$/m);
  assert.match(text, /^\s+PRP_APPROVER_TEAMS: \$\{\{ inputs\.approver-teams \}\}$/m);
  assert.deepEqual(loadConfig(baseEnv(), CONTEXT).approverTeams, []);
  assert.deepEqual(loadConfig(baseEnv({ PRP_APPROVER_TEAMS: 'ie, data' }), CONTEXT).approverTeams, ['ie', 'data']);
});
