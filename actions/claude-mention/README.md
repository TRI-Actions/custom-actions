# Claude Mention

Answers `@claude <question>` on issues and PR comments using Claude Code on Bedrock. It's answer-only, with no write access to the repo and no Bash. Only commenters whose association is **OWNER, MEMBER or COLLABORATOR** can trigger it. Everyone else is skipped quietly.

**Pin by commit SHA.** It has the same hardening and fixed settings as [claude-review](../claude-review/README.md).

## Inputs

`aws-auth` (`oidc` | `runner`), `account-id`, `target-role-name`, `federated-role-name`, `region`, `model`, `max-turns`, `github-token`. These have the same meanings and defaults as claude-review.

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

On GHES, use the CodeBuild `runs-on` label, drop `id-token: write`, and pass `aws-auth: runner`.

For oidc, mention runs on `issue_comment` and `issues` arrive with subject `…:ref:refs/heads/<default>`, so the federated role needs that subject. `:*` isn't needed.
