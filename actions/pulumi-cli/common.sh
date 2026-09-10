#!/usr/bin/env bash
#
# Shared helpers for the pulumi-cli action scripts. Sourced, not executed.
# Each script sets its own shell options before sourcing this.

readonly PULUMI_STATE_BUCKET="tri-pulumi-state-us-east-1"

FAILED=0
RESULT_ROWS=()
OUTPUT_FILES=()
FAILED_WORKDIRS=()
EXTRA_OUTPUTS=()

log() { echo "==> $*"; }
err() { echo "!! $*" >&2; }

pulumi_login() {
  local repo_name backend
  repo_name="$(printf '%s' "${GITHUB_REPOSITORY:-}" | cut -d'/' -f2)"
  if [[ -z "$repo_name" ]]; then
    err "GITHUB_REPOSITORY is unset or malformed; cannot derive the state backend path"
    FAILED=1
    finish
  fi
  backend="s3://${PULUMI_STATE_BUCKET}/${repo_name}"
  log "logging in to ${backend}"
  if ! pulumi login "$backend"; then
    err "pulumi login failed for ${backend}"
    FAILED=1
    finish
  fi
}

select_or_init_stack() {
  local stack="${1:-main}"
  if pulumi stack select "$stack"; then
    return 0
  fi
  log "stack '${stack}' not found; initialising it"
  if pulumi stack init "$stack"; then
    return 0
  fi
  err "could not select or create stack '${stack}'"
  return 1
}

# for_each_workdir <operation> <fn>
# Runs <fn> once per workdir in $WORKDIRS with cwd already set to it. A failing
# workdir does not stop the others; the run fails at the end via finish().
for_each_workdir() {
  local operation="$1" fn="$2"
  local d status attempted=0

  # Unquoted: WORKDIRS is a space-separated list.
  for d in ${WORKDIRS:-}; do
    if [[ ! -d "$d" ]]; then
      log "$d is not a directory, skipping.."
      RESULT_ROWS+=("| \`${d}\` | ${operation} | skipped (not a directory) |")
      continue
    fi

    attempted=1
    log "running ${operation} for ${d}"
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
    fi
  done

  if (( attempted == 0 )); then
    err "no valid workdirs to ${operation}; WORKDIRS='${WORKDIRS:-}'"
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

# Queues an extra key for emit_outputs, so callers can contribute their own
# outputs without common.sh knowing about them.
add_output() {
  EXTRA_OUTPUTS+=("$1=$2")
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
    printf 'output-files<<EOF\n'
    # Guarded: under 'set -u' an empty array would emit a stray blank line.
    if (( ${#OUTPUT_FILES[@]} > 0 )); then
      printf '%s\n' "${OUTPUT_FILES[@]}"
    fi
    printf 'EOF\n'
    if (( ${#EXTRA_OUTPUTS[@]} > 0 )); then
      printf '%s\n' "${EXTRA_OUTPUTS[@]}"
    fi
  } > "$outputs_file" || err "failed to write ${outputs_file} (non-fatal)"
}

finish() {
  emit_outputs
  if (( FAILED != 0 )); then
    err "one or more workdirs failed"
    exit 1
  fi
  log "Done!"
  exit 0
}
