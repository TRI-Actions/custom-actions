#!/usr/bin/env bash
#
# Shared helpers for the pulumi-cli action scripts. Sourced, not executed.
# Each script sets its own shell options before sourcing this.

readonly PULUMI_STATE_BUCKET="tri-pulumi-state-us-east-1"

# Delimiter for the multi-line $GITHUB_OUTPUT values. Namespaced rather than a bare
# 'EOF' because 'error-message' carries text from pulumi: a value line equal to the
# delimiter would truncate the value and let the rest be read as more output keys.
readonly OUTPUT_DELIMITER="PULUMI_CLI_EOF"

# Most causes reported per failing workdir. Pulumi lists one per failing resource, and
# 'error-message' is a job output rather than a log, so past a point the extra lines stop
# being a summary. The remainder stay in the log file that 'output-files' points at.
readonly MAX_CAUSES=10

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

# The informative lines of a pulumi log, one per line, most specific first.
#
# Pulumi reports a failure as a generic wrapper line - 'error: Preview failed: 3 errors
# occurred:', or a trailing 'error: update failed' - with the real causes below it, one
# indented bullet each. Quoting the wrapper says only what 'status' already said, and
# quoting one bullet understates a stack that broke in several places, so wrappers are
# skipped and every cause is reported. In preference order:
#   1. every non-wrapper error line, and every bullet belonging to a wrapper's list.
#      Bullets count whatever their wording, which catches causes that do not start
#      with 'error' ('* AccessDenied: User ... is not authorized to perform: sts:...').
#   2. the first line under a wrapper, for a wrapper that bullets nothing
#   3. the wrapper itself, then the last non-blank line
#
# A line ending in ':' opens a bulleted list, and bullets belong to whichever list
# opened last. That is what separates causes from advice: the AssumeRole failure - the
# most common one there is - follows its real cause with pulumi's canned
#   There are a number of possible causes of this - the most common are:
#     * The credentials used in order to assume the role are invalid
#     * ...
# whose bullets are suggestions, not causes. Only ending in ':' opens a list, so a
# cause that merely wraps onto a second line ('status code: 403, request id: ...')
# leaves the wrapper's list open and any later cause is still collected.
#
# Causes are attributed to the resource whose diagnostics block they appear in, except
# for the 'pulumi:pulumi:Stack' pseudo-resource, which names nothing useful.
# Indentation and bullets are trimmed, because each line is quoted inline in a reason.
error_lines() {
  awk -v max="$MAX_CAUSES" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      # Also drops a trailing CR, so a log with CRLF endings does not keep it.
      sub(/[[:space:]]+$/, "", line)
      if (line == "") next
      last = line

      # Only "*", never "-" or "+": those two lead every line of a pulumi diff, so
      # treating them as bullets would report deleted resources as failure causes.
      bullet = 0
      if (line ~ /^\*[[:space:]]+/) {
        bullet = 1
        sub(/^\*[[:space:]]+/, "", line)
        if (line == "") next
      }

      # Matches "error:" and "Error:", and also "error configuring ...", which is how
      # the bridged providers word their own causes.
      is_error = (line ~ /^[Ee]rror[: ]/)

      lower = tolower(line)
      if (is_error && (lower ~ /^error:[[:space:]]*$/ ||
                       lower ~ /^error:[[:space:]]+[0-9]+[[:space:]]+errors?[[:space:]]+occurred/ ||
                       lower ~ /^error:[[:space:]]+(preview|update|refresh|destroy|import) failed/)) {
        if (wrapper == "") wrapper = line
        seen_wrapper = 1
        list = "cause"
        next
      }

      if (!bullet) {
        # A "<type> (<name>):" line heads the diagnostics for one resource.
        if (line ~ /^[A-Za-z][A-Za-z0-9_.:\/-]*[[:space:]]+\(.*\):$/) {
          if (line ~ /^pulumi:pulumi:Stack[[:space:]]/) {
            resource = ""
          } else {
            resource = line
            sub(/:$/, "", resource)
          }
          next
        }
        # Any other prose ending in ":" opens a list of its own, so its bullets stop
        # counting as causes of the wrapper above.
        if (!is_error && line ~ /:$/) {
          list = "other"
          next
        }
      }

      if (is_error || (bullet && list == "cause")) {
        n++
        if (n <= max) { cause[n] = line; res[n] = resource }
        next
      }

      if (seen_wrapper && after == "") after = line
    }
    END {
      if (n > 0) {
        for (i = 1; i <= n && i <= max; i++) {
          if (res[i] != "") printf "%s - %s\n", res[i], cause[i]
          else             print cause[i]
        }
        if (n > max) printf "... and %d more (see the log)\n", n - max
      }
      else if (after != "")   print after
      else if (wrapper != "") print wrapper
      else if (last != "")    print last
    }
  ' "$1" 2>/dev/null
}

# record_failures <context> <summary> <log_file>
# Adds one 'error-message' line per cause in <log_file>, each carrying the context and
# the same summary. Repeating the prefix rather than indenting under it keeps every line
# independently filterable, which is the point of the output.
record_failures() {
  local context="$1" summary="$2" file="$3" cause found=0
  while IFS= read -r cause; do
    [[ -n "$cause" ]] || continue
    record_failure "$context" "${summary} - ${cause}"
    found=1
  done < <(error_lines "$file")
  # An empty or unreadable log still has to produce a reason.
  (( found )) || record_failure "$context" "$summary"
}

# As record_failures, for the output of the last capture() call.
record_captured_failures() {
  record_failures "$1" "$2" <(printf '%s\n' "$CAPTURED")
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
    record_captured_failures login "pulumi login failed for ${backend}"
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
  record_captured_failures "${CURRENT_WORKDIR:-unknown}" \
    "could not select or create stack '${stack}'"
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
