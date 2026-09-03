# Custom-Actions

A monorepo of reusable GitHub Actions maintained under the `TRI-Actions` org.
Each action lives under `actions/<name>/` with its own README.

## Consuming an action

Pin each action independently to an immutable version or a floating major line.
The floating tag `<action>/v1` moves to the latest release inside that major line;
the immutable tag `<action>/v1.2.3` never moves.

```yaml
name: PR Workflow

on:
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Recommended: pin to the floating major, auto-picks up minor/patch releases.
      - uses: TRI-Actions/custom-actions/actions/parse-yaml@parse-yaml/v1
        with:
          file_path: settings.yaml

      # Fully immutable: pin to an exact version.
      - uses: TRI-Actions/custom-actions/actions/parse-yaml@parse-yaml/v1.2.3
        with:
          file_path: settings.yaml
```

Referencing `@main` still works and tracks the tip of `main`, but a breaking
change to any action can silently break every consumer that does so. Prefer
tags.

## Releasing a new version

Releases are cut per-action from a labeled PR.

### 1. Open a PR that touches `actions/<name>/`

Any change under `actions/<name>/` (source, manifest, README, tests) counts as
a release-worthy change. A single PR may touch multiple actions; they all get
the same bump.

### 2. Add a bump label

| Label   | Bump                         |
|---------|------------------------------|
| `patch` | `X.Y.Z` -> `X.Y.(Z+1)`       |
| `minor` | `X.Y.Z` -> `X.(Y+1).0`       |
| `major` | `X.Y.Z` -> `(X+1).0.0`       |

If you forget to add one, the workflow auto-adds `patch` on the next push.
Precedence when multiple labels are set: `major` > `minor` > `patch`.

### 3. Watch the preview

On every push, the release workflow posts/updates a preview comment showing what
would publish, and cuts a lightweight RC tag on each changed action:

```
<action>/vX.Y.Z-rc.<PR_NUMBER>
```

Consumers can pin the RC tag to test the change before you merge:

```yaml
- uses: TRI-Actions/custom-actions/actions/parse-yaml@parse-yaml/v1.3.0-rc.42
```

The RC is force-refreshed on every push and label change. All RC tags for a
PR are deleted once the PR publishes (or when you close it).

### 4. Publish

Comment `!publish` on the PR (exact match, no extra text). The workflow will:

1. Verify the PR is approved and mergeable, and that the commenter has write access.
2. For each changed action:
   - Create annotated immutable tag `<action>/vX.Y.Z` at the PR head.
   - Force-move floating tag `<action>/vX` to the same commit.
   - Create a GitHub release with auto-generated notes.
   - Delete this PR's RC tags for that action.
3. Merge the PR with `--merge --delete-branch`.

If any action fails to publish, the PR is not merged and the run exits non-zero.
The publish path is idempotent: rerunning after a partial failure heals a
missing GitHub release without re-tagging.

## Not supported

- Fork PRs cannot cut releases (workflow guard). Merge internally first if needed.
- No `workflow_dispatch` fallback. Cut a manual git tag if a release path is truly stuck.
