#!/usr/bin/env bash
#
# Compares the Pulumi projects in the repository with the state backend (preview).
# The comparison itself is done by status.py; this script owns login and outputs.
#
# Env:
#   WORKDIRS     space-separated relative paths to search for projects (default '.': the whole repo)

# '-e' is omitted so a failing status.py still reaches finish().
set -uo pipefail

export CI=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

# Acts on status.py's records (see its docstring), read from stdin.
consume_records() {
  local kind key value
  while IFS=$'\t' read -r kind key value; do
    case "$kind" in
      "") ;;
      output) add_output "$key" "$value" ;;
      error)
        record_failure "$key" "$value"
        FAILED=1
        ;;
      *) err "ignoring unknown status.py record '${kind}'" ;;
    esac
  done
}

main() {
  pulumi_login

  local records status reasons_before
  reasons_before="$(reasons_count)"
  log "comparing repository projects with the backend"
  # Captured whole, not piped, so status.py's exit code survives.
  records="$(python3 "$SCRIPT_DIR/status.py")"
  status=$?
  consume_records <<< "$records"

  if (( status != 0 )); then
    FAILED=1
    # Backstop for a crash, which prints a traceback but no 'error' record.
    if (( $(reasons_count) == reasons_before )); then
      record_failure status "status.py failed (exit ${status}); see the step log"
    fi
  fi

  finish
}

main "$@"
