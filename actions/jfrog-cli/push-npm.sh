#!/usr/bin/env bash
set -euo pipefail

# Enable debug mode if requested
if [ "${DEBUG:-false}" = "true" ]; then
  set -x
  echo "=== DEBUG MODE ENABLED ==="
fi

# Validate required inputs
if [ -z "${SOURCE_PATH:-}" ]; then
  echo "ERROR: source-path is required for push-npm action"
  exit 1
fi

if [ -z "${TARGET_REPO:-}" ]; then
  echo "ERROR: target-repo is required for push-npm action"
  exit 1
fi

if [ -z "${BUILD_NAME:-}" ]; then
  echo "ERROR: build-name is required for push-npm action"
  exit 1
fi

# Set default build number if not provided
BUILD_NUMBER="${BUILD_NUMBER:-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}}"

echo "Uploading npm packages to JFrog..."
echo "  Source: $SOURCE_PATH"
echo "  Target: $TARGET_REPO"
echo "  Build: $BUILD_NAME#$BUILD_NUMBER"

# Store current directory for git operations
ORIGINAL_DIR=$(pwd)
if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Original directory: $ORIGINAL_DIR"
  echo "DEBUG: About to cd to: $SOURCE_PATH"
fi

# Change to source directory
cd "$SOURCE_PATH"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Current directory after cd: $(pwd)"
  echo "DEBUG: Files in directory:"
  ls -la
fi

# Build base upload command arguments
UPLOAD_ARGS=(
  "--build-name=$BUILD_NAME"
  "--build-number=$BUILD_NUMBER"
)

# Add module name if provided
if [ -n "${MODULE_NAME:-}" ]; then
  UPLOAD_ARGS+=("--module=$MODULE_NAME")
fi

# Add properties if provided
if [ -n "${PROPERTIES:-}" ]; then
  UPLOAD_ARGS+=("--props=$PROPERTIES")
fi

# Upload tgz files
if ls *.tgz 1> /dev/null 2>&1; then
  echo "Uploading .tgz files..."
  if [ "${DRY_RUN:-false}" = "true" ]; then
    echo "[DRY-RUN] Would execute: jf rt upload \"*.tgz\" \"$TARGET_REPO/\" ${UPLOAD_ARGS[*]}"
  else
    jf rt upload "*.tgz" "$TARGET_REPO/" "${UPLOAD_ARGS[@]}"
  fi
else
  echo "ERROR: No .tgz files found in $SOURCE_PATH"
  cd "$ORIGINAL_DIR"
  exit 1
fi

# Go back to original directory for git operations
cd "$ORIGINAL_DIR"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Back to original directory: $(pwd)"
  echo "DEBUG: Git repo path: ${GIT_REPO_PATH:-.}"
  echo "DEBUG: Checking if git repo exists:"
  ls -la "${GIT_REPO_PATH:-.}" || echo "DEBUG: Directory not found or not accessible"
fi

# Add git info if requested
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

echo "npm packages uploaded successfully!"
