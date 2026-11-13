# Codex Mention

> **Draft.** It hasn't had an InfoSec review, and the Bedrock role it defaults to (`CodexBedrockGHA`) doesn't exist yet. See [Before the first release](#before-the-first-release).

Answers `@codex <question>` on issues and PR comments using the [Codex CLI](https://github.com/openai/codex) on Amazon Bedrock. It's answer-only: Codex can read the checkout and run read-only commands in its sandbox, but it can't write, push or reach the network, and it never holds the GitHub token. Only commenters with **write, maintain or admin** on the repo can trigger it, whatever their author association: a read-only org `MEMBER`, a read-only collaborator or someone with triage is skipped quietly. On a pull request from a fork, it fails closed unless the caller sets `allow-fork-prs: "true"` (see [Fork PRs](#fork-prs)). Each PR answer is tied to the head commit at the time of the comment: that commit is checked out, and the reply names it.

**This isn't OpenAI's own `@codex`.** That's Codex cloud, which needs a ChatGPT or OpenAI account and doesn't run on Bedrock. If the OpenAI Codex GitHub app is installed on the same repo, both will answer, so don't install both.

**Pin by commit SHA.** The author gate and the account and role model match [claude-mention](../claude-mention/README.md). The model-side hardening is different, because Codex's main tool is a shell. The comments in `action.yaml` explain it.

## How it differs from claude-mention

| | claude-mention | codex-mention |
| --- | --- | --- |
| Model tools | Read/Grep/Glob, plus one inline-comment write tool, with no Bash | A shell in Codex's bubblewrap sandbox: read-only, no network, fresh PID namespace |
| GitHub token | Held by the action and the model's write tool | Never given to Codex. A later step posts the answer |
| AWS credentials | `GITHUB_ENV` for the job, cleared at the end | Minted inside the Answer step only, and passed to Codex in a cleared environment. Child shells get none |
| Repo config | CLAUDE.md and `.claude/` restored from the default branch | AGENTS.md and `.codex/` aren't loaded: the project is untrusted and `project_doc_max_bytes = 0` |
| Bedrock API | `bedrock:InvokeModel*` (bedrock-runtime) | `bedrock-mantle:CreateInference` (Mantle) |
| Spend limit | `max-turns` | A 10-minute `timeout` and `reasoning-effort` |
| Deny-rule test | A canary run, plus a direct CLI test on the GHES runner | Built in: every run tests the sandbox with `codex sandbox` before credentials exist, and stops if a denied read succeeds |
| Install | Bun tarball, SHA-512 pinned | `codex-package-<arch>` release tarball, SHA-256 pinned (bundles bwrap and rg) |

## Inputs

| Input | Default | |
| --- | --- | --- |
| `aws-auth` | `oidc-direct` | `oidc-direct` (github.com) or `runner` (GHES). The federated `oidc` chain isn't supported. |
| `account-id` | `550939891544` | |
| `target-role-name` | `CodexBedrockGHA` | oidc-direct only |
| `region` | `us-east-1` | US regions only |
| `model` | `openai.gpt-5.6-sol` | A regional `openai.gpt-*` ID. `global.` IDs are refused because they route outside the US. |
| `reasoning-effort` | `medium` | `low`, `medium` or `high` |
| `runner-bedrock-role-arn` | | Required for `runner`. There's no `allow-runner-credentials` opt-in. |
| `allow-fork-prs` | `false` | `"true"` answers fork PRs, from PR conversation comments only. See [Fork PRs](#fork-prs). |
| `github-token` | `github.token` | Must be the job token |

## Example: github.com

```yaml
name: Codex Mention
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened]

concurrency:
  group: codex-mention-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  answer:
    if: contains(github.event.comment.body || github.event.issue.body, '@codex')
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      id-token: write
      pull-requests: write
      issues: write
    steps:
      - uses: TRI-Actions/custom-actions/actions/codex-mention@<sha> # codex-mention/v0.1.0
```

Keep the `concurrency` group: it stops two answers on the same issue or PR from running at once. Keep the job to this one step, with no build, test or install steps: the job checks out the PR's code, and nothing in it should run outside Codex's sandbox. The action follows the same rule itself: its own `python3` runs with `-I` from `runner.temp`, so a `json.py` in the PR is never imported.

On GHES, use the CodeBuild `runs-on` label, drop `id-token: write`, and pass `aws-auth: runner` with `runner-bedrock-role-arn`. Use one of the isolated Claude runners in 550939891544, never a runner in a team VPC. The runner needs root or passwordless sudo (for `/etc/codex/requirements.toml`) and unprivileged user namespaces (for the sandbox). If either is missing, the action fails rather than run Codex unsandboxed.

The OIDC subjects are the same as claude-mention's: `…:pull_request` for inline comments, and `…:ref:refs/heads/<default>` for issues and PR conversations.

## Fork PRs

Off by default: a fork PR fails closed. With `allow-fork-prs: "true"`:

- **Only a comment in the PR conversation is answered.** `issue_comment` runs the default branch's workflow and this action, never the fork's, and uses the `…:ref:refs/heads/<default>` OIDC subject that's already in the trust policy. No new subject, and no `:*`.
- **Inline review comments on a fork PR are skipped.** GitHub runs `pull_request_review_comment` for a fork with a read-only token, no `id-token`, and the workflow from the PR's merge ref, so it couldn't answer anyway. The log says to ask in the conversation instead.
- **The commenter still needs write, maintain or admin.** That comment is the deliberate act, the way the label is for claude-review. A fork author without write can't trigger it on their own PR.
- **The fork's code is data, never run.** It's checked out at the head commit Guard resolved and read only inside Codex's sandbox. AGENTS.md, `.codex/` and `.rules` aren't loaded, the action's own `python3` doesn't import from the checkout, the self-test checks a symlink in the checkout can't reach a denied file, and the prompt tells the model the files came from outside the repo. There are still no build, test or install steps in the job.
- **What's left is prompt injection,** for example a file written to steer the answer. Codex has no credentials in its shell, no network and no GitHub token, so the result is a misleading comment marked "advisory", which is the same exposure a same-repo PR has.

Commit binding is weaker than claude-review's. The head SHA is the one Guard sees when the job starts, not one the commenter saw, so a fork push in the seconds between the comment and the job is answered. The reply names the commit it read and flags a later push, and that's the binding. Commit dates are forgeable, so the action doesn't try to compare them with the comment time.

## Before the first release

Infrastructure:

- [ ] A `CodexBedrockGHA` role in 550939891544, trusted through pulumi-cross-account like `ClaudeCodeBedrockGHA` and allowed `bedrock-mantle:CreateInference` (plus `Get*`/`List*` if Codex needs them) in us-east-1 only.
- [ ] OpenAI model access in us-east-1 for the chosen model. Confirm `openai.gpt-5.6-sol` is served there through Mantle.
- [ ] Invocation logging: confirm whether Bedrock model invocation logging captures Mantle calls. If it doesn't, find what does (CloudTrail data events?) before claiming coverage.
- [ ] GHES: a Bedrock-only runner role with the Mantle action, modeled on `ClaudeReviewBedrock`.
- [ ] GHES network path: Mantle is a different hostname (`bedrock-mantle.<region>.api.aws`) from bedrock-runtime, so a VPC runner that reaches Bedrock through an interface endpoint may not reach it. `env -i` also drops `HTTPS_PROXY`, `NO_PROXY` and `AWS_CA_BUNDLE`; pass them through if the runner needs them.

For InfoSec: `bedrock-mantle:CreateInference` is scoped to Mantle *projects*, not models, so IAM can't limit the role to one model. The model limit is the `model` regex in the action and whatever OpenAI model access the account enables.

Canary, on [codex-example](https://github.com/TRI-Actions/codex-example) (see its `canary/README.md`), with a PR that tries each of these:

- [ ] The sandbox can't read `$RUNNER_TEMP/**` or `~/.aws`, and `/proc/<codex pid>/environ` isn't visible from the shell.
- [ ] Child shells have no `AWS_*`, `ACTIONS_*` or `GITHUB_TOKEN` in `env`.
- [ ] No network from the shell (`curl https://example.com` fails).
- [ ] `sudo -n true` fails from the shell. Hosted runners have passwordless sudo, so this checks the sandbox's user namespace and `--cap-drop ALL`.
- [ ] Shell commands that use the `apply_patch` and `codex-linux-sandbox` helpers under `CODEX_HOME` still work with the deny list in place.
- [ ] A PR's `AGENTS.md` and `.codex/config.toml` (with a hook and an MCP server) aren't loaded.
- [ ] The only egress from the Codex process is `bedrock-mantle.<region>.api.aws`.
- [ ] The probe step fails closed on a runner without user namespaces.
- [ ] The built-in sandbox self-test passes on a github.com runner and on the GHES runner. It was checked only in a Linux container (passes with the deny list, stops the run without it).
- [ ] A commenter with read or triage access is skipped, including a read-only org `MEMBER`.
- [ ] A push to the PR during a run produces the "new commits were pushed" note.
- [ ] A PR with a `json.py` and a `secrets.py` at the root (each writing a marker file) answers normally, and no marker appears. Checked in a container only.
- [ ] A fork PR with `allow-fork-prs` off fails closed. With it on, a conversation comment is answered at the fork's head commit (on github.com and on GHES, where the fork commit is fetched through `refs/pull/N/head`), and an inline comment is skipped.
- [ ] On a fork PR, a commenter without write, including the fork author, is skipped.

Review and upkeep:

- [ ] InfoSec review of this action, and of the data-handling terms for OpenAI models on Bedrock.
- [ ] One approval on the PR from someone other than the author.
- [ ] A named owner who watches [openai/codex releases](https://github.com/openai/codex/releases) for security fixes and bumps `CODEX_VERSION` and both SHA-256s by PR.

## How it handles InfoSec's claude-* review items

These come from InfoSec's reviews of claude-review and claude-mention (the "Security review request — Claude Code in GitHub Actions" thread). They're listed here so the codex-mention review can start from them.

| InfoSec item | codex-mention |
| --- | --- |
| No OIDC wildcard subject; no shared federated role | `oidc-direct` only, to a Codex-only role, with explicit `…:pull_request` and `…:ref:refs/heads/<default>` subjects. The federated `oidc` chain isn't supported |
| Reviewer credentials reachable from file tools | Credentials exist only inside the Answer step and never reach the model's shell. The sandbox denies runner.temp and the runner user's credential files. `persist-credentials: false` |
| Prove the deny rules directly, without depending on the model refusing | Every run's self-test, plus canary C3, C4 and C5 |
| Runner mode must not fail open | `runner-bedrock-role-arn` is required, with no opt-in to the runner's own role. The caller ARN is checked against the expected role |
| GHES runner isolation | Isolated Claude runners in 550939891544 only, with no build or test steps in the job |
| Author gate, with write access required for every commenter | The repo permission is checked for every commenter, as in claude-mention since custom-actions#55. Triage and read are skipped |
| Bind work to a specific commit | The PR head SHA is resolved in Guard, that commit is checked out, and the reply names it and notes a later push |
| The caller workflow can come from the PR head | `issue_comment` runs the default branch's `codex.yml`, but an inline `pull_request_review_comment` runs the PR branch's copy, which can use the `…:pull_request` OIDC subject. The control is CODEOWNERS on `.github/**`, as in codex-example |
| Fork PRs | **Changed from the first draft**, which refused forks outright. Now off by default and failing closed. With `allow-fork-prs`, only a write-access commenter's PR conversation comment is answered, at the fork's head commit, with the code read only in the sandbox. See [Fork PRs](#fork-prs), including the weaker commit binding |
| Nothing from the PR runs outside the sandbox | The action's `python3` runs with `-I` from `runner.temp`, so a planted `json.py` isn't imported next to the AWS session. The self-test also covers a symlink in the checkout |
| Reject personal access tokens | `ghp_`, `github_pat_`, `gho_` and `ghu_` are refused |
| Pin everything | `actions/checkout` is pinned by SHA. Codex comes from the GitHub release, pinned by version and SHA-256. There's no fork and no third-party action |
| Repo steering files | `AGENTS.md`, `.codex/` and `.rules` aren't loaded, and the prompt claims nothing it doesn't do |
| Prompt traceability | The prompt's SHA-256 is in the job log |
| Spend bounds and invocation logging | A 10-minute timeout and the job's `timeout-minutes`. Whether Bedrock logging covers Mantle is still open (see above) |
| Egress | GitHub-hosted runners have open egress, and the model's shell has none. On GHES, NAT egress as for Claude, with the same later allowlist and VPC endpoints |
