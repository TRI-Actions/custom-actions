# web-app-infra

## A custom GitHub Actions module for web-app-infra pipelines

This is a custom module for use by web-app repositories, such as kaleidoscope-deploy, htp-exp-deploy, and other repositories used by TRI.

## Prerequisites
There is a mandatory file structure as shown below. The staging file may be any name as long as it matches the name of the Pull Request tag. The files in app_build_scripts may be any file type, however it must not have extra parameters not contained within the file.

```
app_build_scripts
├───before_scripts
|   └───my_file_name.py
└───after_scripts
    └───my_other_file_name.py
terraform
├───globals
|   └───globals.tfvars
└───staging
    └───staging.tfvars
```


## Action Functionality
This Action executes a series of steps.

Step 1: Download terraform binary
Step 2: Parse manifest file
Step 3: Execute Pre-commit checks
Step 4: Depending on manifest file settings, execute scripts in `app_build_scripts/before_scripts` directory
Step 5: Execute Terraform Plan or Terraform Deploy if triggered by comment
Step 6: Depending on manifest file settings, execute scripts in `app_build_scripts/after_scripts` directory
Step 7: Alert users to any errors or potential deployment


### Parameters
There are three inputs with this repo:

```
AWS_IAM_Role:
    description: 'Cross Account role arn to assume to deploy infrastructure'
    required: false
    type: String
  SSM_private_keys:
    description: "comma separated list of ssm key locations, no spaces"
    required: false
    type: String
  SSM_pat:
    description: "Location of pat token in SSM"
    required: false
    type: String
  JFrog_oidc_provider:
    description: "JFrog OIDC provider of the repository's GitHub org, e.g. tri-rse"
    required: false
    type: String
```

If no IAM role is set, it will use whatever is set by default by the runner executing the deployment.
SSM_private keys can have multiple key locations separated by a comma. Private keys are keys used to facilitate github repo retrieval.
SSM_pat can only use one personal access token location. PAT is used to facilitate github repo retrieval.
JFrog_oidc_provider lets `terraform init` download modules from the JFrog Terraform registry (`toyotaresearchinstitute.jfrog.io/ie-tf-modules-aws__modules/<name>/aws`) without an SSH key.
The job exchanges its GitHub OIDC token for a short-lived JFrog token right before `terraform init`, so the calling job needs `permissions: id-token: write` and a JFrog identity mapping for the repository in TRI-IE/jfrog-access.
JFrog has one OIDC provider per GitHub org (`tri-rse`, `tri-mac`, `tri-amdd`, `ie-tf-modules` for TRI-IE), and a token is only accepted by its own org's provider.
This works on github.com runners. GitHub Enterprise has a `github-enterprise` provider, but no GHES repository has completed the token exchange yet: JFrog has to reach the internal GHES token issuer (see the TRI-IE/jfrog-access RUNBOOK, "Onboarding GHES").

All parameters may be omitted or used as needed.

## Terraform state locking behaviour

The **plan** step runs with `-lock=false`. It reads state without acquiring the lock, so a plan will never fail due to a lock conflict and will never force-unlock a lock held by another process. This means:

- A plan and a running apply can overlap safely — the plan does not interfere with the apply's lock.
- A stale lock (left by a crashed apply) does **not** cause the plan to fail. If you need to clear a stale lock, do it manually: `terraform force-unlock <LOCK_ID>`.

The **apply** step acquires the lock normally via `terraform apply`. If it encounters an existing lock it will fail with Terraform's standard lock error, which includes the lock ID, operation type, and timestamp — use those to determine whether the lock is stale before force-unlocking manually.

## Incomplete deploys

A `GithubDeploy` adds the label `deploy-incomplete-<env>` (for example `deploy-incomplete-staging`) to its PR right before `terraform apply`, and removes it after the PR is merged.
If the apply, the after_scripts or the merge fails, or the run is cancelled, the label stays: AWS then has changes that the base branch doesn't, and a deploy from any other PR would undo them.
While any other PR, open or closed, has the label for the same environment, `GithubDeploy` is refused with a comment that links it.
The labeled PR can still deploy, so fix it and comment `GithubDeploy` again, or push a revert to it and deploy that.
Remove the label by hand only once AWS matches the base branch again.
The label is never taken as the PR's environment.

## How to use in Github Actions Workflow:

```
jobs:
  pipeline:
    runs-on: ubuntu-latest
    name: ${{ github.event.issue.pull_request && 'deploy' || 'plan' }}
    permissions: write-all

    steps:
      - name: run composite module
        uses: TRI-Actions/custom-actions/actions/web-app-infra@main
        with:
          AWS_IAM_Role: arn:aws:iam::1234567890123:role/{IAM_ROLE_NAME}
          SSM_private_keys: /key/location/1,/key/location/2
          SSM_pat: /pat/location
```
