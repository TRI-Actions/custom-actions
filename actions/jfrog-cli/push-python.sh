#!/usr/bin/env bash
set -euo pipefail

# Enable debug mode if requested
if [ "${DEBUG:-false}" = "true" ]; then
  set -x
  echo "=== DEBUG MODE ENABLED ==="
fi

# Validate required inputs
if [ -z "${SOURCE_PATH:-}" ]; then
  echo "ERROR: source-path is required for push-python action"
  exit 1
fi

if [ -z "${TARGET_REPO:-}" ]; then
  echo "ERROR: target-repo is required for push-python action"
  exit 1
fi

if [ -z "${BUILD_NAME:-}" ]; then
  echo "ERROR: build-name is required for push-python action"
  exit 1
fi

# Set default build number if not provided
BUILD_NUMBER="${BUILD_NUMBER:-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}}"

echo "Publishing Python packages to JFrog..."
echo "  Source: $SOURCE_PATH"
echo "  Target: $TARGET_REPO"
echo "  Build: $BUILD_NAME#$BUILD_NUMBER"

# Store current directory for git operations
ORIGINAL_DIR=$(pwd)
if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Original directory: $ORIGINAL_DIR"
  echo "DEBUG: About to cd to: $SOURCE_PATH"
fi

# Change to source directory (should contain .whl and .tar.gz files)
cd "$SOURCE_PATH"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Current directory after cd: $(pwd)"
  echo "DEBUG: Files in directory:"
  ls -la
fi

# Check if any Python packages exist
if ! ls *.whl *.tar.gz 1> /dev/null 2>&1; then
  echo "ERROR: No .whl or .tar.gz files found in $SOURCE_PATH"
  echo "Note: source-path should point to directory containing .whl and .tar.gz files (e.g., dist/python)"
  cd "$ORIGINAL_DIR"
  exit 1
fi

# Go back to original directory for git operations first
cd "$ORIGINAL_DIR"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Back to original directory: $(pwd)"
  echo "DEBUG: Git repo path: ${GIT_REPO_PATH:-.}"
  echo "DEBUG: Checking if git repo exists:"
  ls -la "${GIT_REPO_PATH:-.}" || echo "DEBUG: Directory not found or not accessible"
fi

# Add git info BEFORE publishing (so it's included in build info)
if [ "${ADD_GIT_INFO:-true}" = "true" ]; then
  echo "Adding git info to build..."
  if [ "${DEBUG:-false}" = "true" ]; then
    echo "DEBUG: Running: jf rt build-add-git $BUILD_NAME $BUILD_NUMBER ${GIT_REPO_PATH:-.}"
  fi
  if [ "${DRY_RUN:-false}" = "true" ]; then
    echo "[DRY-RUN] Would execute: jf rt build-add-git \"$BUILD_NAME\" \"$BUILD_NUMBER\" \"${GIT_REPO_PATH:-.}\""
  else
    jf rt build-add-git "$BUILD_NAME" "$BUILD_NUMBER" "${GIT_REPO_PATH:-.}" || {
      echo "Warning: Failed to add git info (continuing anyway)"
    }
  fi
fi

# Go back to package directory
cd "$SOURCE_PATH"

# Configure pip to use JFrog PyPI repository
echo "Configuring PyPI repository..."
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would execute: jf pip-config --repo-deploy=$TARGET_REPO"
else
  jf pip-config --repo-deploy="$TARGET_REPO"
fi

# Build twine upload command arguments
TWINE_ARGS=(
  "upload"
  "*"
  "--build-name=$BUILD_NAME"
  "--build-number=$BUILD_NUMBER"
)

# Add module name if provided
if [ -n "${MODULE_NAME:-}" ]; then
  TWINE_ARGS+=("--module=$MODULE_NAME")
fi

# Publish packages using jf twine (this collects build info including the git info we just added)
echo "Publishing Python packages..."
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would execute: jf twine ${TWINE_ARGS[*]}"
else
  jf twine "${TWINE_ARGS[@]}"
fi

# Go back to original directory
cd "$ORIGINAL_DIR"

# Publish build info if requested
if [ "${PUBLISH_BUILD_INFO:-true}" = "true" ]; then
  echo "Publishing build info..."
  if [ "${DRY_RUN:-false}" = "true" ]; then
    echo "[DRY-RUN] Would execute: jf rt build-publish \"$BUILD_NAME\" \"$BUILD_NUMBER\""
  else
    jf rt build-publish "$BUILD_NAME" "$BUILD_NUMBER"
    echo "Build info published successfully"
  fi
fi

echo "Python packages uploaded successfully!"
