#!/usr/bin/env bash
#
# 'pulumi preview' in every workdir in $WORKDIRS, plan teed to ./plan.out and the
# drift verdict written to ./drift.out.
#
# Env:
#   WORKDIRS     space-separated relative paths (default '.')
#   DRIFT_CHECK  'true' to refresh first and report drift

# pipefail: pulumi is piped into tee, which would otherwise mask its exit status.
# '-e' is omitted so the workdir loop survives one failing workdir.
set -uo pipefail

export CI=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly OUT_FILE="plan.out"
readonly DRIFT_FILE="drift.out"

# Pulumi prints this once past provider setup; everything above it is preamble.
readonly PREAMBLE_MARKER='Pulumi used the selected providers'
# Pulumi prints this when a refresh found resources changed outside of Pulumi.
readonly DRIFT_MARKER='Note: Objects have changed'

# Line number of the first plan.out line matching <pattern>, empty if absent.
find_marker() {
  awk -v pat="$1" '$0 ~ pat { print NR; exit }' "$OUT_FILE"
}

# Drops everything above <line_number> from plan.out. A blank or non-numeric
# argument is a no-op, which is what happens when the marker is absent.
# Avoids 'sed -i': the in-place suffix argument differs between GNU and BSD sed.
strip_preamble() {
  local index="$1"
  [[ "$index" =~ ^[0-9]+$ ]] || return 0
  (( index > 1 )) || return 0

  local tmp="${OUT_FILE}.tmp"
  if sed "1,$((index - 1))d" "$OUT_FILE" > "$tmp"; then
    mv "$tmp" "$OUT_FILE"
  else
    rm -f "$tmp"
    err "failed to trim the preamble from ${OUT_FILE} (non-fatal)"
  fi
}

mark_plan_failed() {
  local tmp="${OUT_FILE}.tmp"
  { printf 'Plan failed!\n'; cat "$OUT_FILE" 2>/dev/null; } > "$tmp" \
    && mv "$tmp" "$OUT_FILE" \
    || rm -f "$tmp"
}

plan_one() {
  local dir="$1"
  local drift_check="${DRIFT_CHECK:-}"
  local drift_line=""

  select_or_init_stack main || return 1

  if [[ "$drift_check" == "true" ]]; then
    # Teed into OUT_FILE so a refresh failure still leaves a log to read. On success
    # the preview below overwrites it, which is what we want in the plan output.
    if ! pulumi refresh --yes 2>&1 | tee "$OUT_FILE"; then
      err "pulumi refresh failed for ${dir}"
      record_failures "$dir" "pulumi refresh failed" "$OUT_FILE"
      return 1
    fi
  fi

  if ! pulumi preview --color=never --diff --non-interactive 2>&1 | tee "$OUT_FILE"; then
    err "pulumi preview failed for ${dir}; see ${dir}/${OUT_FILE}"
    record_failures "$dir" "pulumi preview failed" "$OUT_FILE"
    mark_plan_failed
    return 1
  fi

  # Only meaningful after a refresh; without one there is nothing for Pulumi to
  # have detected changing outside of its own state.
  if [[ "$drift_check" == "true" ]]; then
    drift_line="$(find_marker "$DRIFT_MARKER")"
  fi

  if [[ -n "$drift_line" ]]; then
    log "drift detected in ${dir}"
    printf 'DRIFTED\n' > "$DRIFT_FILE"
    strip_preamble "$drift_line"
  else
    if [[ "$drift_check" == "true" ]]; then
      log "no drift detected in ${dir}"
    fi
    printf 'IN-SYNC\n' > "$DRIFT_FILE"
    strip_preamble "$(find_marker "$PREAMBLE_MARKER")"
  fi

  return 0
}

# Read back from each drift.out rather than a variable, because plan_one runs in
# a subshell and cannot mutate this shell.
set_drift_status_output() {
  local status="IN-SYNC" undetermined=0 d

  for d in ${WORKDIRS:-}; do
    [[ -d "$d" ]] || continue
    if [[ -f "${d}/${DRIFT_FILE}" ]]; then
      if grep -qxF 'DRIFTED' "${d}/${DRIFT_FILE}"; then
        status="DRIFTED"
        break
      fi
    else
      # Attempted but never got far enough to reach a verdict.
      undetermined=1
    fi
  done

  # DRIFTED is a positive finding, so it stands even if another workdir failed.
  # Short of that, a workdir we could not inspect leaves us no basis to claim
  # IN-SYNC, so say so rather than implying a clean bill of health.
  if [[ "$status" != "DRIFTED" ]] && (( undetermined != 0 || FAILED != 0 )); then
    status="UNKNOWN"
  fi

  log "drift-status=${status}"
  add_output drift-status "$status"
}

main() {
  # Registered before anything can fail, so the output is present even if we exit
  # during login. Refined by set_drift_status_output once the plans have run.
  add_output drift-status UNKNOWN

  pulumi_login
  for_each_workdir plan plan_one
  set_drift_status_output
  emit_summary plan
  finish
}

main "$@"
