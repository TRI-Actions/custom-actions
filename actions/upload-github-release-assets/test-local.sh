#!/usr/bin/env bash
set -euo pipefail

echo "=== Upload GitHub Release Assets - Local Test ==="
echo ""

# Parse command line arguments
TAG="${1:-v0.0.1-test}"
FILES="${2:-dist/*}"
DEBUG_MODE="${3:-false}"

echo "Setting up test environment..."

# Create test files
mkdir -p dist
touch dist/test-package-0.0.1.tgz
touch dist/test-package-0.0.1.whl
touch dist/docs-site.zip

echo ""
echo "Test files created in dist/"
echo ""

# Set environment variables
export RELEASE_TAG="$TAG"
export FILES="$FILES"
export CLOBBER="true"
export REPO="${GITHUB_REPOSITORY:-owner/repo}"
export DRY_RUN="true"
export DEBUG="$DEBUG_MODE"
export GITHUB_TOKEN="${GITHUB_TOKEN:-dummy-token}"

echo "=== Running upload script in dry-run mode ==="
echo ""

./upload.sh

echo ""
echo "=== Test completed ==="
echo ""
echo "Usage:"
echo "  $0 [tag] [files] [debug]"
echo ""
echo "Examples:"
echo "  $0 v1.0.0 'dist/*.tgz'"
echo "  $0 v1.0.0 'dist/*.tgz dist/*.whl'"
echo "  $0 v1.0.0 'dist/*' true  # Enable debug mode"
