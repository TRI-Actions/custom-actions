#!/usr/bin/env bash
#
# 'pulumi up' in every workdir in $WORKDIRS, output teed to ./deploy.out.
#
# Env:
#   WORKDIRS      space-separated relative paths (default '.')
#   UPDATE_STATE  'true' to run 'pulumi refresh' before 'pulumi up'

# pipefail: pulumi is piped into tee, which would otherwise mask its exit status.
# '-e' is omitted so the workdir loop survives one failing workdir.
set -uo pipefail

export CI=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly OUT_FILE="deploy.out"

deploy_one() {
  local dir="$1"
  local options=(--yes --non-interactive --color=never)

  # Truncated once here so refresh and up can both append below.
  if ! : > "$OUT_FILE"; then
    err "cannot write ${dir}/${OUT_FILE}"
    return 1
  fi

  select_or_init_stack main || return 1

  if [[ "${UPDATE_STATE:-}" == "true" ]]; then
    log "updating state for ${dir}"
    if ! pulumi refresh "${options[@]}" 2>&1 | tee -a "$OUT_FILE"; then
      err "pulumi refresh failed for ${dir}; not running 'pulumi up'"
      return 1
    fi
  fi

  if ! pulumi up "${options[@]}" 2>&1 | tee -a "$OUT_FILE"; then
    err "pulumi up failed for ${dir}; see ${dir}/${OUT_FILE}"
    return 1
  fi

  return 0
}

main() {
  pulumi_login
  for_each_workdir up deploy_one
  emit_summary up
  finish
}

main "$@"
