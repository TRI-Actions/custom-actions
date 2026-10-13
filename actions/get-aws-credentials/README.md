# Get AWS Credentials

A reusable GitHub Action that gets short-lived AWS credentials for a role in a target account using GitHub OpenID Connect (OIDC).

This action:
1. Assumes the **target role** directly with the job's OIDC token, which works once the role trusts its own account's GitHub OIDC provider.
2. If that fails and `direct` is `auto`, falls back to the **federated role chain**: OIDC into the federated service role in the central account, then the target role. A notice in the log names the role and the reason.
3. Exports the credentials and the region to all subsequent workflow steps.

The fallback exists while accounts move from the central federated roles to per-account OIDC trust; it will be removed once every account trusts GitHub directly.

---

## Inputs

| Name | Description | Required | Default |
|------|--------------|-----------|----------|
| `account-id` | AWS Account ID of the target environment | Yes | — |
| `region` | AWS Region | No | `us-east-1` |
| `federated-role-name` | Base name of the federated service role in the central account | No | `GHAFederatedRole` |
| `target-role-name` | Name of the target role to assume in the target account | No | `DefaultCrossAccountRole` |
| `direct` | `auto`: direct, then the chain; `only`: direct, no fallback; `off`: chain only | No | `auto` |
| `role-duration-seconds` | Session duration for the direct path, at most the role's maximum session duration | No | `3600` |

## Outputs

| Name | Description |
|------|-------------|
| `path` | `direct` or `chain`: how the credentials were obtained |

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
        uses: TRI-Actions/custom-actions/actions/get-aws-credentials@v1
        with:
          account-id: 222222222222
          target-role-name: MyCrossAccountRole  # optional override of DefaultCrossAccountRole

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
