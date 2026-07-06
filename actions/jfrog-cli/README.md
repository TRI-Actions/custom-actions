# JFrog CLI

This GitHub Action installs the JFrog CLI, configures it with OIDC authentication, and can push Python and npm packages to JFrog Artifactory.

## Features

- **Setup**: Installs JFrog CLI and configures OIDC authentication
- **Push Python**: Upload Python packages (.whl, .tar.gz) to JFrog Artifactory
- **Push npm**: Upload npm packages (.tgz) to JFrog Artifactory
- **Build Info**: Automatically collects and publishes build information
- **Git Integration**: Adds git metadata to builds

## Prerequisites

1. **GitHub OIDC Provider configured in JFrog**: Your JFrog instance must have a GitHub OIDC provider configured
2. **GitHub Actions permissions**: Your workflow must have `id-token: write` permission to generate OIDC tokens

## Usage

### Setup Only

Just install and configure JFrog CLI for use in subsequent steps:

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup JFrog CLI
        uses: ./actions/jfrog-cli
        with:
          action: setup
          oidc-provider: 'github-oidc-provider'

      - name: Use JFrog CLI
        run: |
          jf rt ping
          jf rt download "my-repo/path/*" ./downloads/
```

### Push Python Packages

Upload Python packages to JFrog Artifactory:

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  release-python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v6
        with:
          python-version: '3.x'

      - name: Build Python package
        run: |
          pip install build
          python -m build

      - name: Push to JFrog
        uses: ./actions/jfrog-cli
        with:
          action: push-python
          oidc-provider: 'ie-tf-modules'
          source-path: 'dist/python'
          target-repo: 'my-pypi-local'
          build-name: 'my-project-pypi'
          module-name: 'python-${{ github.ref_name }}'
          properties: 'git.tag=${{ github.ref_name }}'
```

### Push npm Packages

Upload npm packages to JFrog Artifactory:

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  release-npm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 'lts/*'

      - name: Build and pack
        run: |
          npm install
          npm run build
          npm pack

      - name: Push to JFrog
        uses: ./actions/jfrog-cli
        with:
          action: push-npm
          oidc-provider: 'ie-tf-modules'
          source-path: '.'
          target-repo: 'my-npm-local'
          build-name: 'my-project-npm'
          module-name: 'npm-${{ github.ref_name }}'
          properties: 'git.tag=${{ github.ref_name }}'
```

### Complete Release Workflow

Based on your current release workflow:

```yaml
name: release
on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: lts/*
      - name: Install and build
        run: |
          yarn install --frozen-lockfile
          npx projen release
      # ... version checking and artifact upload ...

  release_pypi:
    needs: release
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6
      
      - name: Download build artifacts
        uses: actions/download-artifact@v8
        with:
          name: build-artifact
          path: dist

      # Extract and prepare python artifacts...

      - name: Push to JFrog PyPI
        uses: TRI-Actions/custom-actions/actions/jfrog-cli@main
        with:
          action: push-python
          oidc-provider: 'ie-tf-modules'
          source-path: 'dist/python'
          target-repo: 'ie-cdk-construct-library-pypi-dev-local'
          build-name: 'tri-cdk-construct-library-pypi'
          build-number: '${{ github.run_id }}-${{ github.run_attempt }}'
          module-name: 'python-${{ needs.release.outputs.version }}'
          properties: 'git.tag=${{ needs.release.outputs.tag }}'

  release_npm:
    needs: release
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v6
      
      - name: Download build artifacts
        uses: actions/download-artifact@v8
        with:
          name: build-artifact
          path: dist

      - name: Push to JFrog npm
        uses: TRI-Actions/custom-actions/actions/jfrog-cli@main
        with:
          action: push-npm
          oidc-provider: 'ie-tf-modules'
          source-path: 'dist/js'
          target-repo: 'ie-cdk-construct-library-npm-dev-local'
          build-name: 'tri-cdk-construct-library-npm'
          build-number: '${{ github.run_id }}-${{ github.run_attempt }}'
          module-name: 'npm-${{ needs.release.outputs.version }}'
          properties: 'git.tag=${{ needs.release.outputs.tag }}'
```

## Inputs

### Common Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `action` | Action to perform: `setup`, `push-python`, or `push-npm` | **Yes** | - |
| `jfrog-url` | JFrog platform base URL | No | `https://toyotaresearchinstitute.jfrog.io` |
| `oidc-provider` | Name of the OIDC provider configured in JFrog | **Yes** | - |
| `audience` | OIDC audience to request from GitHub | No | `jfrog-github-oidc` |
| `jfrog-cli-version` | Version of JFrog CLI to install | No | `latest` |
| `server-id` | Server ID for the JFrog CLI configuration | No | `default` |

### Push Action Inputs

Required when `action` is `push-python` or `push-npm`:

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `source-path` | Source path for artifacts to upload | **Yes** | - |
| `target-repo` | Target JFrog repository | **Yes** | - |
| `build-name` | Build name for JFrog build info | **Yes** | - |
| `build-number` | Build number for JFrog build info | No | `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` |
| `module-name` | Module name for the artifacts | No | - |
| `properties` | Additional properties to attach (e.g., `key1=value1;key2=value2`) | No | - |
| `publish-build-info` | Whether to publish build info after upload | No | `true` |
| `add-git-info` | Whether to add git info to build | No | `true` |

## Outputs

| Output | Description |
|--------|-------------|
| `jfrog-url` | JFrog platform URL that was configured |
| `server-id` | Server ID that was configured in JFrog CLI |

## Actions

### `setup`

Installs JFrog CLI and configures OIDC authentication. Use this when you want to use JFrog CLI commands directly in subsequent steps.

### `push-python`

Uploads Python packages to JFrog Artifactory:
- Uploads all `.whl` files from source path
- Uploads all `.tar.gz` files from source path
- Attaches build information and git metadata
- Publishes build info to JFrog

### `push-npm`

Uploads npm packages to JFrog Artifactory:
- Uploads all `.tgz` files from source path
- Attaches build information and git metadata
- Publishes build info to JFrog

## Build Information

Both push actions automatically collect and publish build information to JFrog, including:

- Build name and number
- Module information
- Git commit, branch, and repository info (if `add-git-info: true`)
- Custom properties (via `properties` input)
- Artifact checksums and metadata

This enables full traceability in JFrog Artifactory.

## Migration from `setup-jfrog-cli@v4`

Replace:
```yaml
- name: Setup JFrog CLI
  uses: jfrog/setup-jfrog-cli@v4
  env:
    JF_URL: https://toyotaresearchinstitute.jfrog.io
  with:
    oidc-provider-name: ie-tf-modules
    oidc-audience: jfrog-github-oidc

- name: Upload to JFrog PyPI
  run: |
    # ... manual jf commands ...
```

With:
```yaml
- name: Push to JFrog PyPI
  uses: TRI-Actions/custom-actions/actions/jfrog-cli@main
  with:
    action: push-python
    oidc-provider: ie-tf-modules
    source-path: dist/python
    target-repo: my-pypi-local
    build-name: my-build
```

## Troubleshooting

### Token Exchange Failed

Check:
- The OIDC provider name matches what's configured in JFrog
- The audience matches the JFrog OIDC provider configuration
- The workflow has `id-token: write` permission

### Upload Failed

Check:
- The `source-path` exists and contains the expected files
- The `target-repo` exists in JFrog and you have write permissions
- The repository type matches the package type (PyPI for Python, npm for npm)

### Build Info Not Published

If git info fails to add (non-fatal), ensure:
- You've checked out the repository with `actions/checkout`
- The checkout includes git history (`fetch-depth: 0` if needed)

## Security Notes

- Access tokens are automatically masked in GitHub Actions logs
- Tokens are short-lived and expire after the configured duration
- No long-lived credentials are stored in the repository

## Related Actions

- [`get-jfrog-credentials`](../get-jfrog-credentials/): Get JFrog credentials without installing CLI
- [`get-aws-credentials`](../get-aws-credentials/): Similar pattern for AWS OIDC authentication
