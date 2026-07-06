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

# Build the upload command
UPLOAD_CMD="jf rt upload"
UPLOAD_CMD="$UPLOAD_CMD --server-id=${SERVER_ID:-default}"
UPLOAD_CMD="$UPLOAD_CMD --build-name=$BUILD_NAME"
UPLOAD_CMD="$UPLOAD_CMD --build-number=$BUILD_NUMBER"

# Add module name if provided
if [ -n "${MODULE_NAME:-}" ]; then
  UPLOAD_CMD="$UPLOAD_CMD --module=$MODULE_NAME"
fi

# Add properties if provided
if [ -n "${PROPERTIES:-}" ]; then
  UPLOAD_CMD="$UPLOAD_CMD --props=$PROPERTIES"
fi

# Upload tgz files
if compgen -G "$SOURCE_PATH/*.tgz" > /dev/null; then
  echo "Uploading .tgz files..."
  eval "$UPLOAD_CMD \"$SOURCE_PATH/*.tgz\" \"$TARGET_REPO/\""
else
  echo "ERROR: No .tgz files found in $SOURCE_PATH"
  exit 1
fi

# Add git info if requested
if [ "${ADD_GIT_INFO:-true}" = "true" ]; then
  echo "Adding git info to build..."
  jf rt build-add-git "$BUILD_NAME" "$BUILD_NUMBER" || {
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
