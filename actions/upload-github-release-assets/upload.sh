#!/usr/bin/env bash
set -euo pipefail

echo "Uploading assets to GitHub release..."
echo "  Tag: $RELEASE_TAG"
echo "  Repository: $REPO"
echo "  Files: $FILES"

# Check if release exists
if ! gh release view "$RELEASE_TAG" -R "$REPO" &>/dev/null; then
  echo "ERROR: Release '$RELEASE_TAG' not found in repository '$REPO'"
  echo "Create the release first or check the tag name"
  exit 1
fi

echo "✓ Release '$RELEASE_TAG' exists"

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
"${UPLOAD_CMD[@]}"

echo ""
echo "✓ Successfully uploaded ${#UPLOAD_FILES[@]} asset(s)"

# Output list of uploaded files
UPLOADED_LIST=$(printf "%s\n" "${UPLOAD_FILES[@]}")
echo "uploaded_files<<EOF" >> "$GITHUB_OUTPUT"
echo "$UPLOADED_LIST" >> "$GITHUB_OUTPUT"
echo "EOF" >> "$GITHUB_OUTPUT"
