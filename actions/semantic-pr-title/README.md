# Semantic PR Title

Validates that pull request titles follow the [Conventional Commits](https://www.conventionalcommits.org/) specification.

## Features

✅ Validates PR titles against conventional commits format  
✅ Customizable types, scopes, and validation rules  
✅ Support for breaking changes (`!` or `BREAKING CHANGE:`)  
✅ Skip validation for specific labels  
✅ WIP prefix support  
✅ Detailed error messages  
✅ Extracts type, scope, and subject as outputs  

## Usage

### Basic Example

```yaml
name: PR Title Check

on:
  pull_request:
    types: [opened, edited, synchronize]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Validate PR title
        uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
```

### Custom Configuration

```yaml
- name: Validate PR title
  uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  with:
    types: 'feat,fix,docs,refactor'
    scopes: 'api,ui,core'
    require-scope: true
    subject-pattern: '^[A-Z].*$'  # Require capitalized subject
    ignore-labels: 'skip-validation,dependencies'
```

### With Error Reporting

```yaml
- name: Validate PR title
  id: validate
  uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  continue-on-error: true

- name: Comment on PR if invalid
  if: steps.validate.outputs.valid == 'false'
  uses: actions/github-script@v7
  with:
    script: |
      github.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        body: `❌ **Invalid PR title**\n\n${{ steps.validate.outputs.error-message }}\n\nPlease use the format: \`type(scope): subject\``
      })
```

## Valid PR Title Examples

```
✅ feat: Add new feature
✅ fix: Resolve bug in login
✅ docs: Update README
✅ feat(api): Add user endpoint
✅ refactor(ui): Simplify button component
✅ feat!: Breaking API change
✅ fix: BREAKING CHANGE: Remove deprecated method
✅ [WIP] feat: Work in progress feature
```

## Invalid PR Title Examples

```
❌ Add new feature (missing type)
❌ FEAT: Add feature (type must be lowercase)
❌ feature: Add feature (invalid type)
❌ feat Add feature (missing colon)
❌ feat(): Add feature (empty scope not allowed)
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `types` | Allowed commit types (comma-separated) | No | `feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert` |
| `scopes` | Allowed scopes (comma-separated). Empty = any scope allowed | No | `""` |
| `require-scope` | Whether scope is required | No | `false` |
| `subject-pattern` | Regex pattern for subject validation | No | `^.+$` |
| `allow-breaking` | Whether to allow breaking changes | No | `true` |
| `ignore-labels` | Skip validation if PR has these labels (comma-separated) | No | `""` |
| `wip` | Allow WIP prefix ([WIP], WIP:) | No | `false` |
| `github-token` | GitHub token for API access | No | `${{ github.token }}` |

## Outputs

| Output | Description |
|--------|-------------|
| `valid` | Whether the PR title is valid (`true`/`false`) |
| `type` | Extracted commit type (e.g., `feat`, `fix`) |
| `scope` | Extracted scope (if present) |
| `subject` | Extracted subject |
| `breaking` | Whether this is a breaking change (`true`/`false`) |
| `error-message` | Error message if validation failed |

## Conventional Commits Format

The action validates against this pattern:

```
type(scope)!: subject
```

**Components:**
- **type** (required): Commit type (e.g., `feat`, `fix`, `docs`)
- **scope** (optional): Affected area (e.g., `api`, `ui`, `auth`)
- **!** (optional): Indicates breaking change
- **subject** (required): Short description

**Breaking Changes:**
- Add `!` after type/scope: `feat!: breaking change`
- Or start subject with `BREAKING CHANGE:`: `feat: BREAKING CHANGE: removed API`

## Advanced Configuration

### Require Specific Scopes

```yaml
- uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  with:
    scopes: 'frontend,backend,infra,docs'
    require-scope: true
```

### Enforce Capitalized Subjects

```yaml
- uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  with:
    subject-pattern: '^[A-Z].*$'
```

### Skip Validation for Dependabot

```yaml
- uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  with:
    ignore-labels: 'dependencies,dependabot'
```

### Allow WIP PRs

```yaml
- uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  with:
    wip: true
```

## Using with Semantic Release

This action pairs well with semantic-release tools. The extracted outputs can be used for version bumping:

```yaml
- name: Validate PR title
  id: pr-title
  uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main

- name: Determine version bump
  run: |
    if [ "${{ steps.pr-title.outputs.breaking }}" = "true" ]; then
      echo "Version bump: MAJOR"
    elif [ "${{ steps.pr-title.outputs.type }}" = "feat" ]; then
      echo "Version bump: MINOR"
    else
      echo "Version bump: PATCH"
    fi
```

## Workflow Triggers

Use these events to validate PR titles:

```yaml
on:
  pull_request:
    types:
      - opened       # When PR is first created
      - edited       # When PR title is changed
      - synchronize  # When new commits are pushed
```

Or use `pull_request_target` for fork-based workflows (be careful with permissions):

```yaml
on:
  pull_request_target:
    types: [opened, edited, synchronize]
```

## Migration from amannn/action-semantic-pull-request

Direct replacement example:

**Before:**
```yaml
- uses: amannn/action-semantic-pull-request@v6
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    types: |
      feat
      fix
      docs
    requireScope: true
```

**After:**
```yaml
- uses: TRI-Actions/custom-actions/actions/semantic-pr-title@main
  with:
    types: 'feat,fix,docs'
    require-scope: true
```

**Key differences:**
- `types` uses comma-separated string instead of multi-line
- `requireScope` → `require-scope` (kebab-case)
- `GITHUB_TOKEN` via `github-token` input (auto-defaults)

## Troubleshooting

### Validation Always Passes

- Check that the action runs on correct PR events (`opened`, `edited`)
- Verify `github.event.pull_request.title` is available

### False Positives

- Check your `subject-pattern` isn't too restrictive
- Verify `types` includes the types you use
- Review scope requirements

### Doesn't Work on Forks

- Use `pull_request_target` event instead of `pull_request`
- Be careful with permissions when using `pull_request_target`

## Related Actions

- [`amannn/action-semantic-pull-request`](https://github.com/amannn/action-semantic-pull-request) - Original inspiration
- Conventional Commits: https://www.conventionalcommits.org/
