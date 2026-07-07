#!/usr/bin/env bash
set -euo pipefail

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

# Change to source directory
cd "$SOURCE_PATH"

# Build base upload command arguments
UPLOAD_ARGS=(
  "--server-id=${SERVER_ID:-default}"
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
  jf rt upload "*.tgz" "$TARGET_REPO/" "${UPLOAD_ARGS[@]}"
else
  echo "ERROR: No .tgz files found in $SOURCE_PATH"
  cd "$ORIGINAL_DIR"
  exit 1
fi

# Go back to original directory for git operations
cd "$ORIGINAL_DIR"

# Add git info if requested
if [ "${ADD_GIT_INFO:-true}" = "true" ]; then
  echo "Adding git info to build..."
  jf rt build-add-git "$BUILD_NAME" "$BUILD_NUMBER" "${GIT_REPO_PATH:-.}" || {
    echo "Warning: Failed to add git info (continuing anyway)"
  }
fi

# Publish build info if requested
if [ "${PUBLISH_BUILD_INFO:-true}" = "true" ]; then
  echo "Publishing build info..."
  jf rt build-publish "$BUILD_NAME" "$BUILD_NUMBER"
  echo "Build info published successfully"
fi

echo "npm packages uploaded successfully!"
