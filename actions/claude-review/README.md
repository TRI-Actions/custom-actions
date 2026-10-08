# Claude Review

Hardened, review-only Claude Code PR review on Bedrock. Works on github.com and on shared-services GHE. Claude reads the diff and leaves inline findings. It never approves, pushes or runs shell commands.

- `review-type: general` covers correctness and security on every PR.
- `review-type: security` is a security-focused second pass, run on security-relevant paths.

**Pin by commit SHA, never by tag or branch.** Not for export-controlled, partner-NDA or personal-data repos.

---

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `review-type` | `general` or `security` | `general` |
| `aws-auth` | `oidc` (github.com: OIDC → federated role → Bedrock role) or `runner` (GHES CodeBuild runner role) | `oidc` |
| `account-id` | Bedrock account (oidc). The default is the proof-of-concept account; **team callers must pass their own** | `550939891544` |
| `target-role-name` | Bedrock role (oidc) | `ClaudeCodeBedrockGHA` |
| `federated-role-name` | Federated role base name (oidc) | `GHAFederatedRole` |
| `region` | US region | `us-west-2` |
| `model` | `us.anthropic.claude-*` inference profile, optionally with a `:N` version suffix | `us.anthropic.claude-sonnet-5` |
| `max-turns` | Turn cap | `30` |
| `runner-bedrock-role-arn` | runner only. A Bedrock-only role assumed for the run (15-minute session, session policy limited to `bedrock:InvokeModel*`). **Required for `runner`** unless `allow-runner-credentials` is set | `""` |
| `allow-runner-credentials` | runner only. `"true"` runs without `runner-bedrock-role-arn`, exporting the runner role's own credentials to the model's process. A temporary, visible opt-in | `"false"` |
| `github-token` | Must be the job's own `GITHUB_TOKEN`. Personal access tokens (`ghp_`, `github_pat_`) are rejected | `github.token` |

## Repo-specific guidance

Put review guidance for your repo in **`.github/claude-review.md`** on your **default branch**. The action reads it through the GitHub API from the default branch, never from the PR's checkout or from a workflow input, because a PR can edit both. A PR that changes the file has no effect on its own review; the change applies once it's reviewed and merged.

- Up to 4 KB of UTF-8 text. Larger files, or files with control characters, fail the review (`blocked`).
- Its SHA-256, and the SHA-256 of the full prompt, are recorded in `verdict.json` as `guidance_sha256` and `prompt_sha256`.
- It's instructions to the model only. It can't change tools, flags, or what the verdict means.

This protects the prompt, not the pipeline: your workflow file still runs from the PR head. Anything that gates on the verdict must still refuse PRs touching `.github/`, `CLAUDE.md`, `.claude/` or `.mcp.json`, and check the head SHA.

## Outputs

| Name | Description |
|------|-------------|
| `ran` | `false` for drafts |
| `verdict` | `clean` or `blocked` |
| `detail` | Counts and the reason |
| `verdict-file` | Path to `verdict.json`. Upload it as the `claude-verdict` artifact |

## Not configurable

These are fixed inside the action:

- `--restricted --setting-sources user --strict-mcp-config`: repo `.claude/settings.json`, hooks and repo MCP servers don't load.
- The only tool is inline comments. `Bash`, `WebFetch` and `WebSearch` are denied.
- Reads are denied on `/proc/**`, the runner temp directory (which holds `GITHUB_ENV` with the AWS keys) and `.git/**` (which holds the checkout token).
- Sessions last 900s, named `claude-review-<run_id>`. `configure-aws-credentials` is pinned by SHA. Role-chained sessions can't be refreshed, so a review that runs past 15 minutes fails, and the verdict records a failed review as `blocked`. Keep `timeout-minutes` near 15.
- `CLAUDE.md`, `CLAUDE.local.md`, `.claude/`, `.mcp.json` and similar files are restored from the PR's base branch before the CLI starts, with the PR's copies under `.claude-pr/` for review. `TRI-Actions/claude-code-action` does this (upstream `restoreConfigFromBase()`); the log shows `Restoring ... (PR head is untrusted)`.
- Tools that edit files or start agents (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Agent`) are denied explicitly.
- The caller's identity is checked against the expected role before the review starts.
- Bun is installed before any credential is in the environment: the platform tarball is fetched from the public npm registry and checked against a pinned SHA-512. No npm install scripts run.
- The AWS credentials the action exports are blanked when it finishes, so later steps in your job don't inherit them. Keep the job single-purpose anyway.
- Only same-repo PRs; anything else fails closed. Drafts are skipped.
- No commit status (forgeable) and no approval.

Every `uses:` inside the action is on the GHES allowlist (`actions/*`, `aws-actions/*`, `TRI-Actions/*`).

---

## Example: github.com

`.github/workflows/claude.yml`:

```yaml
name: Claude Review
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
      id-token: write
      pull-requests: write
      issues: write
    concurrency:
      group: claude-review-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    steps:
      - id: claude
        uses: TRI-Actions/custom-actions/actions/claude-review@<sha>
        # Repo guidance goes in .github/claude-review.md on the default branch.
      - if: always() && steps.claude.outputs.verdict-file != ''
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: claude-verdict
          path: ${{ steps.claude.outputs.verdict-file }}
          retention-days: 7
```

## Example: shared-services GHE (CodeBuild runner)

```yaml
name: Claude Review
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: codebuild-claude-runner-<repo>-${{ github.run_id }}-${{ github.run_attempt }}
    timeout-minutes: 25
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - id: claude
        uses: TRI-Actions/custom-actions/actions/claude-review@<sha>
        with:
          aws-auth: runner
          runner-bedrock-role-arn: arn:aws:iam::<ACCOUNT>:role/<BedrockOnlyRole>
          region: us-east-1
      # upload-artifact v4 raises GHESNotSupportedError on GHES 3.20.
      - if: always() && steps.claude.outputs.verdict-file != ''
        uses: actions/upload-artifact@ff15f0306b3f739f7b6fd43fb5d26cd321bd4de5 # v3.2.1
        with:
          name: claude-verdict
          path: ${{ steps.claude.outputs.verdict-file }}
          retention-days: 7
```

## Security pass on security-relevant paths

This is a separate workflow, because `paths:` applies to the whole workflow. Use the same job as above with `review-type: security` and a cost-free trigger filter. Add paths for your stack, but don't remove any from this list:

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
    paths:
      - '**/*.tf'
      - '**/*.tf.json'
      - '**/*.tfvars'
      - '**/Pulumi*.yaml'
      - '**/cdk*.json'
      - '**/*-stack.*'
      - '**/template*.y*ml'
      - '**/serverless.y*ml'
      - '**/*.bicep'
      - '**/charts/**'
      - '**/k8s/**'
      - '**/*.k8s.y*ml'
      - '**/policies/**'
      - '**/roles/**'
      - '**/iam/**'
      - '**/*policy*.json'
      - '.github/**'
      - 'CODEOWNERS'
      - '**/CLAUDE.md'
      - '.claude/**'
      - '.claude-plugin/**'
      - '**/.mcp.json'
      - '**/Dockerfile*'
      - '**/docker-compose*.y*ml'
      - '**/*.sh'
      - '**/requirements*.txt'
      - '**/pyproject.toml'
      - '**/poetry.lock'
      - '**/package.json'
      - '**/package-lock.json'
      - '**/yarn.lock'
      - '**/pnpm-lock.yaml'
      - '**/go.mod'
      - '**/go.sum'
      - '**/.terraform.lock.hcl'
      - '**/.npmrc'
      - '**/buildspec*.y*ml'
      - '.gitmodules'
```

## Prerequisites (oidc)

Your repo's subjects must be on the federated role for the Bedrock account, in immutable-ID form, with explicit `:pull_request` (and `:ref:refs/heads/<default>` for mentions). **Never `:*`.** See TRI-56232.

Add a CODEOWNERS entry so that `.github/**`, `CLAUDE.md` and `.claude/**` need a human owner's review.
