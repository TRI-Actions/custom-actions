# Codex Mention

> **Draft.** It hasn't had an InfoSec review, and the Bedrock role it defaults to (`CodexBedrockGHA`) doesn't exist yet. See [Before the first release](#before-the-first-release).

Answers `@codex <question>` on issues and PR comments using the [Codex CLI](https://github.com/openai/codex) on Amazon Bedrock. It's answer-only: Codex can read the checkout and run read-only commands in its sandbox, but it can't write, push or reach the network, and it never holds the GitHub token. Only commenters whose association is **OWNER, MEMBER or COLLABORATOR**, or who have **write, maintain or admin** on the repo, can trigger it. Everyone else is skipped quietly. On a pull request, only same-repo PRs are answered; a fork PR fails closed.

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

On GHES, use the CodeBuild `runs-on` label, drop `id-token: write`, and pass `aws-auth: runner` with `runner-bedrock-role-arn`. The runner needs root or passwordless sudo (for `/etc/codex/requirements.toml`) and unprivileged user namespaces (for the sandbox). If either is missing, the action fails rather than run Codex unsandboxed.

The OIDC subjects are the same as claude-mention's: `…:pull_request` for inline comments, and `…:ref:refs/heads/<default>` for issues and PR conversations.

## Before the first release

Infrastructure:

- [ ] A `CodexBedrockGHA` role in 550939891544, trusted through pulumi-cross-account like `ClaudeCodeBedrockGHA` and allowed `bedrock-mantle:CreateInference` (plus `Get*`/`List*` if Codex needs them) in us-east-1 only.
- [ ] OpenAI model access in us-east-1 for the chosen model. Confirm `openai.gpt-5.6-sol` is served there through Mantle.
- [ ] Invocation logging: confirm whether Bedrock model invocation logging captures Mantle calls. If it doesn't, find what does (CloudTrail data events?) before claiming coverage.
- [ ] GHES: a Bedrock-only runner role with the Mantle action, modeled on `ClaudeReviewBedrock`.
- [ ] GHES network path: Mantle is a different hostname (`bedrock-mantle.<region>.api.aws`) from bedrock-runtime, so a VPC runner that reaches Bedrock through an interface endpoint may not reach it. `env -i` also drops `HTTPS_PROXY`, `NO_PROXY` and `AWS_CA_BUNDLE`; pass them through if the runner needs them.

For InfoSec: `bedrock-mantle:CreateInference` is scoped to Mantle *projects*, not models, so IAM can't limit the role to one model. The model limit is the `model` regex in the action and whatever OpenAI model access the account enables.

Canary, on `claude-code-example`, with a PR that tries each of these:

- [ ] The sandbox can't read `$RUNNER_TEMP/**` or `~/.aws`, and `/proc/<codex pid>/environ` isn't visible from the shell.
- [ ] Child shells have no `AWS_*`, `ACTIONS_*` or `GITHUB_TOKEN` in `env`.
- [ ] No network from the shell (`curl https://example.com` fails).
- [ ] `sudo -n true` fails from the shell. Hosted runners have passwordless sudo, so this checks the sandbox's user namespace and `--cap-drop ALL`.
- [ ] Shell commands that use the `apply_patch` and `codex-linux-sandbox` helpers under `CODEX_HOME` still work with the deny list in place.
- [ ] A PR's `AGENTS.md` and `.codex/config.toml` (with a hook and an MCP server) aren't loaded.
- [ ] The only egress from the Codex process is `bedrock-mantle.<region>.api.aws`.
- [ ] The probe step fails closed on a runner without user namespaces.

Review:

- [ ] InfoSec review of this action, and of the data-handling terms for OpenAI models on Bedrock.
