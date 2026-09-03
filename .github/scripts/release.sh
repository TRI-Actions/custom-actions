#!/usr/bin/env bash
#
# .github/scripts/release.sh
#
# Cuts per-action releases for TRI-Actions/custom-actions using git tags and
# gh releases (no JFrog).
#
# Modes (env MODE):
#   preview   - PR sync/label event. For each changed action under actions/*,
#               compute the prospective new stable version from the highest
#               existing stable tag + the PR's bump label, delete prior origin
#               RC tags for this PR, then push a fresh '<action>/vX.Y.Z-rc.<PR>'
#               at the PR head SHA. Comment a summary on the PR.
#   publish   - !publish comment on a PR. For each changed action, cut the
#               stable '<action>/vX.Y.Z' at the PR head SHA (which will be the
#               merge commit after merge), force-move '<action>/vX' to the
#               same SHA, create a gh release, delete this PR's RC tags on
#               success (per-action), then merge the PR with
#               'gh pr merge --merge --delete-branch'.
#
# Env (all modes):
#   MODE          preview|publish
#   HEAD_SHA      commit SHA to tag (PR head)
#   PR_NUMBER     PR number
#   BASE_REF      PR base branch (e.g. main). Used for the diff to find changed actions.
#   REPO          owner/name (for gh api calls)
#   GH_TOKEN      required by gh CLI
#
# Env (preview only):
#   EVENT_ACTION  the pull_request event action, e.g. 'unlabeled'. Empty on publish.
#   PR_LABELS_JSON  JSON array of label names from the event payload. Publish
#                   re-queries labels live because labels can move between
#                   the last preview and the !publish comment.
#
# Exit:
#   0 success or nothing to do
#   1 one or more actions failed
#   2 usage/config error

set -euo pipefail

# ---------- config ----------

MODE="${MODE:-}"

# Strict regexes. Every string that ever reaches a git or gh invocation goes
# through one of these; nothing user-provided is passed unchecked.
ACTION_NAME_RE='^[a-z0-9][a-z0-9_-]*$'
BUMP_RE='^(major|minor|patch)$'

STEP_SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/null}"

log() { echo "==> $*"; }
err() { echo "!! $*" >&2; }

require_env() {
  local n="$1"
  if [[ -z "${!n:-}" ]]; then err "missing required env: $n"; exit 2; fi
}

# ---------- semver helpers ----------

# bump_version <current> <bump_type>
# current may be "v1.2.3" or "1.2.3". Prints "vX.Y.Z" on stdout.
# Git-tag convention (v-prefixed) is intentional for GitHub Actions consumption
# where users pin '@vX.Y.Z' or '@vX'; this is a deliberate divergence from the
# tf-modules JFrog module registry convention (which is bare 'X.Y.Z').
bump_version() {
  local current="${1#v}"
  local bump_type="$2"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$current"
  # Reject leading zeros so bash arithmetic never sees "08"/"09" as octal and
  # tag history cannot be silently rewritten (v01.02.03 -> v1.2.3).
  local numre='^(0|[1-9][0-9]*)$'
  if ! [[ "$major" =~ $numre && "$minor" =~ $numre && "$patch" =~ $numre ]]; then
    err "cannot parse semver: '$current'"; return 1
  fi
  case "$bump_type" in
    major) major=$((major+1)); minor=0; patch=0 ;;
    minor) minor=$((minor+1)); patch=0 ;;
    patch) patch=$((patch+1)) ;;
    *) err "invalid bump type: '$bump_type'"; return 1 ;;
  esac
  printf 'v%d.%d.%d' "$major" "$minor" "$patch"
}

# highest_stable_tag <action>
# Prints the highest '<action>/vN.M.P' tag (STRICT semver, no '-rc' etc.), or
# empty. We rely on the local checkout having fetch-tags: true.
highest_stable_tag() {
  local action="$1"
  git tag --list "${action}/v*" --sort=-v:refname \
    | grep -E "^${action}/v[0-9]+\.[0-9]+\.[0-9]+$" \
    | head -n 1 || true
}

# origin_tag_commit_sha <tag>
# Returns commit SHA of the tag on origin (peeled if annotated), or empty.
origin_tag_commit_sha() {
  local tag="$1"
  git ls-remote --tags origin "refs/tags/${tag}" "refs/tags/${tag}^{}" 2>/dev/null \
    | awk -v tag="refs/tags/${tag}" -v peel="refs/tags/${tag}^{}" '
        $2 == peel { p = $1 }
        $2 == tag  { t = $1 }
        END { print (p ? p : t) }
      '
}

# list_origin_rc_tags_for_pr <action> <pr>
# Prints ref names of origin RC tags for this action/PR, one per line.
# Strict regex filter after the ls-remote glob so we never match unrelated tags.
list_origin_rc_tags_for_pr() {
  local action="$1" pr="$2"
  git ls-remote --tags origin "refs/tags/${action}/v*-rc.${pr}" 2>/dev/null \
    | awk '{ print $2 }' \
    | grep -E "^refs/tags/${action}/v[0-9]+\.[0-9]+\.[0-9]+-rc\.${pr}$" || true
}

# ---------- change discovery ----------

# changed_actions <base_ref>
# Prints unique first-level dirs under actions/ that changed between
# origin/<base_ref> and HEAD. Filters strictly to names matching ACTION_NAME_RE.
# We do NOT try to exclude README/CHANGELOG-only diffs - per the spec, any
# change under actions/<name>/ is user-visible enough to warrant a bump.
# This is an intentional deviation from tf-modules's '\.tf$' filter: this
# repo hosts composite/JS actions where any file (action.yml, src/, node_modules
# manifests, README consumed by the marketplace, etc.) is user-visible.
changed_actions() {
  local base="$1"
  # Ensure we have origin/<base>. Fail loud if we can't - a stale ref would
  # silently produce empty diffs and hide changed actions.
  if ! git fetch --no-tags origin "$base" >/dev/null 2>&1; then
    err "git fetch origin/${base} failed; cannot compute diff"
    return 1
  fi
  # Grep with the anchored ACTION_NAME_RE directly: any garbage name gets
  # dropped here rather than surfacing as a spurious 'failed' row later.
  git diff --name-only "origin/${base}...HEAD" 2>/dev/null \
    | awk -F/ '$1 == "actions" && NF >= 2 { print $2 }' \
    | sort -u \
    | grep -E "$ACTION_NAME_RE" || true
}

# ---------- label helpers ----------

# pick_bump_from_labels <json_array>
# Applies tf-modules precedence: major > minor > patch. If any of the three
# is present, returns the highest; empty otherwise. Never fails on 'multiple
# bump labels' - a routine label transition (add 'minor', forget to remove
# 'patch') should not break releases.
pick_bump_from_labels() {
  local labels_json="$1"
  local names
  # Two-line pattern so 'set -e' sees the substitution's real exit status,
  # instead of the always-zero 'local' declaration exit code.
  names="$(printf '%s' "${labels_json:-[]}" | jq -r '(. // []) | .[]?' 2>/dev/null || true)"
  if grep -qxF 'major' <<< "$names"; then printf 'major'; return 0; fi
  if grep -qxF 'minor' <<< "$names"; then printf 'minor'; return 0; fi
  if grep -qxF 'patch' <<< "$names"; then printf 'patch'; return 0; fi
  printf ''
}

# auto_add_patch_label <pr>
# Adds the 'patch' label to the PR and posts a marker-tagged comment
# explaining the default. Best-effort; a failure here is not fatal.
auto_add_patch_label() {
  local pr="$1"
  log "no bump label present; auto-adding 'patch'"
  gh pr edit "$pr" --add-label "patch" >/dev/null 2>&1 \
    || err "failed to auto-add 'patch' label (non-fatal, continuing)"
  local note
  note="$(mktemp)"
  printf '<!-- release-default-label:%s -->\nNo bump label was set - defaulted to `patch`. Change to `major` or `minor` to bump differently before commenting `!publish`.\n' "$pr" > "$note"
  post_or_update_pr_comment "$pr" "release-default-label:${pr}" "$note"
  rm -f "$note"
}

# ---------- PR commenting ----------

# post_or_update_pr_comment <pr> <marker> <body_file>
# Marker is an HTML comment like 'release-preview:123' embedded in the body,
# used to find and update the existing comment instead of piling up new ones.
post_or_update_pr_comment() {
  local pr="$1" marker="$2" body_file="$3"
  [[ -z "$pr" ]] && return 0
  local existing_id
  # Pipe through jq externally so we can use --arg to keep the marker
  # outside of jq's parser: even if a future edit passes a value containing
  # '"' or '\', it cannot break out of the string.
  existing_id="$(gh api "repos/${REPO}/issues/${pr}/comments" --paginate 2>/dev/null \
      | jq -rs --arg m "$marker" \
          '(add // []) | .[] | select(.body | contains("<!-- " + $m + " -->")) | .id' \
          2>/dev/null | head -n 1 || true)"
  if [[ -n "$existing_id" ]]; then
    if ! gh api -X PATCH "repos/${REPO}/issues/comments/${existing_id}" \
          -F "body=@${body_file}" >/dev/null 2>&1; then
      err "failed to update PR comment ${existing_id} (non-fatal)"
    fi
  else
    if ! gh pr comment "$pr" --body-file "$body_file" >/dev/null 2>&1; then
      err "failed to create PR comment on #${pr} (non-fatal)"
    fi
  fi
}

# ---------- action processing ----------

# validate_action <name>
validate_action() {
  local a="$1"
  if ! [[ "$a" =~ $ACTION_NAME_RE ]]; then
    err "invalid action name: '$a'"; return 1
  fi
  if [[ ! -d "actions/$a" ]]; then
    err "actions/$a/ does not exist at HEAD"; return 1
  fi
  return 0
}

# preview_one <action> <bump> <pr> <head_sha>
# Delete prior RCs for this PR, push a fresh RC tag. Returns 0/1, never exits.
# Sets globals PREVIEW_PREV, PREVIEW_RC for the caller to format the row.
PREVIEW_PREV=""
PREVIEW_RC=""
preview_one() {
  local a="$1" bump="$2" pr="$3" sha="$4"
  PREVIEW_PREV="" PREVIEW_RC=""

  validate_action "$a" || return 1

  local highest prev new_version
  highest="$(highest_stable_tag "$a")"
  if [[ -z "$highest" ]]; then prev="v0.0.0"; else prev="${highest#${a}/}"; fi
  if ! new_version="$(bump_version "$prev" "$bump")"; then return 1; fi

  local rc_tag="${a}/${new_version}-rc.${pr}"
  PREVIEW_PREV="$prev"
  PREVIEW_RC="$rc_tag"

  # Delete any prior RC tags for THIS PR on this action. This includes RCs
  # from earlier bump choices (e.g. patch -> minor) and earlier commits.
  local prior
  prior="$(list_origin_rc_tags_for_pr "$a" "$pr")"
  if [[ -n "$prior" ]]; then
    log "deleting prior origin RC tags for $a on PR #$pr:"
    printf '    %s\n' $prior
    local -a delrefs=()
    while IFS= read -r ref; do
      [[ -z "$ref" ]] && continue
      delrefs+=(":${ref}")
    done <<< "$prior"
    if (( ${#delrefs[@]} > 0 )); then
      if ! git push origin "${delrefs[@]}" >/dev/null 2>&1; then
        err "failed to delete some prior RC tags for $a (continuing)"
      fi
    fi
  fi

  # Lightweight tag (RCs don't need annotation and are easier to bulk-delete).
  # '+' on the refspec scopes force to just this ref, so the delete-then-push
  # sequence is safe even if the local repo already had a stale tag.
  if ! git tag -f "$rc_tag" "$sha" >/dev/null 2>&1; then
    err "git tag failed for $rc_tag"; return 1
  fi
  if ! git push origin "+refs/tags/${rc_tag}:refs/tags/${rc_tag}" >/dev/null 2>&1; then
    err "git push failed for $rc_tag"
    git tag -d "$rc_tag" >/dev/null 2>&1 || true
    return 1
  fi
  log "pushed RC tag $rc_tag at $sha"
  return 0
}

# cleanup_rc_tags_for_action <action> <pr>
# Best-effort deletion of RC tags for a single (action, pr). Used by
# publish_one after a successful publish for THAT action - matches
# tf-modules per-module cleanup semantics: a failed action leaves its
# RCs in place for the operator to inspect and re-run against.
cleanup_rc_tags_for_action() {
  local a="$1" pr="$2"
  local refs
  refs="$(list_origin_rc_tags_for_pr "$a" "$pr")"
  local -a delrefs=()
  while IFS= read -r r; do
    [[ -z "$r" ]] && continue
    delrefs+=(":${r}")
  done <<< "$refs"
  if (( ${#delrefs[@]} == 0 )); then return 0; fi
  log "cleaning up ${#delrefs[@]} RC tag(s) on origin for ${a} on PR #${pr}"
  git push origin "${delrefs[@]}" >/dev/null 2>&1 \
    || err "failed to delete some RC tags for ${a} on PR #${pr} (non-fatal)"
}

# publish_one <action> <bump> <pr> <head_sha>
# Cut stable tag + floating major + gh release; on success, cleanup this
# action's RC tags for the PR (per-module cleanup, matches tf-modules).
# Sets PUBLISH_PREV/PUBLISH_IMMUTABLE/PUBLISH_FLOATING/PUBLISH_URL.
PUBLISH_PREV=""
PUBLISH_IMMUTABLE=""
PUBLISH_FLOATING=""
PUBLISH_URL=""
publish_one() {
  local a="$1" bump="$2" pr="$3" sha="$4"
  PUBLISH_PREV="" PUBLISH_IMMUTABLE="" PUBLISH_FLOATING="" PUBLISH_URL=""

  validate_action "$a" || return 1

  local highest prev new_version new_major immutable_tag floating_tag
  highest="$(highest_stable_tag "$a")"
  if [[ -z "$highest" ]]; then prev="v0.0.0"; else prev="${highest#${a}/}"; fi
  if ! new_version="$(bump_version "$prev" "$bump")"; then return 1; fi
  new_major="v$(printf '%s' "${new_version#v}" | cut -d. -f1)"
  immutable_tag="${a}/${new_version}"
  floating_tag="${a}/${new_major}"

  PUBLISH_PREV="$prev"
  PUBLISH_IMMUTABLE="$immutable_tag"
  PUBLISH_FLOATING="$floating_tag"

  # Floating-major tag ('<action>/vX') is a deliberate divergence from
  # tf-modules (which stores only exact versions in JFrog): GitHub Actions
  # consumers commonly pin '@v1', so a moving pointer to the latest v1.y.z
  # is required for that consumption model.

  # Idempotency: if the immutable tag already exists on origin, either heal a
  # missing release (same SHA) or refuse (different SHA - never overwrite).
  local origin_sha
  origin_sha="$(origin_tag_commit_sha "$immutable_tag")"
  if [[ -n "$origin_sha" ]]; then
    if [[ "$origin_sha" == "$sha" ]]; then
      if gh release view "$immutable_tag" >/dev/null 2>&1; then
        log "tag $immutable_tag + release already exist at $sha; idempotent no-op"
        PUBLISH_URL="already-released"
        cleanup_rc_tags_for_action "$a" "$pr"
        return 0
      fi
      log "healing missing gh release for orphan tag $immutable_tag"
      if ! PUBLISH_URL="$(gh release create "$immutable_tag" \
            --title "${a} ${new_version}" --generate-notes 2>&1)"; then
        err "gh release create failed while healing $immutable_tag: $PUBLISH_URL"
        return 1
      fi
      cleanup_rc_tags_for_action "$a" "$pr"
      return 0
    fi
    err "immutable tag $immutable_tag exists on origin at $origin_sha (target was $sha); refusing to overwrite"
    return 1
  fi

  # Local defense-in-depth.
  if git rev-parse --verify --quiet "refs/tags/${immutable_tag}" >/dev/null; then
    err "immutable tag $immutable_tag exists locally; refusing to overwrite"
    return 1
  fi

  local prior_floating_sha
  prior_floating_sha="$(git rev-parse --verify --quiet "refs/tags/${floating_tag}^{commit}" 2>/dev/null || true)"

  if ! git tag -a "$immutable_tag" -m "${a} ${new_version}" "$sha" >/dev/null 2>&1; then
    err "git tag -a failed for $immutable_tag"; return 1
  fi
  if ! git tag -f "$floating_tag" "$sha" >/dev/null 2>&1; then
    err "git tag -f failed for $floating_tag"
    git tag -d "$immutable_tag" >/dev/null 2>&1 || true
    return 1
  fi

  # --atomic: both refspecs commit or neither does. '+' on the floating ref
  # scopes force to just that ref, so the immutable tag cannot be overwritten
  # by this single push.
  if ! git push --atomic origin \
        "refs/tags/${immutable_tag}:refs/tags/${immutable_tag}" \
        "+refs/tags/${floating_tag}:refs/tags/${floating_tag}" >/dev/null 2>&1; then
    err "git push --atomic failed for $immutable_tag / $floating_tag"
    git tag -d "$immutable_tag" >/dev/null 2>&1 || true
    if [[ -n "$prior_floating_sha" ]]; then
      git update-ref "refs/tags/${floating_tag}" "$prior_floating_sha" 2>/dev/null || true
    else
      git tag -d "$floating_tag" >/dev/null 2>&1 || true
    fi
    return 1
  fi

  # gh release must be created AFTER the tag exists on origin.
  if ! PUBLISH_URL="$(gh release create "$immutable_tag" \
        --title "${a} ${new_version}" --generate-notes 2>&1)"; then
    err "gh release create failed for $immutable_tag: $PUBLISH_URL"
    err "  the tag is on origin; re-running !publish will detect the orphan and heal the release."
    return 1
  fi
  log "released $immutable_tag at $sha; $floating_tag -> $sha; $PUBLISH_URL"

  # Per-action RC cleanup on success (matches tf-modules).
  cleanup_rc_tags_for_action "$a" "$pr"
  return 0
}

# ---------- modes ----------

do_preview() {
  require_env PR_NUMBER
  require_env BASE_REF
  require_env HEAD_SHA

  # Preview uses the event-snapshot labels (they reflect state AFTER the
  # event was applied for pull_request events). Multi-label precedence:
  # major > minor > patch.
  local bump
  bump="$(pick_bump_from_labels "${PR_LABELS_JSON:-[]}")"

  if [[ -z "$bump" ]]; then
    # No bump label present. Silent skip if the trigger was an 'unlabeled'
    # event (user just removed the label - don't nag them). Otherwise auto
    # add 'patch' and continue.
    if [[ "${EVENT_ACTION:-}" == "unlabeled" ]]; then
      log "no bump label after unlabeled event; silent skip"
      exit 0
    fi
    auto_add_patch_label "$PR_NUMBER"
    bump="patch"
  fi

  # Discover changed actions.
  local changed
  if ! changed="$(changed_actions "$BASE_REF")"; then
    err "failed to discover changed actions"
    exit 1
  fi
  local -a actions=()
  while IFS= read -r a; do
    [[ -z "$a" ]] && continue
    actions+=("$a")
  done <<< "$changed"

  # Compose the summary while running. Any per-action failure records a row
  # but does not abort the rest.
  local -a rows=()
  local a status_col
  local failed=0
  if (( ${#actions[@]} == 0 )); then
    log "no changed actions under actions/*; nothing to preview"
  else
    log "bump=$bump; changed actions: ${actions[*]}"
    for a in "${actions[@]}"; do
      if preview_one "$a" "$bump" "$PR_NUMBER" "$HEAD_SHA"; then
        status_col="ok"
      else
        status_col="failed"
        failed=1
      fi
      rows+=("| \`${a}\` | ${bump} | ${PREVIEW_PREV:--} | \`${PREVIEW_RC:--}\` | ${status_col} |")
    done
  fi

  # Post/refresh the preview comment.
  local body; body="$(mktemp)"
  {
    printf '<!-- release-preview:%s -->\n' "$PR_NUMBER"
    printf '## Release preview\n\n'
    printf 'Head SHA: `%s`  \n' "$HEAD_SHA"
    printf 'Bump: `%s`\n\n' "$bump"
    printf 'Comment `!publish` to cut stable releases for the actions below and merge this PR.\n\n'
    printf '| Action | Bump | Previous stable | RC tag | Status |\n'
    printf '|---|---|---|---|---|\n'
    if (( ${#rows[@]} == 0 )); then
      printf '| _no changed actions under `actions/*`_ | | | | |\n'
    else
      local r; for r in "${rows[@]}"; do printf '%s\n' "$r"; done
    fi
  } > "$body"
  post_or_update_pr_comment "$PR_NUMBER" "release-preview:${PR_NUMBER}" "$body"

  # Mirror to job summary.
  cat "$body" >> "$STEP_SUMMARY_FILE" || true
  rm -f "$body"

  (( failed == 0 )) || exit 1
}

do_publish() {
  require_env PR_NUMBER
  require_env BASE_REF
  require_env HEAD_SHA

  # Publish always re-reads labels live: the PR may have had its bump label
  # changed between the last preview and this !publish comment.
  local labels_json
  labels_json="$(gh pr view "$PR_NUMBER" --json labels -q '[.labels[].name]' 2>/dev/null || echo '[]')"
  local bump
  bump="$(pick_bump_from_labels "$labels_json")"

  if [[ -z "$bump" ]]; then
    # Match preview: auto-add 'patch' and continue (matches tf-modules unified
    # flow where auto-patch applies to both RC and stable paths).
    auto_add_patch_label "$PR_NUMBER"
    bump="patch"
  fi

  # Approval and mergeability gate. Even though the workflow gates on
  # write-permission for the commenter, the PR itself must be approved by
  # the branch protection reviewer set - a write user cannot rubber-stamp
  # their own unreviewed change via !publish.
  local review_decision mergeable pr_head_live
  review_decision="$(gh pr view "$PR_NUMBER" --json reviewDecision -q '.reviewDecision' 2>/dev/null || echo '')"
  mergeable="$(gh pr view "$PR_NUMBER" --json mergeable -q '.mergeable' 2>/dev/null || echo '')"
  pr_head_live="$(gh pr view "$PR_NUMBER" --json headRefOid -q '.headRefOid' 2>/dev/null || echo '')"

  if [[ "$review_decision" != "APPROVED" ]]; then
    err "cannot publish: PR #${PR_NUMBER} reviewDecision='${review_decision:-<none>}' (must be APPROVED)"
    local note; note="$(mktemp)"
    printf '<!-- release-publish:%s -->\nCannot `!publish`: PR is not approved (reviewDecision=`%s`). Get an approving review and re-comment `!publish`.\n' \
      "$PR_NUMBER" "${review_decision:-<none>}" > "$note"
    post_or_update_pr_comment "$PR_NUMBER" "release-publish:${PR_NUMBER}" "$note"
    rm -f "$note"
    exit 1
  fi
  if [[ "$mergeable" != "MERGEABLE" ]]; then
    err "cannot publish: PR #${PR_NUMBER} mergeable='${mergeable:-<none>}' (must be MERGEABLE)"
    local note; note="$(mktemp)"
    printf '<!-- release-publish:%s -->\nCannot `!publish`: PR is not mergeable (state=`%s`). Resolve conflicts / failing required checks and re-comment `!publish`.\n' \
      "$PR_NUMBER" "${mergeable:-<none>}" > "$note"
    post_or_update_pr_comment "$PR_NUMBER" "release-publish:${PR_NUMBER}" "$note"
    rm -f "$note"
    exit 1
  fi
  if [[ -z "$pr_head_live" || "$pr_head_live" != "$HEAD_SHA" ]]; then
    err "cannot publish: PR #${PR_NUMBER} head SHA changed between !publish and now (was ${HEAD_SHA}, is ${pr_head_live:-<unknown>})"
    local note; note="$(mktemp)"
    printf '<!-- release-publish:%s -->\nCannot `!publish`: the PR head advanced from `%s` to `%s` after the command was issued. Wait for the new preview run and re-comment `!publish`.\n' \
      "$PR_NUMBER" "$HEAD_SHA" "${pr_head_live:-<unknown>}" > "$note"
    post_or_update_pr_comment "$PR_NUMBER" "release-publish:${PR_NUMBER}" "$note"
    rm -f "$note"
    exit 1
  fi

  local changed
  if ! changed="$(changed_actions "$BASE_REF")"; then
    err "failed to discover changed actions"
    exit 1
  fi
  local -a actions=()
  while IFS= read -r a; do
    [[ -z "$a" ]] && continue
    actions+=("$a")
  done <<< "$changed"

  if (( ${#actions[@]} == 0 )); then
    err "no changed actions under actions/*; nothing to publish"
    local note; note="$(mktemp)"
    printf '<!-- release-publish:%s -->\nNothing to publish - no changes detected under `actions/*`.\n' "$PR_NUMBER" > "$note"
    post_or_update_pr_comment "$PR_NUMBER" "release-publish:${PR_NUMBER}" "$note"
    rm -f "$note"
    exit 0
  fi

  log "publish: bump=$bump; actions: ${actions[*]}; head=$HEAD_SHA"

  local -a rows=()
  local a status_col
  local failed=0
  for a in "${actions[@]}"; do
    if publish_one "$a" "$bump" "$PR_NUMBER" "$HEAD_SHA"; then
      status_col="released"
    else
      status_col="failed"
      failed=1
    fi
    rows+=("| \`${a}\` | ${bump} | ${PUBLISH_PREV:--} | \`${PUBLISH_IMMUTABLE:--}\` | \`${PUBLISH_FLOATING:--}\` | ${status_col} | ${PUBLISH_URL:--} |")
  done

  local body; body="$(mktemp)"
  {
    printf '<!-- release-publish:%s -->\n' "$PR_NUMBER"
    printf '## Release published\n\n'
    printf 'Head SHA: `%s`  \n' "$HEAD_SHA"
    printf 'Bump: `%s`\n\n' "$bump"
    printf '| Action | Bump | Previous | Immutable | Floating | Status | Notes/URL |\n'
    printf '|---|---|---|---|---|---|---|\n'
    local r; for r in "${rows[@]}"; do printf '%s\n' "$r"; done
  } > "$body"
  post_or_update_pr_comment "$PR_NUMBER" "release-publish:${PR_NUMBER}" "$body"
  cat "$body" >> "$STEP_SUMMARY_FILE" || true
  rm -f "$body"

  if (( failed != 0 )); then
    err "one or more publishes failed; NOT merging PR"
    exit 1
  fi

  # Re-verify head SHA hasn't drifted while we were pushing tags. If it has,
  # we've published against a SHA that will not be reachable from main;
  # abort the merge and let the operator decide.
  local pr_head_now
  pr_head_now="$(gh pr view "$PR_NUMBER" --json headRefOid -q '.headRefOid' 2>/dev/null || echo '')"
  if [[ "$pr_head_now" != "$HEAD_SHA" ]]; then
    err "PR head drifted from ${HEAD_SHA} to ${pr_head_now:-<unknown>} during publish; NOT merging"
    err "  releases at ${HEAD_SHA} are already published; operator must decide whether to merge manually"
    exit 1
  fi

  log "merging PR #$PR_NUMBER at $HEAD_SHA"
  if ! gh pr merge "$PR_NUMBER" --merge --delete-branch >/dev/null 2>&1; then
    err "gh pr merge failed for PR #$PR_NUMBER; releases are already published"
    exit 1
  fi
}

# ---------- entry ----------

main() {
  require_env MODE
  case "$MODE" in
    preview) do_preview ;;
    publish) do_publish ;;
    *) err "unknown MODE: '$MODE' (expected preview|publish)"; exit 2 ;;
  esac
}

main "$@"
