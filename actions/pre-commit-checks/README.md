# pre-commit-checks
This is a simple Action that outputs pre-commit checks

## Prerequisites
  `.pre-commit-config.yaml` must be created and customized within the repo executing this workflow

## Deploying within Github Actions Workflow
```
  jobs:
    pipeline:
      runs-on: ubuntu-latest
      name: pre-commit
      permissions: write-all

      steps:
        - name: run composite module
          uses: TRI-Actions/custom-actions/actions/pre-commit-checks@main
```
