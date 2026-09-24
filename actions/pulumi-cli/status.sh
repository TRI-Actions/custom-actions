#!/usr/bin/env bash
#
# Compares the Pulumi projects in the repository with the state backend (preview).
#
# Env:
#   WORKDIRS     space-separated relative paths to search for projects (default '.': the whole repo)

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

main() {
  # Registered before anything can fail, so the output is present even if we exit
  # during login. Refined by set_drift_status_output once the plans have run.
#   add_output drift-status UNKNOWN

  pulumi_login
  # We get the active projects in state
#   python3 "$SCRIPT_DIR/pulumi_cli.py" list-projects
#   python3 "$SCRIPT_DIR/pulumi_cli.py" list-stacks
  python3 "$SCRIPT_DIR/status.py"
  

  # 

  # We start by classifying the workdirs into existin and missing
#   find_missing_workdirs

#   #  Stack LS 
# #   run_stack_ls
#   check_existing_workdirs

#   create_scratch_missing_workdirs
#   echo "Missing workdirs: $MISSING_WORKDIRS"
#   echo "Created scratch workdirs: ${TEMP_MISSING_WORKDIRS[*]}"
#   check_missing_workdir_status
# #   for_each_workdir plan plan_one
# #   set_drift_status_output
# #   emit_summary plan
  finish
}

main "$@"
