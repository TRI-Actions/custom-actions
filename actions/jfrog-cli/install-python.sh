#!/usr/bin/env bash
set -euo pipefail

# Enable debug mode if requested
if [ "${DEBUG:-false}" = "true" ]; then
  set -x
  echo "=== DEBUG MODE ENABLED ==="
fi

# Validate required inputs
if [ -z "${RESOLVE_REPO:-}" ]; then
  echo "ERROR: resolve-repo is required for install-python action"
  exit 1
fi

# Default requirements file
REQUIREMENTS_FILE="${REQUIREMENTS_FILE:-requirements.txt}"

echo "Installing Python dependencies from JFrog..."
echo "  Source path: ${SOURCE_PATH:-.}"
echo "  Resolve repo: $RESOLVE_REPO"
echo "  Requirements: $REQUIREMENTS_FILE"

# Change to source directory (should contain the requirements file)
cd "${SOURCE_PATH:-.}"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Current directory after cd: $(pwd)"
  echo "DEBUG: Files in directory:"
  ls -la
fi

# Verify the requirements file exists
if [ ! -f "$REQUIREMENTS_FILE" ]; then
  echo "ERROR: Requirements file '$REQUIREMENTS_FILE' not found in ${SOURCE_PATH:-.}"
  echo "Note: source-path should point to the directory containing $REQUIREMENTS_FILE"
  exit 1
fi

# Configure pip to resolve from the JFrog PyPI repository
echo "Configuring PyPI resolution repository..."
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would execute: jf pip-config --repo-resolve=$RESOLVE_REPO"
else
  jf pip-config --repo-resolve="$RESOLVE_REPO"
fi

# Resolve and install dependencies
echo "Installing Python dependencies..."
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would execute: jf pip install -r $REQUIREMENTS_FILE"
else
  jf pip install -r "$REQUIREMENTS_FILE"
fi

echo "Python dependencies installed successfully!"
