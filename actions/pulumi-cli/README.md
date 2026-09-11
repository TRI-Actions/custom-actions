# Pulumi CLI Custom Action

This action provides a wrapper around the Pulumi CLI to make its use easier within other GitHub Actions workflows.

It supports plan, deploy and destroy options. With `drift_check` enabled, the plan option also reports the drift status of deployed resources via the `drift-status` output, leaving it to the calling workflow to decide whether to proceed.

## Parameters

There are two parameters required to use this action:

* `action`: The action you want to take. (Supported options are: `plan`, `deploy` and `destroy`)
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

They are set even when the step fails, so a reporting step can consume them - but it must
say `if: always()`, or it will be skipped on exactly the runs where the output matters
most.

### `error-message`

Always present, so you can read it unconditionally. It covers failures that happen before
Pulumi produces any plan output - a role that cannot be assumed, a bad backend, a stack
that can neither be selected nor created - which are otherwise only visible by reading the
step log. Each line is prefixed with where it came from: `login`, `workdirs`, or the
workdir itself.

```
login: pulumi login failed for s3://tri-pulumi-state-us-east-1/example-infra - error: unable to assume role arn:aws:iam::123456789012:role/deploy: AccessDenied
```

```
stg: pulumi refresh failed, 'pulumi up' not attempted - error: 1 error occurred
prd: pulumi up failed - error: creating S3 Bucket: BucketAlreadyExists
```

A workdir that fails before its Pulumi operation still gets a log file listed in
`output-files`, so the detail is readable there too. The only failure with no log file is
`pulumi login`, which happens before any workdir is entered.

### `drift-status`

| Value | Meaning |
|---|---|
| `DRIFTED` | At least one workdir has drifted. A positive finding, so it stands even if another workdir failed. |
| `IN-SYNC` | Every workdir reached a verdict and none had drifted. |
| `UNKNOWN` | Drift could not be determined - the run failed, or a workdir never got as far as a verdict. |

`UNKNOWN` matters because the alternative is claiming `IN-SYNC` for a run that never
looked. Gate on `DRIFTED` rather than on `!= IN-SYNC`, or check `status` first.

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
  run: |
    echo "status: ${{ steps.plan.outputs.status }}"
    echo "drift:  ${{ steps.plan.outputs.drift-status }}"
    if [ "${{ steps.plan.outputs.status }}" = failure ]; then
      echo "failed workdirs: ${{ steps.plan.outputs.failed-workdirs }}"
      echo "${{ steps.plan.outputs.error-message }}"
    fi
    while read -r file; do
      [ -n "$file" ] && cat "$file"
    done <<< "${{ steps.plan.outputs.output-files }}"
```

## Tests

```bash
actions/pulumi-cli/test/run-tests.sh          # all cases
actions/pulumi-cli/test/run-tests.sh deploy   # filter by name substring
```

The suite runs the real `plan.sh` / `deploy.sh` / `destroy.sh` against a fake `pulumi`
on `PATH` (`test/stub/pulumi`) in a temp sandbox, so it needs no AWS credentials, no
state backend and no network. It covers exit-code propagation for each operation,
multi-workdir aggregation, nested workdirs, and the `drift-status` output.

Run it after touching any of the scripts - the failure-propagation cases are the ones
that matter, since 19 of the 23 fail against the pre-fix scripts.
