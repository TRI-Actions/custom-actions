# terraform-infra

## A custom GitHub Actions module for terraform-infra pipelines

This is a custom module for use by terraform-NAME-infra repositories, such as terraform-ss-core-infra, terraform-simm-infra, etc. Using this pipeline, you will create a pull request with your repo. The pull request of your repo will execute terraform fmt checks and show a plan. Comment `GithubDeploy` in order to deploy the changes from the terraform plan. Below is the format for your repo.

    └───terraform
        ├───Account_number_A.tf
        ├───Account_number_B.tf
        └───modules
            ├───Account_number_A
            |   └───terraform.tf
            ├───Account_number_B
            |   └───terraform.tf

The files under modules are where the pipeline will deploy your custom terraform modules. Anything you would like to deploy would be under these modules. This includes providers and other information.

Account_number_A.tf is customized as the following:

    module "module-name" {
      source = "./modules/Account_number_A"
    }


## Prerequisites
    - Terraform statefile bucket must be set up for use
    - All repos using this pipeline must have the name format terraform-NAME-infra. Any other format will cause issues


## Inputs

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
  require_approval:
    description: "If 'false', skip the PR-approval gate before Terraform apply. Defaults to 'true'."
    required: false
    default: 'true'
    type: String
```

If no IAM role is set, it will use whatever is set by default.
SSM_private keys can have multiple key locations separated by a comma.
SSM_pat can only use one personal access token location.
`require_approval` is `'true'` by default; set it to `'false'` only for repos that
have explicitly opted out of the in-workflow approval gate.

Fork pull requests are not supported: the action fails fast and posts a comment
asking the contributor to push their branch directly to the base repository.

All variables can be omitted or used depending on the context.

## How to use in Actions Workflow:

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
