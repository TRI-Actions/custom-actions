# Upload Release Asset

Uploads files to a GitHub release as assets.

## Features

✅ **Upload multiple files** with glob patterns  
✅ **Automatic file discovery** with wildcards  
✅ **Overwrite existing assets** (optional)  
✅ **Error handling** for missing files or releases  
✅ **Uses GitHub CLI** for reliable uploads  

## Usage

### Basic Example

```yaml
- name: Upload release assets
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: v1.0.0
    files: dist/*.tgz
```

### Upload Multiple File Types

```yaml
- name: Upload release assets
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: ${{ github.ref_name }}
    files: |
      dist/js/*.tgz
      dist/python/*.whl
      dist/python/*.tar.gz
      docs/*.pdf
```

### Complete Release Workflow

```yaml
name: Release
on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build packages
        run: |
          npm run build
          npm pack

      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create ${{ github.ref_name }} \
            --title "Release ${{ github.ref_name }}" \
            --notes "Release notes here"

      - name: Upload assets
        uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
        with:
          tag: ${{ github.ref_name }}
          files: '*.tgz dist/*.whl docs-site.zip'
```

### With Outputs

```yaml
- name: Upload release assets
  id: upload
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: v1.0.0
    files: dist/*

- name: Show uploaded files
  run: |
    echo "Uploaded files:"
    echo "${{ steps.upload.outputs.uploaded-files }}"
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `tag` | Release tag to upload to (e.g., `v1.0.0`) | **Yes** | - |
| `files` | Files to upload (space-separated glob patterns) | **Yes** | - |
| `token` | GitHub token with contents write permission | No | `${{ github.token }}` |
| `clobber` | Overwrite existing assets with the same name | No | `true` |
| `repo` | Repository in format `owner/repo` | No | Current repository |

## Outputs

| Output | Description |
|--------|-------------|
| `uploaded-files` | List of uploaded files (newline-separated) |

## File Patterns

The `files` input supports:

**Glob patterns:**
```yaml
files: 'dist/*.tgz'           # All .tgz files in dist/
files: 'dist/**/*.whl'        # All .whl files recursively
files: '*.{zip,tar.gz}'       # Multiple extensions
```

**Multiple patterns (space-separated):**
```yaml
files: 'dist/*.tgz dist/*.whl docs/*.pdf'
```

**Multiple patterns (multi-line):**
```yaml
files: |
  dist/*.tgz
  dist/*.whl
  docs/*.pdf
```

**Literal files:**
```yaml
files: 'build/app.zip dist/package.tgz'
```

## Permissions

The workflow needs `contents: write` permission:

```yaml
permissions:
  contents: write
```

## Common Use Cases

### 1. Release npm and Python Packages

```yaml
- name: Build packages
  run: |
    npm pack
    python -m build

- name: Upload to release
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: ${{ github.ref_name }}
    files: '*.tgz dist/*.whl dist/*.tar.gz'
```

### 2. Upload Documentation

```yaml
- name: Build docs
  run: npm run docs:build

- name: Package docs
  run: tar -czf docs-site.tgz -C docs-site/build .

- name: Upload to release
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: ${{ github.ref_name }}
    files: docs-site.tgz
```

### 3. Upload Build Artifacts

```yaml
- name: Build binaries
  run: make build

- name: Upload to release
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: ${{ github.ref_name }}
    files: 'build/app-* build/*.exe'
```

### 4. Conditional Upload

```yaml
- name: Upload assets
  if: startsWith(github.ref, 'refs/tags/')
  uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
  with:
    tag: ${{ github.ref_name }}
    files: dist/*
```

## Behavior

### File Discovery

The action:
1. Expands glob patterns to find matching files
2. Validates that all literal paths (non-patterns) exist
3. Errors if no files are found

### Overwriting Assets

By default (`clobber: true`), the action overwrites existing assets with the same name. Set `clobber: false` to error instead:

```yaml
with:
  clobber: false  # Error if asset already exists
```

### Release Validation

The action validates that the release exists before uploading. If not found, it errors with a helpful message.

## Troubleshooting

### Release Not Found

```
ERROR: Release 'v1.0.0' not found in repository 'owner/repo'
```

**Solutions:**
- Create the release first with `gh release create`
- Check the tag name is correct
- Verify you're targeting the right repository

### No Files Found

```
ERROR: No files found matching patterns: dist/*.tgz
```

**Solutions:**
- Verify files exist: `ls -la dist/`
- Check the pattern syntax
- Ensure files are built before upload

### Permission Denied

```
ERROR: Resource not accessible by integration
```

**Solutions:**
- Add `contents: write` permission to your workflow
- Check the token has access to the repository

## Example: Complete Release Workflow

```yaml
name: Release
on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 'lts/*'

      - name: Build
        run: |
          npm install
          npm run build
          npm pack

      - name: Build Python package
        run: |
          pip install build
          python -m build

      - name: Package docs
        run: |
          npm run docs:build
          tar -czf docs-site.tgz -C docs-site/build .

      - name: Create Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create ${{ github.ref_name }} \
            --title "Release ${{ github.ref_name }}" \
            --generate-notes

      - name: Upload Release Assets
        uses: TRI-Actions/custom-actions/actions/upload-github-release-asset@main
        with:
          tag: ${{ github.ref_name }}
          files: |
            *.tgz
            dist/python/*.whl
            dist/python/*.tar.gz
            docs-site.tgz
```

## Related Actions

- [`actions/upload-github-release-asset`](https://github.com/actions/upload-github-release-asset) - Official but deprecated
- [`softprops/action-gh-release`](https://github.com/softprops/action-gh-release) - Popular alternative
