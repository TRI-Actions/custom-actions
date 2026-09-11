#!/usr/bin/env bash
#
# 'pulumi destroy' in every workdir in $WORKDIRS, output teed to ./destroy.out.
#
# Env:
#   WORKDIRS  space-separated relative paths (default '.')

# pipefail: pulumi is piped into tee, which would otherwise mask its exit status.
# '-e' is omitted so the workdir loop survives one failing workdir.
set -uo pipefail

export CI=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

readonly OUT_FILE="destroy.out"

# Deliberately does not select a stack, matching prior behaviour: destroy relies
# on whichever stack the backend already has selected.
destroy_one() {
  local dir="$1"

  if ! pulumi destroy --yes --non-interactive --color=never 2>&1 | tee "$OUT_FILE"; then
    err "pulumi destroy failed for ${dir}; see ${dir}/${OUT_FILE}"
    record_failure "$dir" "pulumi destroy failed - $(error_line "$OUT_FILE")"
    return 1
  fi

  return 0
}

main() {
  pulumi_login
  for_each_workdir destroy destroy_one
  emit_summary destroy
  finish
}

main "$@"
