#!/usr/bin/env bash
set -euo pipefail

# Enable debug mode if requested
if [ "${DEBUG:-false}" = "true" ]; then
  set -x
  echo "=== DEBUG MODE ENABLED ==="
fi

# Validate required inputs
if [ -z "${RESOLVE_REPO:-}" ]; then
  echo "ERROR: resolve-repo is required for install-npm action"
  exit 1
fi

echo "Installing npm dependencies from JFrog..."
echo "  Source path: ${SOURCE_PATH:-.}"
echo "  Resolve repo: $RESOLVE_REPO"

# Change to source directory (should contain package.json)
cd "${SOURCE_PATH:-.}"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Current directory after cd: $(pwd)"
  echo "DEBUG: Files in directory:"
  ls -la
fi

# Verify package.json exists
if [ ! -f "package.json" ]; then
  echo "ERROR: package.json not found in ${SOURCE_PATH:-.}"
  echo "Note: source-path should point to the directory containing package.json"
  exit 1
fi

# Configure npm to resolve from the JFrog registry
echo "Configuring npm resolution repository..."
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would execute: jf npm-config --repo-resolve=$RESOLVE_REPO"
else
  jf npm-config --repo-resolve="$RESOLVE_REPO"
fi

# Resolve and install dependencies
echo "Installing npm dependencies..."
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would execute: jf npm install"
else
  jf npm install
fi

echo "npm dependencies installed successfully!"
