#!/usr/bin/env bash
set -euo pipefail

echo "Creating pull request..."

# Set outputs helper
set_output() {
  echo "$1=$2" >> "$GITHUB_OUTPUT"
}

# Configure git
git config user.name "$(echo "$COMMITTER" | sed 's/ <.*//')"
git config user.email "$(echo "$COMMITTER" | sed -n 's/.*<\(.*\)>.*/\1/p')"

# Check for changes
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Changes detected"
else
  echo "No changes detected, skipping PR creation"
  set_output "operation" "none"
  exit 0
fi

# Stage changes
echo "Staging files: $ADD_PATHS"
git add $ADD_PATHS

# Check if there are staged changes
if git diff --cached --quiet; then
  echo "No staged changes after git add, skipping PR creation"
  set_output "operation" "none"
  exit 0
fi

# Show what will be committed
echo "Changes to commit:"
git diff --cached --stat

# Create commit message
FULL_COMMIT_MESSAGE="$COMMIT_MESSAGE"
if [ "$SIGNOFF" = "true" ]; then
  FULL_COMMIT_MESSAGE="$FULL_COMMIT_MESSAGE

Signed-off-by: $AUTHOR"
fi

# Commit changes
echo "Creating commit..."
git \
  -c "user.name=$(echo "$AUTHOR" | sed 's/ <.*//')" \
  -c "user.email=$(echo "$AUTHOR" | sed -n 's/.*<\(.*\)>.*/\1/p')" \
  commit -m "$FULL_COMMIT_MESSAGE"

HEAD_SHA=$(git rev-parse HEAD)
echo "Commit created: $HEAD_SHA"

# Check if branch exists on remote
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
REMOTE_EXISTS=false

if git ls-remote --heads origin "$BRANCH_NAME" | grep -q "$BRANCH_NAME"; then
  REMOTE_EXISTS=true
  echo "Branch '$BRANCH_NAME' exists on remote"
fi

# If we're not already on the target branch, create/checkout
if [ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]; then
  if $REMOTE_EXISTS; then
    echo "Checking out existing remote branch '$BRANCH_NAME'"
    git fetch origin "$BRANCH_NAME"
    git checkout -B "$BRANCH_NAME" "origin/$BRANCH_NAME"
    git cherry-pick "$HEAD_SHA"
  else
    echo "Creating new branch '$BRANCH_NAME'"
    git checkout -b "$BRANCH_NAME"
  fi
fi

# Push branch
echo "Pushing branch '$BRANCH_NAME' to origin..."
git push origin "$BRANCH_NAME" --force-with-lease

# Check if PR already exists
echo "Checking for existing PR..."
EXISTING_PR=$(gh pr list \
  --head "$BRANCH_NAME" \
  --base "$BASE_BRANCH" \
  --json number,url \
  --jq '.[0]' 2>/dev/null || echo "null")

if [ "$EXISTING_PR" != "null" ] && [ -n "$EXISTING_PR" ]; then
  PR_NUMBER=$(echo "$EXISTING_PR" | jq -r '.number')
  PR_URL=$(echo "$EXISTING_PR" | jq -r '.url')

  echo "Updating existing PR #$PR_NUMBER"

  # Update PR body if provided
  if [ -n "$PR_BODY" ]; then
    gh pr edit "$PR_NUMBER" --body "$PR_BODY"
  fi

  # Add labels if provided
  if [ -n "$LABELS" ]; then
    IFS=',' read -ra LABEL_ARRAY <<< "$LABELS"
    for label in "${LABEL_ARRAY[@]}"; do
      label=$(echo "$label" | xargs) # trim
      gh pr edit "$PR_NUMBER" --add-label "$label" || echo "Warning: Could not add label '$label'"
    done
  fi

  set_output "operation" "updated"
  set_output "pr_number" "$PR_NUMBER"
  set_output "pr_url" "$PR_URL"
  set_output "head_sha" "$HEAD_SHA"

  echo "✓ PR #$PR_NUMBER updated: $PR_URL"
else
  echo "Creating new PR..."

  # Build gh pr create command
  PR_CMD="gh pr create --base \"$BASE_BRANCH\" --head \"$BRANCH_NAME\" --title \"$PR_TITLE\""

  if [ -n "$PR_BODY" ]; then
    PR_CMD="$PR_CMD --body \"$PR_BODY\""
  else
    PR_CMD="$PR_CMD --body \"\""
  fi

  if [ "$DRAFT" = "true" ]; then
    PR_CMD="$PR_CMD --draft"
  fi

  if [ -n "$LABELS" ]; then
    IFS=',' read -ra LABEL_ARRAY <<< "$LABELS"
    for label in "${LABEL_ARRAY[@]}"; do
      label=$(echo "$label" | xargs)
      PR_CMD="$PR_CMD --label \"$label\""
    done
  fi

  if [ -n "$ASSIGNEES" ]; then
    IFS=',' read -ra ASSIGNEE_ARRAY <<< "$ASSIGNEES"
    for assignee in "${ASSIGNEE_ARRAY[@]}"; do
      assignee=$(echo "$assignee" | xargs)
      PR_CMD="$PR_CMD --assignee \"$assignee\""
    done
  fi

  if [ -n "$REVIEWERS" ]; then
    IFS=',' read -ra REVIEWER_ARRAY <<< "$REVIEWERS"
    for reviewer in "${REVIEWER_ARRAY[@]}"; do
      reviewer=$(echo "$reviewer" | xargs)
      PR_CMD="$PR_CMD --reviewer \"$reviewer\""
    done
  fi

  # Execute command and capture URL
  PR_URL=$(eval "$PR_CMD")
  PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')

  set_output "operation" "created"
  set_output "pr_number" "$PR_NUMBER"
  set_output "pr_url" "$PR_URL"
  set_output "head_sha" "$HEAD_SHA"

  echo "✓ PR #$PR_NUMBER created: $PR_URL"
fi
