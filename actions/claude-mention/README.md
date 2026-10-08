# Claude Mention

Answers `@claude <question>` on issues and PR comments using Claude Code on Bedrock. It's answer-only, with no write access to the repo and no Bash. Only commenters whose association is **OWNER, MEMBER or COLLABORATOR** can trigger it. Everyone else is skipped quietly. On a pull request, only same-repo PRs are answered; a fork PR fails closed.

**Pin by commit SHA.** It has the same hardening and fixed settings as [claude-review](../claude-review/README.md).

## Inputs

`aws-auth` (`oidc` | `runner`), `account-id`, `target-role-name`, `federated-role-name`, `region`, `model`, `max-turns`, `runner-bedrock-role-arn`, `allow-runner-credentials`, `allow-shared-federated-role`, `github-token`. These have the same meanings and defaults as claude-review. In particular, `runner` needs `runner-bedrock-role-arn` (or the explicit `allow-runner-credentials` opt-in), `github-token` must be the job token, and team callers pass their own `account-id`.

## Example: github.com

```yaml
name: Claude Mention
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened]

# One answer at a time per issue or PR, so a burst of @claude comments doesn't multiply
# Bedrock spend. GitHub keeps one run pending and cancels older pending ones.
concurrency:
  group: claude-mention-${{ github.event.issue.number || github.event.pull_request.number }}
  cancel-in-progress: false

jobs:
  answer:
    # Cheap pre-filter so most comments never take a runner. The action re-checks
    # this and the author association itself.
    if: contains(github.event.comment.body || github.event.issue.body, '@claude')
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      id-token: write
      pull-requests: write
      issues: write
    steps:
      - uses: TRI-Actions/custom-actions/actions/claude-mention@<sha>
```

On GHES, use the CodeBuild `runs-on` label, drop `id-token: write`, and pass `aws-auth: runner` with `runner-bedrock-role-arn`.

For oidc, mention runs on `issue_comment` and `issues` arrive with subject `…:ref:refs/heads/<default>`, so the federated role needs that subject. `:*` isn't needed.
