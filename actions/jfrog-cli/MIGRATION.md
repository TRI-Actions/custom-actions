# Migration Guide

## From `jfrog/setup-jfrog-cli@v4` with manual uploads

### Before (Manual approach)

```yaml
- name: Setup JFrog CLI
  uses: jfrog/setup-jfrog-cli@v4
  env:
    JF_URL: https://toyotaresearchinstitute.jfrog.io
  with:
    oidc-provider-name: ie-tf-modules
    oidc-audience: jfrog-github-oidc

- name: Upload to JFrog PyPI
  run: |-
    set -euo pipefail
    PACKAGE_VERSION="$(node -p "require('./package.json').version")"
    BUILD_NUMBER="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
    RELEASE_TAG="$(cat dist/releasetag.txt)"
    cd dist/python
    jf rt upload "*.whl" ie-cdk-construct-library-pypi-dev-local/ --build-name=tri-cdk-construct-library-pypi --build-number="$BUILD_NUMBER" --module="python-$PACKAGE_VERSION" --props="git.tag=$RELEASE_TAG"
    jf rt upload "*.tar.gz" ie-cdk-construct-library-pypi-dev-local/ --build-name=tri-cdk-construct-library-pypi --build-number="$BUILD_NUMBER" --module="python-$PACKAGE_VERSION" --props="git.tag=$RELEASE_TAG"
    jf rt build-add-git tri-cdk-construct-library-pypi "$BUILD_NUMBER" ../.repo || true
    jf rt build-publish tri-cdk-construct-library-pypi "$BUILD_NUMBER"
```

### After (Using jfrog-cli action)

```yaml
- name: Push to JFrog PyPI
  uses: TRI-Actions/custom-actions/actions/jfrog-cli@main
  with:
    action: push-python
    oidc-provider: ie-tf-modules
    source-path: dist/python
    target-repo: ie-cdk-construct-library-pypi-dev-local
    build-name: tri-cdk-construct-library-pypi
    module-name: python-${{ needs.release.outputs.version }}
    properties: git.tag=${{ needs.release.outputs.tag }}
```

## Benefits of Migration

### Reduced Boilerplate
- **Before**: ~15 lines of bash script per package type
- **After**: ~8 lines of declarative YAML

### Better Maintainability
- Logic is centralized in the action
- Updates to upload patterns benefit all users
- Less duplication across workflows

### Improved Readability
- Declarative inputs vs. bash scripts
- Clear separation of concerns
- Self-documenting workflow

### Error Handling
- Built-in validation of required inputs
- Better error messages
- Consistent error handling across all uses

### Consistency
- Same pattern for Python and npm
- Easy to add new package types
- Standardized build info collection

## Side-by-Side Comparison

### npm Package Upload

#### Before
```yaml
- name: Setup JFrog CLI
  uses: jfrog/setup-jfrog-cli@v4
  env:
    JF_URL: https://toyotaresearchinstitute.jfrog.io
  with:
    oidc-provider-name: ie-tf-modules
    oidc-audience: jfrog-github-oidc

- name: Upload to JFrog npm
  run: |-
    set -euo pipefail
    PACKAGE_VERSION="$(tar -xOf dist/js/*.tgz package/package.json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).version")"
    BUILD_NUMBER="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
    RELEASE_TAG="$(cat dist/releasetag.txt)"
    cd dist/js
    jf rt upload "*.tgz" ie-cdk-construct-library-npm-dev-local/ --build-name=tri-cdk-construct-library-npm --build-number="$BUILD_NUMBER" --module="npm-$PACKAGE_VERSION" --props="git.tag=$RELEASE_TAG"
    jf rt build-add-git tri-cdk-construct-library-npm "$BUILD_NUMBER" ../.. || true
    jf rt build-publish tri-cdk-construct-library-npm "$BUILD_NUMBER"
```

#### After
```yaml
- name: Push to JFrog npm
  uses: TRI-Actions/custom-actions/actions/jfrog-cli@main
  with:
    action: push-npm
    oidc-provider: ie-tf-modules
    source-path: dist/js
    target-repo: ie-cdk-construct-library-npm-dev-local
    build-name: tri-cdk-construct-library-npm
    module-name: npm-${{ needs.release.outputs.version }}
    properties: git.tag=${{ needs.release.outputs.tag }}
```

## Migration Checklist

- [ ] Replace `jfrog/setup-jfrog-cli@v4` with `TRI-Actions/custom-actions/actions/jfrog-cli@main`
- [ ] Change `action` input to `push-python` or `push-npm` (or `setup` for manual CLI usage)
- [ ] Convert `oidc-provider-name` to `oidc-provider`
- [ ] Remove `JF_URL` env var, use `jfrog-url` input instead (or use default)
- [ ] Replace manual `jf rt upload` commands with action inputs:
  - Bash `cd` → `source-path` input
  - Repository path → `target-repo` input
  - `--build-name` → `build-name` input
  - `--build-number` → `build-number` input (or omit for default)
  - `--module` → `module-name` input
  - `--props` → `properties` input
- [ ] Remove manual `jf rt build-add-git` and `jf rt build-publish` commands (handled automatically)
- [ ] Test the workflow in a PR before merging

## Gradual Migration Strategy

You can migrate incrementally:

1. **Phase 1**: Keep existing workflows, add new action for new projects
2. **Phase 2**: Migrate Python uploads first (usually simpler)
3. **Phase 3**: Migrate npm uploads
4. **Phase 4**: Deprecate manual scripts

Or migrate all at once in a single PR with thorough testing.

## Need Manual Control?

If you need to run custom `jf` commands, use `action: setup`:

```yaml
- name: Setup JFrog CLI
  uses: TRI-Actions/custom-actions/actions/jfrog-cli@main
  with:
    action: setup
    oidc-provider: ie-tf-modules

- name: Custom JFrog operations
  run: |
    jf rt upload "custom/*" my-repo/
    jf rt set-props "my-repo/path/*" "status=approved"
    jf rt copy "my-repo/path/*" "other-repo/path/"
```

This gives you the CLI setup with OIDC, then full control over commands.
