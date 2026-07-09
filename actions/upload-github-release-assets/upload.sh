#!/usr/bin/env bash
set -euo pipefail

# Enable debug mode if requested
if [ "${DEBUG:-false}" = "true" ]; then
  set -x
  echo "=== DEBUG MODE ENABLED ==="
fi

if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "=== DRY-RUN MODE ==="
fi

echo "Uploading assets to GitHub release..."
echo "  Tag: $RELEASE_TAG"
echo "  Repository: $REPO"
echo "  Files: $FILES"

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: CLOBBER=$CLOBBER"
  echo "DEBUG: DRY_RUN=${DRY_RUN:-false}"
  echo "DEBUG: Current directory: $(pwd)"
fi

# Check if release exists
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo "[DRY-RUN] Would check if release exists: gh release view \"$RELEASE_TAG\" -R \"$REPO\""
  echo "✓ Skipping release check in dry-run mode"
else
  if ! gh release view "$RELEASE_TAG" -R "$REPO" &>/dev/null; then
    echo "ERROR: Release '$RELEASE_TAG' not found in repository '$REPO'"
    echo "Create the release first or check the tag name"
    exit 1
  fi
  echo "✓ Release '$RELEASE_TAG' exists"
fi

# Expand file patterns and collect files to upload
UPLOAD_FILES=()
for pattern in $FILES; do
  # Expand glob pattern
  for file in $pattern; do
    if [ -f "$file" ]; then
      UPLOAD_FILES+=("$file")
      echo "  Found: $file"
    elif [ ! -e "$file" ]; then
      # Pattern didn't match anything - check if it was a literal path
      if [[ "$pattern" != *"*"* ]] && [[ "$pattern" != *"?"* ]]; then
        echo "ERROR: File not found: $file"
        exit 1
      fi
    fi
  done
done

if [ ${#UPLOAD_FILES[@]} -eq 0 ]; then
  echo "ERROR: No files found matching patterns: $FILES"
  exit 1
fi

if [ "${DEBUG:-false}" = "true" ]; then
  echo "DEBUG: Found ${#UPLOAD_FILES[@]} file(s) to upload"
  echo "DEBUG: Files list:"
  for file in "${UPLOAD_FILES[@]}"; do
    echo "DEBUG:   - $file (size: $(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "unknown"))"
  done
fi

echo ""
echo "Uploading ${#UPLOAD_FILES[@]} file(s)..."

# Build gh release upload command
UPLOAD_CMD=(gh release upload "$RELEASE_TAG" -R "$REPO")

# Add clobber flag if enabled
if [ "$CLOBBER" = "true" ]; then
  UPLOAD_CMD+=(--clobber)
fi

# Add all files
UPLOAD_CMD+=("${UPLOAD_FILES[@]}")

# Execute upload
if [ "${DRY_RUN:-false}" = "true" ]; then
  echo ""
  echo "[DRY-RUN] Would execute:"
  echo "  ${UPLOAD_CMD[*]}"
  echo ""
  echo "[DRY-RUN] Would upload:"
  for file in "${UPLOAD_FILES[@]}"; do
    echo "  - $file"
  done
else
  "${UPLOAD_CMD[@]}"
  echo ""
  echo "✓ Successfully uploaded ${#UPLOAD_FILES[@]} asset(s)"
fi

# Output list of uploaded files
UPLOADED_LIST=$(printf "%s\n" "${UPLOAD_FILES[@]}")
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "uploaded_files<<EOF" >> "$GITHUB_OUTPUT"
  echo "$UPLOADED_LIST" >> "$GITHUB_OUTPUT"
  echo "EOF" >> "$GITHUB_OUTPUT"
fi
