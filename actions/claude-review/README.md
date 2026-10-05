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
| `account-id` | Bedrock account (oidc) | `550939891544` |
| `target-role-name` | Bedrock role (oidc) | `ClaudeCodeBedrockGHA` |
| `federated-role-name` | Federated role base name (oidc) | `GHAFederatedRole` |
| `region` | US region | `us-west-2` |
| `model` | `us.anthropic.claude-*` inference profile | `us.anthropic.claude-sonnet-5` |
| `max-turns` | Turn cap | `30` |
| `prompt-addendum` | Repo-specific guidance, appended to the fixed prompt | `""` |
| `github-token` | Token for comments | `github.token` |

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
- oidc sessions last 900s, named `claude-review-<run_id>`. `configure-aws-credentials` is pinned by SHA.
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
    types: [opened, reopened, ready_for_review]

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
        # with:
        #   prompt-addendum: |
        #     Shared networking Terraform; treat any 0.0.0.0/0 as HIGH.
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
    types: [opened, reopened, ready_for_review]

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
```

## Prerequisites (oidc)

Your repo's subjects must be on the federated role for the Bedrock account, in immutable-ID form, with explicit `:pull_request` (and `:ref:refs/heads/<default>` for mentions). **Never `:*`.** See TRI-56232.

Add a CODEOWNERS entry so that `.github/**`, `CLAUDE.md` and `.claude/**` need a human owner's review.
