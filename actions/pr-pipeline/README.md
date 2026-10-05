# pr-pipeline

`pr-pipeline` is a family of composite actions that provide the plumbing for PR-driven infrastructure pipelines.
The usual flow is a plan on every push, a deploy when someone comments `!deploy <stack>`, and a merge after a successful apply.
The actions do not run any IaC tool: each repository still calls Pulumi (or Terraform) itself.

All sub-actions share one version tag, `pr-pipeline/vX.Y.Z`.
Pin the exact version rather than the floating `pr-pipeline/v1` tag, because these actions gate deploys:

```yaml
- uses: TRI-Actions/custom-actions/actions/pr-pipeline/pr-context@pr-pipeline/v1.0.0
```

Every sub-action runs its logic inside `actions/github-script@v7`, so it uses the runner's bundled Node.
`node` does not need to be on `PATH`, and there are no npm dependencies and no build step.

| Sub-action | Purpose |
|---|---|
| [`pr-context`](#pr-context) | Resolve the PR, pin its head SHA and optionally check out exactly that commit |
| [`check-run`](#check-run) | Start or finish one named check run |
| [`sticky-comment`](#sticky-comment) | Create, update, recreate or delete a PR comment found by a hidden marker |
| [`parse-command`](#parse-command) | Parse and validate a comment command such as `!deploy 123456789012` |
| [`authorize`](#authorize) | Decide whether the commenter may run the command |
| [`plan-gate`](#plan-gate) | Require a successful plan check run for each stack on a commit |
| [`branch-freshness`](#branch-freshness) | Report whether the base branch changed the stack's paths since the merge base |
| [`merge-pr`](#merge-pr) | Merge the PR only if its head is still at the expected commit |

## The pipeline standard

Every repository that uses these actions follows the rules below.
The [examples](#examples) implement all of them.

### SHA discipline

The plan runs on the event's head SHA, not on the `refs/pull/<n>/merge` commit.
The deploy resolves the head SHA once with `pr-context` and checks out exactly that commit.
Every gate is evaluated against that SHA: approvals in `authorize`, plan check runs in `plan-gate` and the merge base in `branch-freshness`.
Right before the apply, the deploy reads the PR again and refuses to continue if it was closed or merged or its head moved.
`merge-pr` passes the same SHA to GitHub, so GitHub refuses the merge if the head moved after the apply.

### Concurrency

The plan workflow uses a workflow-level group per PR, `group: <repo>-plan-pr-<n>` with `cancel-in-progress: true`, so a new push cancels the older plan.
The deploy workflow has two jobs: a light `gate` job that parses the command, and an `apply` job with a job-level group per stack.
The apply group is `group: <repo>-apply-<stack>` with `cancel-in-progress: false`, so two PRs for the same stack never apply and merge at the same time.
Without it, the second PR's older program could revert the first PR's change in AWS while `main` contains both.
The group is job-level, not workflow-level, because every PR comment starts a deploy run, and a workflow-level group would let unrelated comments cancel a queued deploy.
The `gate` job exists because a job's concurrency group must be known before the job starts.
GitHub keeps at most one pending job per group: if a third deploy for the same stack is queued while one is already waiting, GitHub cancels the waiting one before it starts, and its author has to comment again.

### Check runs

A check run is created with `check-run` `mode: start` at the beginning of a phase, and the stack goes in `external-id`.
It is completed by exactly one `check-run` `mode: finish` step with `if: always()`, so it is also completed when the run fails or is cancelled.
A check run is never left `in_progress`, because `plan-gate` treats an in-progress newest plan as still running and blocks the deploy.
If the start step was skipped, its `id` output is empty and the finish step does nothing.

### Comments

Each purpose has one comment, found by the hidden marker `<!-- tri-pr-pipeline:<key> -->`.
Large bodies are written to a file and passed as `body-file`, never through `GITHUB_ENV` heredocs or the `body` input.
Bodies longer than `max-length` (default 60000, below GitHub's 65536 limit) are cut in the middle, with a link to the workflow run.
Status comments (plan, deploy) use `mode: recreate`, so the newest one is at the bottom of the conversation.
Informational comments (pre-commit, lint) use `mode: upsert`, so they are updated in place.
A comment matches only if its body starts with the marker line and its author is `comment-author` (default `github-actions[bot]`, compared case-insensitively), so a marker quoted or pasted by someone else is never updated or deleted.
When `github-token` is a PAT, set `comment-author` to the PAT user's login; for a GitHub App token, use `<app-slug>[bot]`.
Duplicate matching comments are deleted.

### Command grammar

Only the first non-empty line of the comment is read, with carriage returns stripped and surrounding whitespace trimmed.
The first token must equal the command exactly, case-sensitively, so `!Deploy`, `!deployx` and a quoted `> !deploy` do not match.
The remaining tokens, split on whitespace, are the arguments.
The argument count must be between `min-args` and `max-args`, and every argument must match `arg-pattern` in full, as if it were wrapped in `^(?:...)$`.
A rejected argument is echoed back with backticks and control characters removed and is capped at 60 characters.
Comment text only ever reaches the action through an input, which the action passes on through `env:`.
The actor is the commenter (`github.event.comment.user.login`).

### Deploy authorization

A deploy command is authorized only in one of two ways:

- The commenter is an active member of one of the configured teams.
- The commenter has the `admin`, `maintain` or `write` role, and the exact head SHA has an approval from a reviewer who also has one of those roles, is not the PR author, and did not author or commit any commit in the PR.

An approval of an older commit does not count, and neither does an approval that was dismissed or that the reviewer followed with a change request.
`web-flow`, the committer of commits made in the GitHub web UI, is ignored, so clicking "Update branch" excludes only the user who clicked it.
A re-run by anyone other than the commenter is rejected (`authorize` compares `triggering-actor`, which defaults to `${{ github.triggering_actor }}`), because a re-run of an old `!deploy` would resolve today's head under the original commenter's authority.
A plan that finished after the command was posted is rejected (`plan-gate` with `not-after: ${{ github.event.comment.created_at }}`), because the commenter could not have reviewed it.

### Deploy gates

The gates fail closed, and each one produces one specific rejection comment.
They are evaluated inside the per-stack `apply` job, after it acquired the stack's concurrency group, so they reflect the state at the moment of the apply.
The order is:

1. The command is valid (`parse-command`, in the `gate` job).
2. The PR is not from a fork (`pr-context` refuses to check out fork code).
3. The PR is still open and not merged (`state` and `merged` from the second `pr-context` call, which runs right before the apply).
4. The requested stack is the stack the PR changes (repository-specific, computed with the base branch's copy of the script, not the PR's).
5. The actor is authorized (`authorize`), by the rules in [Deploy authorization](#deploy-authorization).
6. The branch is fresh (`branch-freshness`): the base branch did not change the stack's paths since the merge base.
7. The plan for that stack on that SHA succeeded (`plan-gate`): the newest plan check run completed with `success`, no later than the moment the command was posted.
8. The head SHA did not change since the job started (the same second `pr-context` call, with `checkout: 'false'`).

Only then does the job apply, and then it merges with `merge-pr` pinned to the same SHA.

### Error reporting

Every failure posts what failed and why: the specific `error:` lines from the tool plus the tail of its log.
A rejection that the user can fix is not a step failure: `parse-command` sets `valid=false` and `error`, `authorize` sets `authorized=false` and `reason`, `plan-gate` sets `passed=false` and `reason`, and `branch-freshness` sets `stale=true` and `changed-paths`.
The workflow turns those outputs into one comment.
Unexpected errors (API errors, git errors, bad configuration) fail the step with a clear message, which includes the HTTP status for API errors.
The workflow then posts a comment that links the run.
A state lock is reported as "stack locked by another operation, re-run when it finishes", with no automatic retries.
Nothing is labelled drift, and nothing fails silently.
If the merge fails after the apply succeeded, the deploy comment says loudly that the stack is now ahead of `main`.

### Fork handling

Fork PRs are never planned with credentials and never deployed.
The plan job skips them with `if: github.event.pull_request.head.repo.full_name == github.repository`.
`pr-context` refuses to check out a fork PR when `checkout` is `true`, and reports `is-fork=true` either way.
A PR whose head repository was deleted counts as a fork.

## Reference

Inputs and outputs below are taken from each sub-action's `action.yaml`.
Every boolean input and output is the string `true` or `false`.

### `pr-context`

Resolves the pull request for a `pull_request`, `pull_request_target` or `issue_comment` event and optionally checks out its head commit.
On `issue_comment` the PR is read live with the API; on `pull_request` events the event payload is used.
The checkout uses `actions/checkout@v4` with the default token.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token with pull-requests: read permission |
| `sha` | no | `''` | Full commit SHA to use instead of the pull request head SHA |
| `checkout` | no | `true` | Check out the head SHA with actions/checkout (true/false). Pull requests from forks are refused when true |
| `fetch-depth` | no | `0` | fetch-depth passed to actions/checkout. 0 fetches full history |

| Output | Description |
|---|---|
| `pr-number` | Pull request number |
| `head-sha` | Head commit SHA (the sha input when given) |
| `head-ref` | Head branch name |
| `base-ref` | Base branch name |
| `base-sha` | Base commit SHA as recorded on the pull request |
| `state` | Pull request state (open/closed) |
| `merged` | Whether the pull request is merged (true/false) |
| `author` | Login of the pull request author |
| `is-fork` | Whether the head branch lives outside this repository, including a deleted head repository (true/false) |

### `check-run`

Starts (`in_progress`) or finishes (`completed`) a GitHub check run on a commit.
The `details_url` of a new check run points at the current workflow run.
Summaries are truncated to 65535 UTF-8 bytes.
The calling step must use `if: always()` for `mode: finish`.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token with checks: write permission |
| `mode` | yes | - | `start` (create an in_progress check run) or `finish` (complete it) |
| `name` | no | `''` | Check run name (start) |
| `sha` | no | `''` | Commit SHA to attach the check run to (start) |
| `external-id` | no | `''` | Optional external id stored on the check run, e.g. a stack or workspace name (start) |
| `title` | no | `''` | Output title. On start, output is only set when a title is given; on finish it defaults to the conclusion |
| `summary` | no | `''` | Output summary (Markdown). Truncated to the 65535 GitHub limit |
| `summary-file` | no | `''` | Path to a file, relative to the workspace, whose content is used as the summary instead of `summary` (finish) |
| `id` | no | `''` | Check run id returned by the start step (finish). Empty means start was skipped; the step then does nothing |
| `conclusion` | no | `''` | `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out` or `action_required` (finish) |

| Output | Description |
|---|---|
| `id` | Check run id (created on start, completed on finish) |

### `sticky-comment`

Creates, updates, recreates or deletes a PR comment identified by a hidden key marker.
The marker is `<!-- tri-pr-pipeline:<key> -->` on the first line of the body.
Only comments whose first line is exactly the marker and whose author is `comment-author` are matched; `*` matches any author.
A missing or unreadable body fails the step.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token with pull-requests write permission |
| `pr-number` | yes | - | Pull request number |
| `key` | yes | - | Comment key, must match `^[a-z0-9][a-z0-9:._-]*$` (e.g. `plan:infra`) |
| `body` | no | `''` | Comment body (Markdown). Required unless body-file is set or mode is delete. Use body-file for large output |
| `body-file` | no | `''` | Path to a file with the comment body, relative to the workspace. Takes precedence over body |
| `mode` | no | `upsert` | `upsert` (update the existing comment or create one), `recreate` (delete and post a new comment) or `delete` |
| `max-length` | no | `60000` | Maximum comment length; longer bodies are cut from the middle with a link to the workflow run |
| `comment-author` | no | `github-actions[bot]` | Login that posts with github-token; only its comments are matched (case-insensitive). If github-token is a PAT, set this to the PAT user login; for a GitHub App token, `<app-slug>[bot]`. `*` matches any author |

| Output | Description |
|---|---|
| `comment-id` | ID of the created or updated comment (empty for mode delete) |
| `comment-url` | URL of the created or updated comment (empty for mode delete) |

### `parse-command`

Parses a PR comment command (e.g. `!deploy 123456789012`) from the first non-empty line and validates its arguments.
A comment that does not start with the command gives `matched=false` and is not an error.
A matched command with bad arguments gives `valid=false` and a user-facing `error`, and the step still succeeds.
Every argument must match `arg-pattern` in full: a leading `^` and a trailing `$` are optional, and the pattern is compiled as `^(?:<pattern>)$` with the `u` flag.
The `u` flag rejects some escapes that a pattern without it allows, such as `\-` outside a character class.
Bad configuration (for example `min-args` greater than `max-args`, or an empty or invalid `arg-pattern`) fails the step.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token for actions/github-script (no API calls are made) |
| `body` | yes | - | Raw comment body |
| `command` | yes | - | Command that must be the first token, matched exactly and case-sensitively (e.g. `!deploy`) |
| `arg-pattern` | no | `^[A-Za-z0-9][A-Za-z0-9._-]*$` | JavaScript regex (`u` flag) every argument must match in full; `^` and `$` are implied (e.g. `[0-9]{12}`) |
| `min-args` | no | `0` | Minimum number of arguments |
| `max-args` | no | `1` | Maximum number of arguments |

| Output | Description |
|---|---|
| `matched` | Whether the comment starts with the command (true/false) |
| `valid` | Whether the command matched and its arguments are valid (true/false) |
| `args` | JSON array of arguments (empty unless valid) |
| `arg` | First argument, or empty |
| `error` | User-facing error when matched but invalid, otherwise empty |

### `authorize`

Authorizes a PR comment command via team membership, or for a commenter with write access via an approval of the head commit by a reviewer with write access who did not author or commit to the PR.
When `triggering-actor` is not empty and differs from `actor` (case-insensitively), the command is denied before teams or approvals are checked.
Teams are checked first, in the order given.
For approvals, each reviewer's latest review that is not `COMMENTED` or `PENDING` counts, and only if it is `APPROVED` on exactly `sha` and the reviewer is neither the PR author nor the author or committer of any commit in the PR.
`web-flow`, GitHub's committer for commits made in the web UI, is ignored, so clicking "Update branch" excludes only the user who clicked it.
Commits whose author or committer is not linked to a GitHub account cannot be attributed and exclude no one.
Commit authorship comes from git metadata, which whoever pushes a commit can set to anyone's email, so this exclusion stops honest self-approval but not a deliberately forged commit; only signed commits or the ruleset rule "Require approval of the most recent reviewable push" close that fully.
The GitHub API lists at most 250 commits of a PR, so a PR with 250 or more commits fails the step instead of being evaluated on a partial list.
The reviewer must have the `admin`, `maintain` or `write` role; custom repository roles do not qualify.
Approval-based authorization also requires the commenter to have the `admin`, `maintain` or `write` role, which is checked before reviews are read.
Once the head commit has a qualifying approval, any such commenter is authorized.
Team checks need a token that can read org membership: with a plain `GITHUB_TOKEN`, GitHub can answer 404, which looks like "not a member".
A denial sets `authorized=false` and `reason` without failing the step; an API error other than 404 fails the step and sets `reason`.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token; team checks need read:org, so pass a PAT when teams is set |
| `actor` | yes | - | Login of the comment author |
| `triggering-actor` | no | `${{ github.triggering_actor }}` | Login that triggered the run; must equal actor (case-insensitive), which blocks re-runs of another user's command; pass an empty string to skip the check |
| `teams` | no | `''` | Comma-separated team slugs whose active members are authorized (may be empty) |
| `org` | no | `${{ github.repository_owner }}` | Organization that owns the teams |
| `allow-approval` | no | `true` | Also authorize a commenter with write access when the head commit is approved by a reviewer with write access who is not the PR author and did not author or commit any commit in the PR (true/false) |
| `sha` | no | `''` | Full PR head commit SHA (required when allow-approval is true) |
| `pr-author` | no | `''` | Login of the PR author (required when allow-approval is true) |
| `pr-number` | no | `''` | PR number (required when allow-approval is true) |

| Output | Description |
|---|---|
| `authorized` | Whether the actor is authorized (true/false) |
| `via` | How authorization was granted, e.g. `team:ie` or `approval:alice`; empty when denied |
| `reason` | Human-readable explanation of the decision |

### `plan-gate`

Checks that the latest plan check run for each external id succeeded on a commit.
For each external id, only the newest plan check run (highest id) counts: it must be completed and have concluded `success`.
Older runs are ignored, including runs that never completed, so an orphaned `in_progress` run does not block a newer successful plan.
With `external-ids: '*'`, the newest run with the check name counts, whatever its external id.
With `not-after`, the newest run must also have completed at or before that time, so a command never approves a plan that finished after it was posted.
This guards against honest pushes made after the command, not against a deliberate forgery: the plan job runs PR code with a token that can write check runs, so a malicious PR could create a backdated successful check.
A gate that does not pass sets `passed=false` and `reason` without failing the step.
An API error fails the step, and so does a missing or invalid input: a `sha` that is not a full 40-character SHA, an empty `external-ids`, `*` combined with other ids, or a `not-after` that is not an ISO 8601 timestamp with a time zone.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token with checks: read permission |
| `sha` | yes | - | Full 40-character commit SHA whose plan check runs are evaluated |
| `check-name` | yes | - | Name of the plan check run |
| `external-ids` | yes | - | Whitespace-separated external ids that each need a successful plan, or `*` alone to match by check name only |
| `not-after` | no | `''` | ISO 8601 timestamp with a time zone, usually `github.event.comment.created_at`; when set, each newest plan must have completed at or before it |

| Output | Description |
|---|---|
| `passed` | true when every required plan succeeded, otherwise false |
| `reason` | Why the gate did not pass (empty when passed) |
| `check-url` | URL of the blocking check run, or of the first passing one |

### `branch-freshness`

Reports whether the base branch changed the given paths since the checked-out HEAD branched off it.
It needs `git` on the runner and a full-history checkout (`pr-context` uses `fetch-depth: 0` by default); a shallow clone fails the step.
The fetch uses the credentials that `actions/checkout` persisted.
Every failure, including invalid inputs, fails the step.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | GitHub token passed to actions/github-script (no API calls are made) |
| `base-ref` | yes | - | Base branch name, e.g. main |
| `paths` | yes | - | Newline or whitespace separated git pathspecs to compare, e.g. `123456789012/ shared/ Pipfile` |
| `remote` | no | `origin` | Git remote to compare against |
| `fetch` | no | `true` | Fetch the base branch from the remote first (true/false) |

| Output | Description |
|---|---|
| `stale` | Whether the base branch changed any of the paths after the merge base (true/false) |
| `changed-paths` | Newline separated files changed on the base branch, at most 50 followed by an "... and N more" line |
| `merge-base` | Merge base of HEAD and the base branch |
| `base-sha` | Commit SHA of the base branch that was compared |

### `merge-pr`

Merges a pull request only if its head is still at the expected commit.
GitHub answers 409 when the head moved, and the `error` output says so.
A 200 response counts as a merge only if it has `merged: true` and a 40-character merge commit SHA; otherwise the step fails with `GitHub did not confirm the merge of PR #<n>: <message>`.
Every failure sets `merged=false` and `error`, and fails the step.

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | no | `${{ github.token }}` | Token used to merge. Pass a PAT: merges made with GITHUB_TOKEN do not trigger push workflows |
| `pr-number` | yes | - | Pull request number |
| `sha` | yes | - | Full commit SHA the PR head must still point to; the merge is refused if the head moved |
| `method` | no | `merge` | Merge method: `merge`, `squash` or `rebase` |

| Output | Description |
|---|---|
| `merged` | Whether GitHub confirmed the merge with merged true and a merge commit SHA (true/false) |
| `merge-sha` | SHA of the merge commit (empty if not merged) |
| `error` | Why the merge failed (empty on success) |

## Examples

The examples use a repository `my-infra` with one Pulumi project per 12-digit AWS account directory and a shared `shared/` package.
Steps marked "repository-specific" are placeholders for your own scripts.
Every value that comes from the event or from a step output reaches a `run:` script through `env:`, never through `${{ }}` inside the script.

### Plan workflow

```yaml
name: plan

on:
  pull_request:
    branches: [main]

# A new push cancels the older plan for the same PR.
concurrency:
  group: my-infra-plan-pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  plan:
    # Fork PRs never run on our runners or with our credentials.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: codebuild-my-infra-${{ github.run_id }}-${{ github.run_attempt }}
    steps:
      # Checks out exactly the event's head SHA with full history.
      - id: pr
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/pr-context@pr-pipeline/v1.0.0

      # Repository-specific: the one stack this PR changes, validated before use.
      - id: stack
        run: |
          stack="$(./scripts/changed-stack.sh)"
          [[ "$stack" =~ ^[0-9]{12}$ ]] || { echo "::error::unexpected stack '$stack'"; exit 1; }
          echo "name=$stack" >> "$GITHUB_OUTPUT"

      - id: check
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/check-run@pr-pipeline/v1.0.0
        with:
          mode: start
          name: Pulumi Plan
          sha: ${{ steps.pr.outputs.head-sha }}
          external-id: ${{ steps.stack.outputs.name }}
          title: Plan running

      - id: fresh
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/branch-freshness@pr-pipeline/v1.0.0
        with:
          base-ref: ${{ steps.pr.outputs.base-ref }}
          paths: |
            ${{ steps.stack.outputs.name }}/
            shared/
            Pipfile.lock

      # Repository-specific: credentials and backend login go before this step.
      - id: plan
        if: steps.fresh.outputs.stale == 'false'
        working-directory: ${{ steps.stack.outputs.name }}
        run: |
          set -o pipefail
          pulumi preview --diff 2>&1 | tee "$RUNNER_TEMP/plan.txt"

      - id: render
        if: ${{ !cancelled() && steps.stack.outcome == 'success' }}
        env:
          STACK: ${{ steps.stack.outputs.name }}
          HEAD_SHA: ${{ steps.pr.outputs.head-sha }}
          STALE: ${{ steps.fresh.outputs.stale }}
          CHANGED_PATHS: ${{ steps.fresh.outputs.changed-paths }}
          PLAN_OUTCOME: ${{ steps.plan.outcome }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          out="$RUNNER_TEMP/plan.md"
          if [ "$STALE" = true ]; then
            printf '### Branch behind main\n\n`main` changed files that `%s` depends on:\n\n```\n%s\n```\n\nUpdate the branch to re-plan.\n' "$STACK" "$CHANGED_PATHS" > "$out"
          elif [ "$PLAN_OUTCOME" = success ]; then
            {
              printf '### Plan succeeded for `%s` at %s\n\nComment `!deploy %s` to apply.\n\n<details><summary>Plan</summary>\n\n```\n' "$STACK" "${HEAD_SHA:0:7}" "$STACK"
              cat "$RUNNER_TEMP/plan.txt"
              printf '```\n</details>\n'
            } > "$out"
          else
            {
              printf '### Plan failed for `%s` at %s\n\n```\n' "$STACK" "${HEAD_SHA:0:7}"
              grep -E '^[[:space:]]*error:' "$RUNNER_TEMP/plan.txt" || true
              printf '```\n\n<details><summary>Last 50 lines</summary>\n\n```\n'
              tail -n 50 "$RUNNER_TEMP/plan.txt" 2>/dev/null || true
              printf '```\n</details>\n\nSee the [workflow run](%s).\n' "$RUN_URL"
            } > "$out"
          fi

      - if: ${{ !cancelled() && steps.render.outcome == 'success' }}
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/sticky-comment@pr-pipeline/v1.0.0
        with:
          pr-number: ${{ steps.pr.outputs.pr-number }}
          key: plan:${{ steps.stack.outputs.name }}
          mode: recreate
          body-file: ${{ runner.temp }}/plan.md

      # The one finalizer: also runs on failure and cancel.
      - if: always()
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/check-run@pr-pipeline/v1.0.0
        with:
          mode: finish
          id: ${{ steps.check.outputs.id }}
          conclusion: ${{ job.status == 'cancelled' && 'cancelled' || steps.plan.outcome == 'success' && 'success' || 'failure' }}
          title: ${{ job.status == 'cancelled' && 'Plan cancelled' || steps.fresh.outputs.stale == 'true' && 'Branch behind main' || steps.plan.outcome == 'success' && 'Plan succeeded' || 'Plan failed' }}
          summary-file: ${{ runner.temp }}/plan.md

      # A stale branch fails the plan check without failing a step, so fail the job too.
      - if: ${{ !cancelled() && steps.fresh.outputs.stale == 'true' }}
        run: |
          echo "::error::Branch behind main"
          exit 1
```

### Deploy workflow

The `gate` job only parses the command, so the `apply` job can use the stack in its concurrency group.
`issue_comment` workflows always run the default branch's copy of the workflow file, so test changes to it in a testbed repository.
All other gates run inside `apply`, after it holds the stack's group.
`PIPELINE_PAT` stands for a token that can read team membership and merge, so the merge triggers push workflows.
The comments are posted with the default token, so `sticky-comment` keeps its default `comment-author` of `github-actions[bot]`.
A workflow that posts comments with a PAT sets `comment-author` to the PAT user's login, or it would never find its own earlier comment.

```yaml
name: deploy

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  checks: write
  pull-requests: write

jobs:
  gate:
    if: github.event.issue.pull_request && contains(github.event.comment.body, '!deploy')
    runs-on: codebuild-my-infra-${{ github.run_id }}-${{ github.run_attempt }}
    outputs:
      # Empty unless the command is valid.
      stack: ${{ steps.cmd.outputs.arg }}
    steps:
      - id: cmd
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/parse-command@pr-pipeline/v1.0.0
        with:
          body: ${{ github.event.comment.body }}
          command: '!deploy'
          arg-pattern: '^[0-9]{12}$'
          min-args: '1'
          max-args: '1'

      - if: steps.cmd.outputs.matched == 'true' && steps.cmd.outputs.valid == 'false'
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/sticky-comment@pr-pipeline/v1.0.0
        with:
          pr-number: ${{ github.event.issue.number }}
          key: deploy
          mode: recreate
          body: |
            ### Deploy rejected

            ${{ steps.cmd.outputs.error }}. Usage: `!deploy <12-digit account id>`.

      # A rejected command is a failed run, so it shows up red like every other rejection.
      - if: steps.cmd.outputs.matched == 'true' && steps.cmd.outputs.valid == 'false'
        env:
          ERROR: ${{ steps.cmd.outputs.error }}
        run: |
          echo "::error::Deploy rejected: $ERROR"
          exit 1

  apply:
    needs: gate
    if: needs.gate.outputs.stack != ''
    runs-on: codebuild-my-infra-${{ github.run_id }}-${{ github.run_attempt }}
    # One apply per stack at a time across all PRs; a queued deploy waits instead of cancelling.
    concurrency:
      group: my-infra-apply-${{ needs.gate.outputs.stack }}
      cancel-in-progress: false
    env:
      STACK: ${{ needs.gate.outputs.stack }}
    steps:
      # Resolves the head SHA once and checks out exactly that commit; refuses forks.
      - id: pr
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/pr-context@pr-pipeline/v1.0.0

      - id: check
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/check-run@pr-pipeline/v1.0.0
        with:
          mode: start
          name: Pulumi Apply
          sha: ${{ steps.pr.outputs.head-sha }}
          external-id: ${{ needs.gate.outputs.stack }}
          title: Apply running

      # Repository-specific: the stack this PR changes, computed with the base branch's copy of the script.
      - id: scope
        env:
          BASE_REF: ${{ steps.pr.outputs.base-ref }}
        run: |
          git show "origin/${BASE_REF}:scripts/changed-stack.sh" > "$RUNNER_TEMP/changed-stack.sh"
          echo "stack=$(bash "$RUNNER_TEMP/changed-stack.sh")" >> "$GITHUB_OUTPUT"

      # triggering-actor defaults to github.triggering_actor, so a re-run by another user is rejected.
      - id: auth
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/authorize@pr-pipeline/v1.0.0
        with:
          github-token: ${{ secrets.PIPELINE_PAT }}
          actor: ${{ github.event.comment.user.login }}
          teams: 'ie,rse'
          sha: ${{ steps.pr.outputs.head-sha }}
          pr-author: ${{ steps.pr.outputs.author }}
          pr-number: ${{ steps.pr.outputs.pr-number }}

      - id: fresh
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/branch-freshness@pr-pipeline/v1.0.0
        with:
          base-ref: ${{ steps.pr.outputs.base-ref }}
          paths: |
            ${{ needs.gate.outputs.stack }}/
            shared/
            Pipfile.lock

      - id: plan
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/plan-gate@pr-pipeline/v1.0.0
        with:
          sha: ${{ steps.pr.outputs.head-sha }}
          check-name: Pulumi Plan
          external-ids: ${{ needs.gate.outputs.stack }}
          # A plan that finished after the comment was posted is not approved by it.
          not-after: ${{ github.event.comment.created_at }}

      # Reads the PR again, right before the apply: its state and its head.
      - id: recheck
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/pr-context@pr-pipeline/v1.0.0
        with:
          checkout: 'false'

      # The gates in order: the first one that fails writes the rejection and fails the step.
      - id: gates
        env:
          STATE: ${{ steps.recheck.outputs.state }}
          MERGED: ${{ steps.recheck.outputs.merged }}
          SCOPE: ${{ steps.scope.outputs.stack }}
          AUTHORIZED: ${{ steps.auth.outputs.authorized }}
          AUTH_REASON: ${{ steps.auth.outputs.reason }}
          STALE: ${{ steps.fresh.outputs.stale }}
          CHANGED_PATHS: ${{ steps.fresh.outputs.changed-paths }}
          PLAN_PASSED: ${{ steps.plan.outputs.passed }}
          PLAN_REASON: ${{ steps.plan.outputs.reason }}
          HEAD_SHA: ${{ steps.pr.outputs.head-sha }}
          HEAD_NOW: ${{ steps.recheck.outputs.head-sha }}
        run: |
          reject() { printf '### Deploy rejected\n\n%s\n' "$1" > "$RUNNER_TEMP/deploy.md"; echo "::error::deploy rejected"; exit 1; }
          [ "$STATE" = open ] && [ "$MERGED" = false ] || reject "The PR is not open."
          [ "$SCOPE" = "$STACK" ] || reject "This PR changes \`${SCOPE:-no stack}\`, not \`$STACK\`."
          [ "$AUTHORIZED" = true ] || reject "$AUTH_REASON"
          [ "$STALE" = false ] || reject "$(printf '`main` changed files that `%s` depends on:\n\n```\n%s\n```\n\nUpdate the branch, wait for the new plan and comment again.' "$STACK" "$CHANGED_PATHS")"
          [ "$PLAN_PASSED" = true ] || reject "$PLAN_REASON"
          [ "$HEAD_NOW" = "$HEAD_SHA" ] || reject "The PR head moved from ${HEAD_SHA:0:7} to ${HEAD_NOW:0:7}. Wait for the new plan and comment again."

      # Repository-specific: credentials and backend login go before this step.
      - id: apply
        working-directory: ${{ needs.gate.outputs.stack }}
        run: |
          set -o pipefail
          status=0
          pulumi up --yes --skip-preview 2>&1 | tee "$RUNNER_TEMP/apply.log" || status=$?
          if [ "$status" = 0 ]; then title="Deploy succeeded for \`$STACK\`"; else title="Deploy failed for \`$STACK\`"; fi
          if grep -q 'the stack is currently locked' "$RUNNER_TEMP/apply.log"; then
            title="Stack \`$STACK\` is locked by another operation, re-run when it finishes"
          fi
          {
            printf '### %s\n\n```\n' "$title"
            grep -E '^[[:space:]]*error:' "$RUNNER_TEMP/apply.log" || true
            printf '```\n\n<details><summary>Last 50 lines</summary>\n\n```\n'
            tail -n 50 "$RUNNER_TEMP/apply.log"
            printf '```\n</details>\n'
          } > "$RUNNER_TEMP/deploy.md"
          exit "$status"

      - id: merge
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/merge-pr@pr-pipeline/v1.0.0
        with:
          github-token: ${{ secrets.PIPELINE_PAT }}
          pr-number: ${{ steps.pr.outputs.pr-number }}
          sha: ${{ steps.pr.outputs.head-sha }}

      - if: failure() && steps.apply.outcome == 'success'
        env:
          MERGE_ERROR: ${{ steps.merge.outputs.error }}
        run: |
          printf '\n### Applied but not merged\n\n`%s` now has this PR applied, but `main` does not contain it: %s\nMerge the PR by hand or revert the change in AWS.\n' "$STACK" "$MERGE_ERROR" >> "$RUNNER_TEMP/deploy.md"

      # A step that failed before writing a body (an API or git error) still gets a comment.
      - if: always()
        env:
          JOB_STATUS: ${{ job.status }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          [ -s "$RUNNER_TEMP/deploy.md" ] || printf '### Deploy ended without a result\n\nThe run ended with status `%s`. See the [workflow run](%s).\n' "$JOB_STATUS" "$RUN_URL" > "$RUNNER_TEMP/deploy.md"

      # Posts with the default token, so the default comment-author, github-actions[bot], finds the previous deploy comment.
      - if: always()
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/sticky-comment@pr-pipeline/v1.0.0
        with:
          pr-number: ${{ github.event.issue.number }}
          key: deploy
          mode: recreate
          body-file: ${{ runner.temp }}/deploy.md

      - id: result
        if: always()
        env:
          JOB_STATUS: ${{ job.status }}
          GATES: ${{ steps.gates.outcome }}
          APPLY: ${{ steps.apply.outcome }}
          MERGED: ${{ steps.merge.outputs.merged }}
        run: |
          if [ "$JOB_STATUS" = cancelled ]; then title="Cancelled"
          elif [ "$MERGED" = true ]; then title="Deployed and merged"
          elif [ "$APPLY" = success ]; then title="Applied but not merged"
          elif [ "$APPLY" = failure ]; then title="Deploy failed"
          elif [ "$GATES" = failure ]; then title="Deploy rejected"
          else title="Deploy did not run"
          fi
          echo "title=$title" >> "$GITHUB_OUTPUT"

      # The one finalizer, after the merge, so a failed merge is a failed check.
      - if: always()
        uses: TRI-Actions/custom-actions/actions/pr-pipeline/check-run@pr-pipeline/v1.0.0
        with:
          mode: finish
          id: ${{ steps.check.outputs.id }}
          conclusion: ${{ job.status == 'cancelled' && 'cancelled' || steps.merge.outputs.merged == 'true' && 'success' || 'failure' }}
          title: ${{ steps.result.outputs.title }}
          summary-file: ${{ runner.temp }}/deploy.md
```

## Development

Layout:

- `<sub>/action.yaml`: one composite action per sub-action, each a single `actions/github-script@v7` step (plus `actions/checkout@v4` in `pr-context`).
- `lib/<module>.js`: CommonJS modules with Node 20 built-ins only, exporting pure helpers and `run({ github, context, core, env })`.
- `test/<module>.test.js`: `node:test` suites with inline fakes for `github` and `core`.
- `test/structure.test.js`: checks every `action.yaml` against the first two rules below, and that its `require` line points at an existing `lib/` file.

Rules for changes:

- Inputs reach the script only through `env:`, as `PRP_` plus the input name in upper snake case (`pr-number` becomes `PRP_PR_NUMBER`); never put `${{ inputs.* }}` or `${{ github.event.* }}` inside a `script:` or `run:` block.
- Each github-script step sets `ACTION_PATH: ${{ github.action_path }}` and loads `lib/` relative to it, because inside github-script `GITHUB_ACTION_PATH` points at github-script itself.
- Unexpected errors fail the step with a clear message (including the HTTP status for API errors); rejections the workflow should report set outputs instead.

### Running the tests

Run the commands from the repository root.
Locally, with Docker:

```bash
docker run --rm -v "$PWD":/w -w /w node:20 sh -c 'node --test actions/pr-pipeline/test/*.test.js'
```

With Node 20 or later on `PATH`:

```bash
node --test actions/pr-pipeline/test/*.test.js
```

The `branch-freshness` tests create throwaway git repositories, so they also need `git`.
CI runs the same command in the `pr-pipeline-tests` job of `.github/workflows/main.yaml`.

### Releasing

The whole family is released as one action named `pr-pipeline` by `.github/scripts/release.sh`, so every sub-action gets the same `pr-pipeline/vX.Y.Z` tag.
A new family starts from `v0.0.0`, so the first release needs the `major` label to become `v1.0.0`.
