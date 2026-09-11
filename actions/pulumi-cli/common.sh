#!/usr/bin/env bash
#
# Shared helpers for the pulumi-cli action scripts. Sourced, not executed.
# Each script sets its own shell options before sourcing this.

readonly PULUMI_STATE_BUCKET="tri-pulumi-state-us-east-1"

# Delimiter for the multi-line $GITHUB_OUTPUT values. Namespaced rather than a bare
# 'EOF' because 'error-message' carries text from pulumi: a value line equal to the
# delimiter would truncate the value and let the rest be read as more output keys.
readonly OUTPUT_DELIMITER="PULUMI_CLI_EOF"

FAILED=0
RESULT_ROWS=()
OUTPUT_FILES=()
FAILED_WORKDIRS=()
EXTRA_OUTPUTS=()

# Workdir currently being processed, readable from inside the subshell that runs it.
CURRENT_WORKDIR=""

# Output of the last capture() call.
CAPTURED=""

# Failure reasons accumulate in a file rather than an array, because the per-workdir
# functions run in a subshell and cannot mutate this shell's variables.
REASONS_FILE="$(mktemp "${TMPDIR:-/tmp}/pulumi-cli-reasons.XXXXXX" 2>/dev/null)" || REASONS_FILE=""

log() { echo "==> $*"; }
err() { echo "!! $*" >&2; }

# record_failure <context> <detail>
# Adds one line to the 'error-message' output. Call it wherever a run is failed, so
# the caller learns why without having to read the step log.
record_failure() {
  [[ -n "$REASONS_FILE" ]] || return 0
  printf '%s: %s\n' "$1" "$2" >> "$REASONS_FILE" 2>/dev/null || true
}

# The most informative single line of a pulumi log: its 'error:' line if there is
# one, otherwise the last non-blank line.
error_line() {
  grep -m1 -E '^[[:space:]]*error:' "$1" 2>/dev/null && return 0
  grep -v '^[[:space:]]*$' "$1" 2>/dev/null | tail -n 1
}

captured_error_line() {
  error_line <(printf '%s\n' "$CAPTURED")
}

reasons_count() {
  if [[ -n "$REASONS_FILE" && -f "$REASONS_FILE" ]]; then
    wc -l < "$REASONS_FILE" | tr -d ' '
  else
    printf '0'
  fi
}

# Runs a short command with its output captured into $CAPTURED, so a failure reason
# can quote it, while still echoing it into the step log. Not for long-running
# commands: nothing appears until the command has finished.
capture() {
  local status
  CAPTURED="$("$@" 2>&1)"
  status=$?
  [[ -n "$CAPTURED" ]] && printf '%s\n' "$CAPTURED"
  return "$status"
}

pulumi_login() {
  local repo_name backend
  repo_name="$(printf '%s' "${GITHUB_REPOSITORY:-}" | cut -d'/' -f2)"
  if [[ -z "$repo_name" ]]; then
    err "GITHUB_REPOSITORY is unset or malformed; cannot derive the state backend path"
    record_failure login "GITHUB_REPOSITORY is unset or malformed ('${GITHUB_REPOSITORY:-}'); cannot derive the state backend path"
    FAILED=1
    finish
  fi
  backend="s3://${PULUMI_STATE_BUCKET}/${repo_name}"
  log "logging in to ${backend}"
  # Captured rather than streamed: this is where a missing or unassumable AWS role
  # surfaces, and the reason has to reach the caller as an output.
  if ! capture pulumi login "$backend"; then
    err "pulumi login failed for ${backend}"
    record_failure login "pulumi login failed for ${backend} - $(captured_error_line)"
    FAILED=1
    finish
  fi
}

# Writes the failure into $OUT_FILE as well as the reasons file, so that a workdir
# which never reached the pulumi operation still produces a log to read.
select_or_init_stack() {
  local stack="${1:-main}"
  if capture pulumi stack select "$stack"; then
    return 0
  fi
  log "stack '${stack}' not found; initialising it"
  if capture pulumi stack init "$stack"; then
    return 0
  fi
  err "could not select or create stack '${stack}'"
  printf '%s\n' "$CAPTURED" > "$OUT_FILE" 2>/dev/null || true
  record_failure "${CURRENT_WORKDIR:-unknown}" \
    "could not select or create stack '${stack}' - $(captured_error_line)"
  return 1
}

# for_each_workdir <operation> <fn>
# Runs <fn> once per workdir in $WORKDIRS with cwd already set to it. A failing
# workdir does not stop the others; the run fails at the end via finish().
for_each_workdir() {
  local operation="$1" fn="$2"
  local d status attempted=0 reasons_before

  # Unquoted: WORKDIRS is a space-separated list.
  for d in ${WORKDIRS:-}; do
    if [[ ! -d "$d" ]]; then
      log "$d is not a directory, skipping.."
      RESULT_ROWS+=("| \`${d}\` | ${operation} | skipped (not a directory) |")
      continue
    fi

    attempted=1
    log "running ${operation} for ${d}"
    CURRENT_WORKDIR="$d"
    reasons_before="$(reasons_count)"
    # Subshell so a failed cd or a nested path cannot leak cwd into the next
    # iteration.
    ( cd "$d" && "$fn" "$d" )
    status=$?

    # Absolute, so a later step running from a different cwd can still read it.
    if [[ -f "${d}/${OUT_FILE}" ]]; then
      OUTPUT_FILES+=("$(cd "$d" && pwd)/${OUT_FILE}")
    fi

    if (( status == 0 )); then
      RESULT_ROWS+=("| \`${d}\` | ${operation} | ok |")
    else
      err "${operation} failed for ${d} (exit ${status})"
      RESULT_ROWS+=("| \`${d}\` | ${operation} | **FAILED** (exit ${status}) |")
      FAILED_WORKDIRS+=("$d")
      FAILED=1
      # Backstop, so every failing workdir is named in 'error-message' even if the
      # operation returned non-zero without recording a reason of its own.
      if (( $(reasons_count) == reasons_before )); then
        record_failure "$d" "${operation} failed (exit ${status})"
      fi
    fi
  done
  CURRENT_WORKDIR=""

  if (( attempted == 0 )); then
    err "no valid workdirs to ${operation}; WORKDIRS='${WORKDIRS:-}'"
    record_failure workdirs \
      "no entry in WORKDIRS='${WORKDIRS:-}' is an existing directory; nothing to ${operation}"
    FAILED=1
  fi
}

emit_summary() {
  local operation="$1"
  local summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"
  {
    printf '## Pulumi %s\n\n' "$operation"
    printf '| Workdir | Operation | Status |\n'
    printf '|---|---|---|\n'
    if (( ${#RESULT_ROWS[@]} == 0 )); then
      printf '| _no workdirs_ | %s | |\n' "$operation"
    else
      local row
      for row in "${RESULT_ROWS[@]}"; do printf '%s\n' "$row"; done
    fi
    printf '\n'
  } >> "$summary_file" 2>/dev/null || true
}

# Queues an extra key for emit_outputs, so callers can contribute their own outputs
# without common.sh knowing about them. Setting the same key twice replaces it, which
# lets a caller register a safe default up front and refine it once it knows better.
add_output() {
  local key="$1" value="$2" i
  for (( i = 0; i < ${#EXTRA_OUTPUTS[@]}; i++ )); do
    if [[ "${EXTRA_OUTPUTS[i]}" == "${key}="* ]]; then
      EXTRA_OUTPUTS[i]="${key}=${value}"
      return 0
    fi
  done
  EXTRA_OUTPUTS+=("${key}=${value}")
}

# Writes every output in $GITHUB_OUTPUT syntax to $OUTPUTS_FILE, which the action's
# collector step appends to $GITHUB_OUTPUT. A no-op when OUTPUTS_FILE is unset, so
# the scripts stay runnable outside of Actions.
emit_outputs() {
  local outputs_file="${OUTPUTS_FILE:-}"
  [[ -n "$outputs_file" ]] || return 0

  {
    if (( FAILED == 0 )); then
      printf 'status=success\n'
    else
      printf 'status=failure\n'
    fi
    printf 'failed-workdirs=%s\n' "${FAILED_WORKDIRS[*]:-}"
    printf 'output-files<<%s\n' "$OUTPUT_DELIMITER"
    # Guarded: under 'set -u' an empty array would emit a stray blank line.
    if (( ${#OUTPUT_FILES[@]} > 0 )); then
      printf '%s\n' "${OUTPUT_FILES[@]}"
    fi
    printf '%s\n' "$OUTPUT_DELIMITER"
    printf 'error-message<<%s\n' "$OUTPUT_DELIMITER"
    if [[ -n "$REASONS_FILE" && -s "$REASONS_FILE" ]]; then
      cat "$REASONS_FILE"
    elif (( FAILED != 0 )); then
      # Should not happen: every failure path records a reason. Better than silence.
      printf 'failed for an unrecorded reason; see the step log\n'
    fi
    printf '%s\n' "$OUTPUT_DELIMITER"
    if (( ${#EXTRA_OUTPUTS[@]} > 0 )); then
      printf '%s\n' "${EXTRA_OUTPUTS[@]}"
    fi
  } > "$outputs_file" || err "failed to write ${outputs_file} (non-fatal)"
}

finish() {
  emit_outputs

  # Echoed so the reasons are visible in the step log too, not only in the output.
  if [[ -n "$REASONS_FILE" && -s "$REASONS_FILE" ]]; then
    err "failure details:"
    while IFS= read -r reason; do err "  ${reason}"; done < "$REASONS_FILE"
  fi
  [[ -n "$REASONS_FILE" ]] && rm -f "$REASONS_FILE"

  if (( FAILED != 0 )); then
    err "one or more workdirs failed"
    exit 1
  fi
  log "Done!"
  exit 0
}
