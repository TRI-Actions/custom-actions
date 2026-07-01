#!/usr/bin/env bash
set -euo pipefail

echo "Validating PR title: $PR_TITLE"

# Initialize outputs
set_output() {
  echo "$1=$2" >> "$GITHUB_OUTPUT"
}

fail_validation() {
  local message="$1"
  echo "❌ Validation failed: $message"
  set_output "valid" "false"
  set_output "error_message" "$message"
  exit 1
}

# Check if PR has any ignore labels
if [ -n "$IGNORE_LABELS" ]; then
  IFS=',' read -ra IGNORE_ARRAY <<< "$IGNORE_LABELS"
  PR_LABELS_ARRAY=$(echo "$PR_LABELS" | jq -r '.[]')
  for label in "${IGNORE_ARRAY[@]}"; do
    label=$(echo "$label" | xargs) # trim whitespace
    if echo "$PR_LABELS_ARRAY" | grep -q "^${label}$"; then
      echo "✓ PR has ignore label '$label', skipping validation"
      set_output "valid" "true"
      exit 0
    fi
  done
fi

TITLE="$PR_TITLE"

# Handle WIP prefix
if [ "$WIP" = "true" ]; then
  if [[ "$TITLE" =~ ^(\[WIP\]|WIP:)[[:space:]]* ]]; then
    echo "✓ WIP prefix detected, removing for validation"
    TITLE="${TITLE#\[WIP\] }"
    TITLE="${TITLE#WIP: }"
  fi
fi

# Conventional Commits pattern: type(scope)!: subject
# Breaking changes can be indicated with ! or BREAKING CHANGE:
PATTERN='^([a-z]+)(\(([a-z0-9/_-]+)\))?(!)?:[[:space:]]*(.+)$'

if [[ ! "$TITLE" =~ $PATTERN ]]; then
  fail_validation "PR title does not match conventional commits format: 'type(scope): subject' or 'type: subject'"
fi

TYPE="${BASH_REMATCH[1]}"
SCOPE="${BASH_REMATCH[3]}"
BREAKING_MARKER="${BASH_REMATCH[4]}"
SUBJECT="${BASH_REMATCH[5]}"

# Check for BREAKING CHANGE: in subject
BREAKING="false"
if [ "$BREAKING_MARKER" = "!" ] || [[ "$SUBJECT" =~ ^BREAKING[[:space:]]CHANGE: ]]; then
  BREAKING="true"
  if [ "$ALLOW_BREAKING" != "true" ]; then
    fail_validation "Breaking changes are not allowed"
  fi
fi

echo "Parsed components:"
echo "  Type: $TYPE"
echo "  Scope: ${SCOPE:-<none>}"
echo "  Breaking: $BREAKING"
echo "  Subject: $SUBJECT"

# Validate type
IFS=',' read -ra VALID_TYPES <<< "$TYPES"
TYPE_VALID=false
for valid_type in "${VALID_TYPES[@]}"; do
  valid_type=$(echo "$valid_type" | xargs) # trim whitespace
  if [ "$TYPE" = "$valid_type" ]; then
    TYPE_VALID=true
    break
  fi
done

if [ "$TYPE_VALID" != "true" ]; then
  fail_validation "Invalid type '$TYPE'. Allowed types: $TYPES"
fi

# Validate scope if required
if [ "$REQUIRE_SCOPE" = "true" ] && [ -z "$SCOPE" ]; then
  fail_validation "Scope is required but not provided"
fi

# Validate scope against allowed list (if provided)
if [ -n "$SCOPES" ] && [ -n "$SCOPE" ]; then
  IFS=',' read -ra VALID_SCOPES <<< "$SCOPES"
  SCOPE_VALID=false
  for valid_scope in "${VALID_SCOPES[@]}"; do
    valid_scope=$(echo "$valid_scope" | xargs)
    if [ "$SCOPE" = "$valid_scope" ]; then
      SCOPE_VALID=true
      break
    fi
  done

  if [ "$SCOPE_VALID" != "true" ]; then
    fail_validation "Invalid scope '$SCOPE'. Allowed scopes: $SCOPES"
  fi
fi

# Validate subject pattern
if ! echo "$SUBJECT" | grep -qE "$SUBJECT_PATTERN"; then
  fail_validation "Subject does not match required pattern: $SUBJECT_PATTERN"
fi

# All validations passed
echo "✓ PR title is valid!"
set_output "valid" "true"
set_output "type" "$TYPE"
set_output "scope" "$SCOPE"
set_output "subject" "$SUBJECT"
set_output "breaking" "$BREAKING"
set_output "error_message" ""
