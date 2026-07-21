#!/usr/bin/env bash
set -euo pipefail

echo "=== JFrog CLI Action Local Test ==="
echo ""

# Parse command line arguments
ACTION="${1:-push-python}"
DRY_RUN="${2:-true}"

# Create test directories and files
echo "Setting up test environment..."
mkdir -p dist/python dist/js .repo src/python src/js

# Create dummy files
touch dist/python/test-package-0.0.1-py3-none-any.whl
touch dist/python/test-package-0.0.1.tar.gz
touch dist/js/test-package-0.0.1.tgz

# Create dummy dependency manifests for the install actions
printf 'requests==2.31.0\n' > src/python/requirements.txt
printf '{"name":"test-package","version":"0.0.1"}\n' > src/js/package.json

# Initialize a dummy git repo if needed
if [ ! -d .repo/.git ]; then
  echo "Creating dummy git repo in .repo/..."
  (cd .repo && git init && git config user.name "Test" && git config user.email "test@example.com" && touch README.md && git add . && git commit -m "Initial commit")
fi

echo ""
echo "Test environment ready!"
echo ""

# Set common environment variables
export BUILD_NAME="test-build"
export BUILD_NUMBER="test-12345-1"
export MODULE_NAME="test-module"
export PROPERTIES="git.tag=v0.0.1;test=true"
export GIT_REPO_PATH=".repo"
export DRY_RUN="$DRY_RUN"
export DEBUG="false"
export ADD_GIT_INFO="true"
export PUBLISH_BUILD_INFO="true"
export SERVER_ID="default"

if [ "$ACTION" = "push-python" ]; then
  echo "=== Testing push-python.sh ==="
  echo ""
  export SOURCE_PATH="dist/python"
  export TARGET_REPO="test-pypi-local"
  ./push-python.sh
elif [ "$ACTION" = "push-npm" ]; then
  echo "=== Testing push-npm.sh ==="
  echo ""
  export SOURCE_PATH="dist/js"
  export TARGET_REPO="test-npm-local"
  ./push-npm.sh
elif [ "$ACTION" = "install-python" ]; then
  echo "=== Testing install-python.sh ==="
  echo ""
  export SOURCE_PATH="src/python"
  export RESOLVE_REPO="test-pypi-virtual"
  export REQUIREMENTS_FILE="requirements.txt"
  ./install-python.sh
elif [ "$ACTION" = "install-npm" ]; then
  echo "=== Testing install-npm.sh ==="
  echo ""
  export SOURCE_PATH="src/js"
  export RESOLVE_REPO="test-npm-virtual"
  ./install-npm.sh
else
  echo "ERROR: Unknown action '$ACTION'"
  echo "Usage: $0 [push-python|push-npm|install-python|install-npm] [true|false]"
  echo "  First argument: action to test (default: push-python)"
  echo "  Second argument: dry-run mode (default: true)"
  exit 1
fi

echo ""
echo "=== Test completed ==="
