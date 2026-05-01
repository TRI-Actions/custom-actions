# Python Library Release & Publish pypi Composite Action

This is a **reusable GitHub Actions composite action** that automates the entire Python package release workflow for TRI organizations. It's designed to be used by multiple Python library repositories to standardize their release process.

## Complete Workflow

### 1. Branch Validation
- Enforces that releases only happen from a designated branch (default: `publish`)
- Prevents accidental releases from development branches
- Validates against `GITHUB_REF` to ensure correct branch context

### 2. Version Management
- **Explicit versioning**: Accepts a manual version input (e.g., `1.2.3`)
- **Auto-bumping**: If no explicit version provided, automatically increments based on:
  - `patch`: 1.2.3 → 1.2.4
  - `minor`: 1.2.3 → 1.3.0
  - `major`: 1.2.3 → 2.0.0
- Reads latest git tag matching `v*` pattern
- Defaults to `v0.0.0` if no tags exist
- Validates version format matches semantic versioning

### 3. Git Tagging
- Configures git identity as `github-actions[bot]`
- Creates annotated git tag (e.g., `v1.2.3`)
- Checks for tag conflicts to prevent overwrites
- Pushes tag to remote repository

### 4. Package Building
- Installs Python build tooling (`pip`, `build`, `setuptools-scm`)
- Supports subdirectory builds (for monorepos)
- Executes `python -m build` to create:
  - Wheel distribution (`.whl`)
  - Source distribution (`.tar.gz`)
- Uses `setuptools-scm` to derive version from git tags automatically

### 5. Artifact Validation
- Extracts version from built wheel/tarball filename
- Compares against the git tag version
- Fails if mismatch detected (prevents mismatched releases)
- Ensures package metadata is correctly configured

### 6. GitHub Release Creation
- Uses GitHub CLI (`gh release create`)
- Creates release with the version tag
- Generates automated release notes
- Makes the release publicly visible on GitHub

### 7. Asset Upload
- Uploads all distribution files from `dist/` directory
- Attaches wheel and source tarball to GitHub release
- Uses `--clobber` flag to handle re-uploads
- Makes artifacts downloadable from release page

### 8. PyPI Publishing Dispatch
- Triggers a separate publisher repository (`tri-ie/tri-test-publish-pypi`)
- Uses repository dispatch webhook with `publish-to-pypi` event
- Sends payload containing:
  - Source repository name
  - Git tag/ref to publish
  - Subdirectory path (if applicable)
  - Who initiated the release
  - Link to source workflow run
- Decouples release creation from actual PyPI publishing
- Allows centralized PyPI credential management

## Key Features

### Inputs
- `publish_branch`: Branch restriction (default: "publish")
- `bump`: Version bump type - patch/minor/major
- `version`: Override with explicit version
- `subdir`: Support for monorepo structures
- `dispatch_token`: PAT for triggering publisher repo
- `initiated_by`: Track who triggered the release
- `source_run_url`: Link back to source workflow

### Outputs
- `version`: The computed/used version number
- `tag`: The created git tag

### Benefits
- **Consistency**: Same release process across all TRI Python libraries
- **Safety**: Branch validation, version conflict detection
- **Automation**: Zero-click release after pushing to publish branch
- **Traceability**: Links between source repo, release, and PyPI publish
- **Separation of concerns**: Release creation separate from PyPI publishing
- **Monorepo support**: Can handle packages in subdirectories

## Usage

Consuming repositories include this in their workflows:

```yaml
name: Release (GitHub + Dispatch to Publisher)

on:
  push:
    branches: [publish]
  workflow_dispatch:
    inputs:
      bump:
        description: "Version bump type"
        required: true
        default: patch
        type: choice
        options: [patch, minor, major]
      version:
        description: "Optional explicit version (e.g., 1.2.3). If set, bump is ignored."
        required: false
        type: string

permissions:
  contents: write

jobs:
  release:
    environment: release
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/publish'

    steps:
      - name: Checkout (full history + tags)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Release and Dispatch
        uses: TRI-Actions/custom-actions/actions/python-lib-release-publish-pypi@main
        with:
          bump: ${{ inputs.bump || 'patch' }}
          version: ${{ inputs.version || '' }}
          subdir: ""
          dispatch_token: ${{ secrets.PUBLISH_DISPATCH_TOKEN }}
          initiated_by: ${{ github.triggering_actor || github.actor }}
          source_run_url: https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

This creates a standardized release pipeline where developers just push to the `publish` branch or trigger manually, and the entire release happens automatically
