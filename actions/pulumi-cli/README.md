# Pulumi CLI Custom Action

This action provides a wrapper around the Pulumi CLI to make its use easier within other GitHub Actions workflows.

It supports plan, deploy and destroy options. With `drift_check` enabled, the plan option also reports the drift status of deployed resources via the `drift-status` output, leaving it to the calling workflow to decide whether to proceed.

A `status` option, which compares the projects in your repository against the state backend, is in preview. See [`status` (preview)](#status-preview).

## Parameters

There are two parameters required to use this action:

* `action`: The action you want to take. (Supported options are: `plan`, `deploy`, `destroy` and, in preview, `status`)
* `workdirs`: Relative paths of Pulumi stack directories you want to work with. Default value is `.` meaning that it will use the root of your repository. You can pass multiple directories with a space in between them.
* `drift_check`: Whether drift check will run or not. Default value is `false`
* `update_state`: Option to update only state to match the infrastructure. Default value is `false`

## Failure behaviour

Any Pulumi error fails the step. If you pass several workdirs, all of them are still
attempted - one failing stack does not stop the rest - and the step fails at the end
with a table in the job summary showing which workdirs succeeded and which did not.

The `*.out` files are still written for failed runs, so you can upload them as artifacts
or post them to a PR comment regardless of the outcome.

A `workdirs` value where no entry is an existing directory fails the step, rather than
silently doing nothing.

## Outputs

Each action writes a log file into every workdir it ran in: `plan.out` for `plan`,
`deploy.out` for `deploy`, `destroy.out` for `destroy`. (The workdir is the root of your
repository if you did not pass one.) With `drift_check` enabled, `plan` also writes a
`drift.out` per workdir holding that workdir's individual verdict.

Whichever action ran, these outputs are set in the Actions context:

| Output | Value |
|---|---|
| `status` | `success` if every workdir succeeded, otherwise `failure`. |
| `output-files` | Newline-separated absolute paths of the log files, one per workdir that produced one. Includes failed workdirs, so you can read the error. |
| `failed-workdirs` | Space-separated workdirs that failed, in the same format as the `workdirs` input. Empty on success. |
| `error-message` | Why the run failed, one line per cause. Empty on success. |
| `drift-status` | `DRIFTED`, `IN-SYNC` or `UNKNOWN`. Only set by the `plan` action. |
| `projects` | JSON object of projects grouped by state. Only set by the `status` action; see [`projects`](#projects). |

They are set even when the step fails, so a reporting step can consume them - but it must
say `if: always()`, or it will be skipped on exactly the runs where the output matters
most.

### `error-message`

Always present, so you can read it unconditionally. It covers failures that happen before
Pulumi produces any plan output - a role that cannot be assumed, a bad backend, a stack
that can neither be selected nor created - which are otherwise only visible by reading the
step log. Each line is prefixed with where it came from and a `: ` - `login`, `workdirs`,
or the workdir exactly as you spelled it in the `workdirs` input.

```
login: pulumi login failed for s3://tri-pulumi-state-us-east-1/example-infra - error: unable to assume role arn:aws:iam::123456789012:role/deploy: AccessDenied
```

```
stg: pulumi refresh failed, 'pulumi up' not attempted - error configuring provider: no credentials
prd: pulumi up failed - error: creating S3 Bucket: BucketAlreadyExists
```

Every cause gets its own fully prefixed line - a workdir that broke in three places
produces three lines, and a cause shared by four workdirs produces four. Nothing is
indented under a header and nothing is collapsed, even though a bad role or a broken
provider config does fail everywhere at once. That is deliberate: it keeps the value a
flat record set you can filter by directory, so a workflow that only cares about some of
them can say

```bash
printf '%s\n' "$ERROR_MESSAGE" | grep '^prd:'
```

and get all of that workdir's causes and nothing else. Grouping or de-duplicating the
repeats is up to the consumer, and is only worth doing when a human reads the result.

Pulumi reports a failure as a generic wrapper line with the real causes bulleted below it:

```
error: Preview failed: 2 errors occurred:
    * error creating S3 Bucket: BucketAlreadyExists
    * AccessDenied: not authorized to perform: kms:CreateKey
```

`error-message` reports the causes and drops the wrapper, which would only repeat what
`status` and the summary already say. Each cause also names the resource whose diagnostics
it appeared under, because "creating S3 Bucket failed" does not say *which* of your
buckets:

```
prd: pulumi up failed - aws:s3:Bucket (access-logs) - error creating S3 Bucket: BucketAlreadyExists
prd: pulumi up failed - aws:kms:Key (backups) - AccessDenied: not authorized to perform: kms:CreateKey
```

A cause Pulumi attributes only to the `pulumi:pulumi:Stack` pseudo-resource is reported
without a resource, since that name identifies nothing.

Pulumi follows some failures with a canned list of things to check - the unassumable-role
error is the common one:

```
error: Preview failed: 1 error occurred:
    * error configuring Terraform AWS Provider: IAM Role cannot be assumed.
      There are a number of possible causes of this - the most common are:
        * The credentials used in order to assume the role are invalid
        * The role ARN is not valid
```

Those bullets are suggestions rather than causes, so they are left out; otherwise this one
failure would fill `error-message` with boilerplate. They stay in the log file.

At most 10 causes are reported per workdir, after which one line says how many were
withheld. The log file always has all of them, along with anything Pulumi printed
underneath - stack traces, the rest of the diagnostics.

A workdir that fails before its Pulumi operation still gets a log file listed in
`output-files`, so the full detail is readable there. The only failure with no log file is
`pulumi login`, which happens before any workdir is entered.

### `drift-status`

| Value | Meaning |
|---|---|
| `DRIFTED` | At least one workdir has drifted. A positive finding, so it stands even if another workdir failed. |
| `IN-SYNC` | Every workdir reached a verdict and none had drifted. |
| `UNKNOWN` | Drift could not be determined - the run failed, or a workdir never got as far as a verdict. |

`UNKNOWN` matters because the alternative is claiming `IN-SYNC` for a run that never
looked. Gate on `DRIFTED` rather than on `!= IN-SYNC`, or check `status` first.

## `status` (preview)

> **Preview.** The shape of the `projects` output may still change.

`status` compares the Pulumi projects declared in your repository with the projects in
the repository's state backend, and gives every project one of four states:

| State | In the repository? | Meaning |
|---|---|---|
| `DEPLOYED` | Yes | Its `main` stack has resources in state. |
| `NOT_DEPLOYED` | Yes | Not in the backend yet, or its `main` stack is empty or missing. |
| `ORPHANED` | No | Its `main` stack still has resources in state. They are likely still running, with nothing left in the repository to manage or destroy them. |
| `NOT_CREATED` | No | Its `main` stack is empty or missing. Only the stack is left behind. |

"Has resources" means the resource count `pulumi stack ls` reports is above zero. If
Pulumi does not report a count, the project is treated as having resources, so a
possible orphan is flagged rather than hidden.

Projects are matched by the `name:` in their `Pulumi.yaml`, not by directory name.

It is read-only: it never runs `pulumi up`, `refresh`, `destroy`, `stack init` or
`config refresh`.

### Failure behaviour

The findings never fail the step. An `ORPHANED` project can come from a branch that has
deployed but not merged yet, so deciding what to act on is left to the caller. The step
fails, with the cause in `error-message`, only when `status` could not do its job:

* `pulumi login` failed.
* The backend listing failed, or two `Pulumi.yaml` files declare the same `name:`.
* A workdir does not exist and could not be matched to an orphan (see below).

### `projects`

A JSON object with one key per state. Every key is always present, holding an array of
projects sorted by name, or `[]`:

```json
{
  "DEPLOYED":     [{"project": "network", "workdir": "infra/network", "resources": 12, "last_update": "2026-09-20T10:00:00Z"}],
  "NOT_DEPLOYED": [{"project": "cache", "workdir": "infra/cache", "resources": null, "last_update": null}],
  "ORPHANED":     [{"project": "old-api", "workdir": null, "resources": 8, "last_update": "2026-01-01T00:00:00Z"}],
  "NOT_CREATED":  []
}
```

| Field | Value |
|---|---|
| `project` | The `name:` from `Pulumi.yaml`, or the backend's project name. |
| `workdir` | The project's directory relative to the repository root. For a project no longer in the repository, it is the deleted workdir it was matched from, or `null`. |
| `resources` | The `main` stack's resource count, or `null` when there is no `main` stack or Pulumi reported no count. |
| `last_update` | When the `main` stack was last updated, or `null`. |

`projects` is not set when the step fails before the comparison, for example on a failed
login. Check `status` before calling `fromJSON`, which errors on an empty string.

### Which projects are checked

`workdirs` sets where to look:

* **Default (`.`)**: every `Pulumi.yaml` in the repository is found, at any depth, and every project in the backend is compared. Orphans are only fully detected in this mode.
* **Specific workdirs**: only `Pulumi.yaml` files under those directories are found. Backend projects that belong elsewhere are ignored, so they do not show up as orphans.

`.git`, `node_modules`, `.venv` and `fixtures` directories are never searched. `fixtures` is skipped because test projects there are never deployed.

A workdir that no longer exists, for example one deleted in the change being checked, is treated as follows:

* **Matched to a backend project**, if the backend has a project with the same name as the directory, and no `Pulumi.yaml` anywhere in the repository declares that name. It is reported as `ORPHANED` or `NOT_CREATED`, with the deleted workdir as its `workdir`. This is an assumption. A directory whose project had a different `name:` is not matched.

* **A failure** otherwise, reported in `error-message`. That includes a project that was
  moved rather than deleted.

### Example

``` yaml
- name: Pulumi status
  id: status
  uses: TRI-Actions/custom-actions/actions/pulumi-cli@main
  with:
    action: status
- name: Report orphans
  if: fromJSON(steps.status.outputs.projects).ORPHANED[0] != null
  env:
    PROJECTS: ${{ steps.status.outputs.projects }}
  run: |
    echo "Projects deleted from the repository with resources still deployed:"
    jq -r '.ORPHANED[] | "  \(.project) (\(.resources) resources, last update \(.last_update))"' <<< "$PROJECTS"
```

Other lookups:

* Whether a workdir is deployed: `contains(fromJSON(steps.status.outputs.projects).DEPLOYED.*.workdir, 'infra/network')`
* One job per orphan: `matrix: { orphan: "${{ fromJSON(needs.status.outputs.projects).ORPHANED }}" }`, then `matrix.orphan.project` in the job.

### Step log

Each run logs one line of counts:

```
1 DEPLOYED, 1 NOT_DEPLOYED, 1 ORPHANED, 0 NOT_CREATED
```

To see every project and its state, re-run the job with debug logging enabled. Locally,
set `RUNNER_DEBUG=1`.

```
  cache                          infra/cache                              NOT_DEPLOYED  not in the backend
  network                        infra/network                            DEPLOYED      12 resource(s), last update 2026-09-20T10:00:00Z
  old-api                        -                                        ORPHANED      8 resource(s), last update 2026-01-01T00:00:00Z
1 DEPLOYED, 1 NOT_DEPLOYED, 1 ORPHANED, 0 NOT_CREATED
```

### Requirements

`status` runs a Python script, so it needs `python3` on the runner. GitHub-hosted runners
already have it. It uses only the standard library, so there is nothing to install.

## Example

``` yaml
- name: Pulumi Plan
  id: plan
  uses: TRI-Actions/custom-actions/actions/pulumi-cli@main
  with:
    action: plan
    workdirs: dev stg
- name: Report
  if: always()
  env:
    # Through env, not interpolated into the script: error-message carries text from
    # pulumi, so a message containing a quote or a backtick would otherwise be run.
    STATUS: ${{ steps.plan.outputs.status }}
    DRIFT: ${{ steps.plan.outputs.drift-status }}
    FAILED_WORKDIRS: ${{ steps.plan.outputs.failed-workdirs }}
    ERROR_MESSAGE: ${{ steps.plan.outputs.error-message }}
    OUTPUT_FILES: ${{ steps.plan.outputs.output-files }}
  run: |
    echo "status: $STATUS"
    echo "drift:  $DRIFT"
    if [ "$STATUS" = failure ]; then
      echo "failed workdirs: $FAILED_WORKDIRS"
      printf '%s\n' "$ERROR_MESSAGE"
    fi
    while read -r file; do
      [ -n "$file" ] && cat "$file"
    done <<< "$OUTPUT_FILES"
```

## Tests

```bash
actions/pulumi-cli/test/run-tests.sh          # all cases
actions/pulumi-cli/test/run-tests.sh deploy   # filter by name substring
```

The suite runs the real `plan.sh` / `deploy.sh` / `destroy.sh` against a fake `pulumi`
on `PATH` (`test/stub/pulumi`) in a temp sandbox, so it needs no AWS credentials, no
state backend and no network. It covers exit-code propagation for each operation,
multi-workdir aggregation, nested workdirs, and every output above - including the
failure shapes `error-message` has to summarise.

Run it after touching any of the scripts. The failure-propagation cases are the ones that
matter: they are what fails against the pre-fix scripts.

`status` is not covered by this suite yet.
