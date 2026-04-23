# Get AWS Credentials

A reusable GitHub Action that assumes an **IAM role chain** using OpenID Connect (OIDC) to access AWS resources across accounts.

This action:
1. Uses OIDC to authenticate into a **federated service role** in the central AWS account.
2. Assumes a **target role** in the specified destination AWS account.
3. Exports short-lived AWS credentials automatically to all subsequent workflow steps.

---

## Inputs

| Name | Description | Required | Default |
|------|--------------|-----------|----------|
| `account-id` | AWS Account ID of the target environment | Yes | — |
| `region` | AWS Region | No | `us-east-1` |
| `federated-role-name` | Base name of the federated service role in the central account | No | `GHAFederatedRole` |
| `target-role-name` | Name of the target role to assume in the target account | No | `DefaultCrossAccountRole` |

---

## Example Usage

```yaml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write  # Required for OIDC
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Get AWS Credentials
        uses: TRI-Actions/get-aws-credentials@v1
        with:
          account-id: 222222222222
          federated-role-name: CustomFederatedRole  # optional override

      - name: Verify AWS identity
        run: aws sts get-caller-identity

      - name: Deploy resources
        run: |
          aws s3 ls
          aws cloudformation describe-stacks
```

After the “Get AWS Credentials” step runs, the environment automatically contains:
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN
```
You can use AWS CLI or SDK commands directly without additional configuration.