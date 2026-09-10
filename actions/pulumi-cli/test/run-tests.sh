#!/usr/bin/env bash
#
# Runs the real plan/deploy/destroy scripts against a fake pulumi (stub/pulumi)
# in a temp sandbox. No AWS, no network, no real pulumi.
#
# Usage: run-tests.sh [name-filter]

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION_DIR="$(dirname "$TEST_DIR")"
FILTER="${1:-}"

PASSED=0
FAILED_COUNT=0
FAILED_NAMES=()

CURRENT_NAME=""
CURRENT_FAILS=0
SANDBOX=""
OUTPUT=""
STATUS=0

if [[ -t 1 ]]; then
  C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_PASS=""; C_FAIL=""; C_OFF=""
fi

# ---------- assertions ----------

fail_assert() {
  printf '      %s- %s%s\n' "$C_FAIL" "$1" "$C_OFF"
  CURRENT_FAILS=$((CURRENT_FAILS + 1))
}

# Relative paths resolve inside the sandbox, so cases can say "stg/plan.out".
resolve() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$SANDBOX" "$1" ;;
  esac
}

assert_status() {
  local expected="$1"
  if [[ "$STATUS" != "$expected" ]]; then
    fail_assert "expected exit ${expected}, got ${STATUS}"
    printf '        script output was:\n'
    printf '        | %s\n' "$OUTPUT"
  fi
}

assert_out_contains() {
  case "$OUTPUT" in
    *"$1"*) ;;
    *) fail_assert "script output should contain '$1'" ;;
  esac
}

assert_out_lacks() {
  case "$OUTPUT" in
    *"$1"*) fail_assert "script output should NOT contain '$1'" ;;
  esac
}

assert_file_contains() {
  local path content
  path="$(resolve "$1")"
  if [[ ! -f "$path" ]]; then
    fail_assert "expected file '$1' to exist"
    return
  fi
  content="$(cat "$path")"
  case "$content" in
    *"$2"*) ;;
    *) fail_assert "file '$1' should contain '$2' (got: $(printf '%s' "$content" | tr '\n' '/'))" ;;
  esac
}

assert_file_lacks() {
  local path content
  path="$(resolve "$1")"
  [[ -f "$path" ]] || return 0
  content="$(cat "$path")"
  case "$content" in
    *"$2"*) fail_assert "file '$1' should NOT contain '$2'" ;;
  esac
}

# Exact whole-line match, for output keys where a substring would be too loose
# (e.g. 'failed-workdirs=stg' must not also match 'failed-workdirs=stg prd').
assert_file_has_line() {
  local path
  path="$(resolve "$1")"
  if [[ ! -f "$path" ]]; then
    fail_assert "expected file '$1' to exist"
    return
  fi
  if ! grep -qxF "$2" "$path"; then
    fail_assert "file '$1' should have the exact line '$2' (got: $(tr '\n' '/' < "$path"))"
  fi
}

assert_first_line() {
  local path first
  path="$(resolve "$1")"
  if [[ ! -f "$path" ]]; then
    fail_assert "expected file '$1' to exist"
    return
  fi
  first="$(head -n 1 "$path")"
  case "$first" in
    *"$2"*) ;;
    *) fail_assert "first line of '$1' should contain '$2' (got: '${first}')" ;;
  esac
}

# assert_output_files <expected_count> [expected_path...]
# Validates the 'output-files<<EOF' heredoc block: it must be terminated, hold exactly
# <expected_count> lines, and every line must be an absolute path. GitHub's
# $GITHUB_OUTPUT parser silently mangles an unterminated or blank-padded block.
assert_output_files() {
  local expected_count="$1"; shift
  local block count line

  if ! block="$(awk '
      /^output-files<<EOF$/ { inblock = 1; next }
      inblock && /^EOF$/    { inblock = 0; closed = 1; next }
      inblock               { print }
      END                   { exit(closed ? 0 : 1) }
    ' "$OUTPUTS_FILE" 2>/dev/null)"; then
    fail_assert "outputs file has no terminated 'output-files<<EOF' block"
    return
  fi

  if [[ -z "$block" ]]; then
    count=0
  else
    count="$(printf '%s\n' "$block" | wc -l | tr -d ' ')"
  fi

  if [[ "$count" != "$expected_count" ]]; then
    fail_assert "expected ${expected_count} output file(s), got ${count}: $(printf '%s' "$block" | tr '\n' '/')"
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
      /*) [[ -f "$line" ]] || fail_assert "output file '$line' does not exist" ;;
      *) fail_assert "output file path is not absolute: '$line'" ;;
    esac
  done <<< "$block"

  for line in "$@"; do
    case "$block" in
      *"$line"*) ;;
      *) fail_assert "output-files should list '$line'" ;;
    esac
  done
}

# The stub logs one line per pulumi call, so these assert on what was invoked.
assert_ran() { assert_file_contains "$STUB_LOG" "$1"; }
assert_never_ran() { assert_file_lacks "$STUB_LOG" "$1"; }

# ---------- harness ----------

new_sandbox() {
  SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/pulumi-cli-test.XXXXXX")"
  # Normalised, so paths built here compare equal to the ones the scripts resolve
  # with 'cd && pwd'. A $TMPDIR with a trailing slash would otherwise leave a '//'.
  SANDBOX="$(cd "$SANDBOX" && pwd)"
  mkdir -p "$SANDBOX/bin"
  cp "$TEST_DIR/stub/pulumi" "$SANDBOX/bin/pulumi"
  chmod +x "$SANDBOX/bin/pulumi"

  GH_OUTPUT="$SANDBOX/github_output"; : > "$GH_OUTPUT"
  GH_SUMMARY="$SANDBOX/github_summary"; : > "$GH_SUMMARY"
  STUB_LOG="$SANDBOX/stub.log"; : > "$STUB_LOG"
  OUTPUTS_FILE="$SANDBOX/outputs.txt"; rm -f "$OUTPUTS_FILE"

  WORKDIRS="."
  UPDATE_STATE="false"
  DRIFT_CHECK="false"

  unset STUB_FAIL_CMDS STUB_FAIL_IN_DIR STUB_NO_STACK STUB_FAIL_INIT \
        STUB_DRIFT STUB_DRIFT_IN_DIR STUB_PREVIEW_MARKER STUB_PREVIEW_EXTRA
}

# Creates the dirs and points WORKDIRS at them.
workdirs() {
  local d
  for d in "$@"; do mkdir -p "$SANDBOX/$d"; done
  WORKDIRS="$*"
}

# Every variable is passed explicitly so the outer shell cannot influence a case.
run() {
  OUTPUT="$(
    cd "$SANDBOX" || exit 99
    PATH="$SANDBOX/bin:$PATH" \
    GITHUB_REPOSITORY="TRI-Actions/example-infra" \
    GITHUB_OUTPUT="$GH_OUTPUT" \
    GITHUB_STEP_SUMMARY="$GH_SUMMARY" \
    OUTPUTS_FILE="$OUTPUTS_FILE" \
    WORKDIRS="$WORKDIRS" \
    UPDATE_STATE="$UPDATE_STATE" \
    DRIFT_CHECK="$DRIFT_CHECK" \
    STUB_LOG="$STUB_LOG" \
    STUB_FAIL_CMDS="${STUB_FAIL_CMDS:-}" \
    STUB_FAIL_IN_DIR="${STUB_FAIL_IN_DIR:-}" \
    STUB_NO_STACK="${STUB_NO_STACK:-}" \
    STUB_FAIL_INIT="${STUB_FAIL_INIT:-}" \
    STUB_DRIFT="${STUB_DRIFT:-}" \
    STUB_DRIFT_IN_DIR="${STUB_DRIFT_IN_DIR:-}" \
    STUB_PREVIEW_MARKER="${STUB_PREVIEW_MARKER:-}" \
    STUB_PREVIEW_EXTRA="${STUB_PREVIEW_EXTRA:-}" \
    "$ACTION_DIR/$1" 2>&1
  )"
  STATUS=$?
}

run_test() {
  local name="$1"
  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
    return 0
  fi
  CURRENT_NAME="$name"
  CURRENT_FAILS=0
  new_sandbox
  "test_${name}"
  if (( CURRENT_FAILS == 0 )); then
    printf '  %sPASS%s  %s\n' "$C_PASS" "$C_OFF" "$name"
    PASSED=$((PASSED + 1))
  else
    printf '  %sFAIL%s  %s (%d assertion(s))\n' "$C_FAIL" "$C_OFF" "$name" "$CURRENT_FAILS"
    FAILED_COUNT=$((FAILED_COUNT + 1))
    FAILED_NAMES+=("$name")
  fi
  rm -rf "$SANDBOX"
}

# ---------- cases ----------

test_scripts_are_syntactically_valid() {
  local f
  for f in common.sh plan.sh deploy.sh destroy.sh \
           test/run-tests.sh test/stub/pulumi; do
    if ! bash -n "$ACTION_DIR/$f" 2>/dev/null; then
      fail_assert "bash -n failed for $f"
    fi
  done
}

test_deploy_success() {
  run deploy.sh
  assert_status 0
  assert_file_contains "deploy.out" "STUB-UP-OUTPUT"
  assert_file_contains "$GH_SUMMARY" "| ok |"
}

test_deploy_failure_propagates() {
  STUB_FAIL_CMDS="up"
  run deploy.sh
  assert_status 1
  assert_out_contains "pulumi up failed"
  assert_file_contains "deploy.out" "simulated up failure"
}

test_deploy_falls_back_to_stack_init() {
  STUB_NO_STACK=1
  run deploy.sh
  assert_status 0
  assert_ran "stack init main"
  assert_ran "up --yes"
}

test_deploy_stops_when_stack_cannot_be_created() {
  STUB_NO_STACK=1
  STUB_FAIL_INIT=1
  run deploy.sh
  assert_status 1
  assert_never_ran "up --yes"
}

test_deploy_keeps_refresh_and_up_output() {
  UPDATE_STATE="true"
  run deploy.sh
  assert_status 0
  assert_file_contains "deploy.out" "STUB-REFRESH-OUTPUT"
  assert_file_contains "deploy.out" "STUB-UP-OUTPUT"
}

test_deploy_refresh_failure_skips_up() {
  UPDATE_STATE="true"
  STUB_FAIL_CMDS="refresh"
  run deploy.sh
  assert_status 1
  assert_never_ran "up --yes"
}

test_deploy_aggregates_across_workdirs() {
  workdirs dev stg prd
  STUB_FAIL_CMDS="up"
  STUB_FAIL_IN_DIR="stg"
  run deploy.sh
  assert_status 1
  assert_ran "dev"
  assert_ran "stg"
  assert_ran "prd"
  assert_file_contains "$GH_SUMMARY" '| `stg` | up | **FAILED**'
  assert_file_contains "$GH_SUMMARY" '| `dev` | up | ok |'
  assert_file_contains "$GH_SUMMARY" '| `prd` | up | ok |'
}

test_deploy_handles_nested_workdirs() {
  workdirs infra/foo infra/bar
  run deploy.sh
  assert_status 0
  assert_file_contains "infra/foo/deploy.out" "STUB-UP-OUTPUT"
  assert_file_contains "infra/bar/deploy.out" "STUB-UP-OUTPUT"
}

test_deploy_login_failure_aborts_early() {
  STUB_FAIL_CMDS="login"
  run deploy.sh
  assert_status 1
  assert_out_contains "pulumi login failed"
  assert_never_ran "stack select"
}

test_deploy_skips_missing_workdir_but_runs_the_rest() {
  workdirs dev
  WORKDIRS="dev nonexistent"
  run deploy.sh
  assert_status 0
  assert_out_contains "nonexistent is not a directory, skipping"
  assert_file_contains "$GH_SUMMARY" "skipped (not a directory)"
}

test_deploy_fails_when_no_workdir_is_usable() {
  WORKDIRS="nope1 nope2"
  run deploy.sh
  assert_status 1
  assert_out_contains "no valid workdirs"
}

test_plan_success() {
  run plan.sh
  assert_status 0
  assert_file_contains "plan.out" "aws:s3:Bucket example create"
  assert_file_contains "drift.out" "IN-SYNC"
  assert_file_contains "$OUTPUTS_FILE" "drift-status=IN-SYNC"
}

test_plan_failure_propagates() {
  STUB_FAIL_CMDS="preview"
  run plan.sh
  assert_status 1
  assert_out_contains "pulumi preview failed"
  assert_file_contains "plan.out" "simulated preview failure"
  assert_first_line "plan.out" "Plan failed!"
}

test_plan_missing_preamble_marker_does_not_break_sed() {
  STUB_PREVIEW_MARKER="none"
  run plan.sh
  assert_status 0
  assert_out_lacks "sed:"
  assert_out_lacks "1,-1"
  assert_file_contains "plan.out" "aws:s3:Bucket example create"
}

test_plan_trims_preamble_above_marker() {
  run plan.sh
  assert_status 0
  assert_first_line "plan.out" "Pulumi used the selected providers"
  assert_file_lacks "plan.out" "STUB-PREVIEW-PREAMBLE"
}

test_plan_word_error_in_output_is_not_a_failure() {
  STUB_PREVIEW_EXTRA="+ aws:lambda:Function error-handler create"
  run plan.sh
  assert_status 0
  assert_file_lacks "plan.out" "Plan failed!"
}

test_plan_drift_detected_sets_output() {
  DRIFT_CHECK="true"
  STUB_DRIFT=1
  run plan.sh
  assert_status 0
  assert_file_contains "drift.out" "DRIFTED"
  assert_file_contains "$OUTPUTS_FILE" "drift-status=DRIFTED"
}

test_plan_drift_check_refresh_failure_propagates() {
  DRIFT_CHECK="true"
  STUB_FAIL_CMDS="refresh"
  run plan.sh
  assert_status 1
  assert_out_contains "pulumi refresh failed"
  assert_never_ran "preview"
}

test_plan_drift_status_aggregates_to_drifted() {
  workdirs dev stg
  DRIFT_CHECK="true"
  STUB_DRIFT=1
  STUB_DRIFT_IN_DIR="stg"
  run plan.sh
  assert_status 0
  assert_file_contains "dev/drift.out" "IN-SYNC"
  assert_file_contains "stg/drift.out" "DRIFTED"
  assert_file_contains "$OUTPUTS_FILE" "drift-status=DRIFTED"
}

test_plan_aggregates_across_workdirs() {
  workdirs dev stg prd
  STUB_FAIL_CMDS="preview"
  STUB_FAIL_IN_DIR="stg"
  run plan.sh
  assert_status 1
  assert_file_contains "$GH_SUMMARY" '| `stg` | plan | **FAILED**'
  assert_file_contains "$GH_SUMMARY" '| `dev` | plan | ok |'
  assert_file_contains "$GH_SUMMARY" '| `prd` | plan | ok |'
}

test_destroy_success() {
  run destroy.sh
  assert_status 0
  assert_file_contains "destroy.out" "STUB-DESTROY-OUTPUT"
}

test_destroy_failure_propagates() {
  STUB_FAIL_CMDS="destroy"
  run destroy.sh
  assert_status 1
  assert_out_contains "pulumi destroy failed"
  assert_file_contains "destroy.out" "simulated destroy failure"
}

test_outputs_status_success() {
  run deploy.sh
  assert_status 0
  assert_file_has_line "$OUTPUTS_FILE" "status=success"
  assert_file_has_line "$OUTPUTS_FILE" "failed-workdirs="
}

test_outputs_status_failure() {
  STUB_FAIL_CMDS="up"
  run deploy.sh
  assert_status 1
  assert_file_has_line "$OUTPUTS_FILE" "status=failure"
}

test_outputs_lists_absolute_output_files() {
  workdirs dev stg
  run deploy.sh
  assert_status 0
  assert_output_files 2 "$SANDBOX/dev/deploy.out" "$SANDBOX/stg/deploy.out"
}

test_outputs_lists_the_file_of_a_failed_workdir() {
  workdirs dev stg
  STUB_FAIL_CMDS="up"
  STUB_FAIL_IN_DIR="stg"
  run deploy.sh
  assert_status 1
  # stg failed but still produced a log, so a follow-up step can read the error.
  assert_output_files 2 "$SANDBOX/dev/deploy.out" "$SANDBOX/stg/deploy.out"
}

test_outputs_names_only_failed_workdirs() {
  workdirs dev stg prd
  STUB_FAIL_CMDS="up"
  STUB_FAIL_IN_DIR="stg"
  run deploy.sh
  assert_status 1
  assert_file_has_line "$OUTPUTS_FILE" "failed-workdirs=stg"
}

test_outputs_skipped_workdir_is_not_listed() {
  workdirs dev
  WORKDIRS="dev nonexistent"
  run deploy.sh
  assert_status 0
  assert_output_files 1 "$SANDBOX/dev/deploy.out"
  assert_file_has_line "$OUTPUTS_FILE" "failed-workdirs="
}

test_outputs_written_when_login_fails() {
  STUB_FAIL_CMDS="login"
  run deploy.sh
  assert_status 1
  assert_file_has_line "$OUTPUTS_FILE" "status=failure"
  assert_output_files 0
}

test_outputs_empty_file_list_is_well_formed() {
  WORKDIRS="nope1 nope2"
  run deploy.sh
  assert_status 1
  assert_file_has_line "$OUTPUTS_FILE" "status=failure"
  assert_output_files 0
}

test_outputs_single_workdir_path_is_not_dot_prefixed() {
  run plan.sh
  assert_status 0
  assert_output_files 1 "$SANDBOX/plan.out"
  assert_file_lacks "$OUTPUTS_FILE" "/./"
}

test_outputs_nested_workdir_paths_are_resolved() {
  workdirs infra/foo infra/bar
  run plan.sh
  assert_status 0
  assert_output_files 2 "$SANDBOX/infra/foo/plan.out" "$SANDBOX/infra/bar/plan.out"
}

test_outputs_are_not_written_to_github_output_directly() {
  # The action's collector step owns $GITHUB_OUTPUT; the scripts only write
  # $OUTPUTS_FILE, so that outputs survive a failing step.
  DRIFT_CHECK="true"
  STUB_DRIFT=1
  run plan.sh
  assert_status 0
  assert_file_lacks "$GH_OUTPUT" "drift-status"
  assert_file_has_line "$OUTPUTS_FILE" "drift-status=DRIFTED"
}

# ---------- driver ----------

TESTS=(
  scripts_are_syntactically_valid

  deploy_success
  deploy_failure_propagates
  deploy_falls_back_to_stack_init
  deploy_stops_when_stack_cannot_be_created
  deploy_keeps_refresh_and_up_output
  deploy_refresh_failure_skips_up
  deploy_aggregates_across_workdirs
  deploy_handles_nested_workdirs
  deploy_login_failure_aborts_early
  deploy_skips_missing_workdir_but_runs_the_rest
  deploy_fails_when_no_workdir_is_usable

  plan_success
  plan_failure_propagates
  plan_missing_preamble_marker_does_not_break_sed
  plan_trims_preamble_above_marker
  plan_word_error_in_output_is_not_a_failure
  plan_drift_detected_sets_output
  plan_drift_check_refresh_failure_propagates
  plan_drift_status_aggregates_to_drifted
  plan_aggregates_across_workdirs

  destroy_success
  destroy_failure_propagates

  outputs_status_success
  outputs_status_failure
  outputs_lists_absolute_output_files
  outputs_lists_the_file_of_a_failed_workdir
  outputs_names_only_failed_workdirs
  outputs_skipped_workdir_is_not_listed
  outputs_written_when_login_fails
  outputs_empty_file_list_is_well_formed
  outputs_single_workdir_path_is_not_dot_prefixed
  outputs_nested_workdir_paths_are_resolved
  outputs_are_not_written_to_github_output_directly
)

printf 'Running pulumi-cli script tests\n\n'
for t in "${TESTS[@]}"; do
  run_test "$t"
done

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED_COUNT"
if (( FAILED_COUNT > 0 )); then
  printf 'failed: %s\n' "${FAILED_NAMES[*]}"
  exit 1
fi
exit 0
