# Get JFrog Credentials

A reusable GitHub Action that exchanges a GitHub OIDC ID token for a **short-lived JFrog access token** — no static secrets required.

This action:
1. Requests a GitHub OIDC ID token scoped to the configured audience.
2. POSTs it to JFrog's `/access/api/v1/oidc/token` endpoint, naming the OIDC provider configured in JFrog.
3. Decodes the `sub` claim out of the returned access token and (by default) writes `~/.netrc` so `curl -n`, Terraform, and similar tools pick the credentials up transparently.

The access token is also exposed as a step output and as the `JF_ACCESS_TOKEN` environment variable for callers that prefer Bearer auth.

---

## Inputs

| Name | Description | Required | Default |
|------|-------------|----------|---------|
| `jfrog-url` | JFrog platform base URL | No | `https://toyotaresearchinstitute.jfrog.io` |
| `oidc-provider` | Name of the OIDC provider configured in JFrog (Administration → Security → OIDC) | Yes | — |
| `audience` | OIDC audience to request from GitHub. Must match the audience configured on the JFrog provider. | No | `jfrog-github-oidc` |
| `write-netrc` | If `true`, write `~/.netrc` with the access token so `curl -n` / Terraform pick it up automatically | No | `true` |

## Outputs

| Name | Description |
|------|-------------|
| `access-token` | Short-lived JFrog access token |
| `username` | JFrog principal (the `sub` claim from the access token JWT) |

## Environment variables exported

| Name | Description |
|------|-------------|
| `JF_ACCESS_TOKEN` | The same access token, exposed to subsequent steps via `$GITHUB_ENV`. Matches the convention used by the JFrog CLI. |

---

## Prerequisites

- **Caller workflow must grant `id-token: write`** at the job (or workflow) level. Composite actions cannot grant permissions on the caller's behalf:
  ```yaml
  permissions:
    id-token: write
    contents: read
  ```
- **JFrog OIDC provider must exist** with an Identity Mapping whose **Claims JSON** matches the caller. The simplest stable filter is on the `repository` claim:
  ```json
  {"repository": "TRI-IE/<your-repo>"}
  ```
  Pinning to a specific workflow file is a stronger option:
  ```json
  {"repository": "TRI-IE/<your-repo>", "job_workflow_ref": "TRI-IE/<your-repo>/.github/workflows/<file>.yaml@*"}
  ```

---

## Example usage

```yaml
name: Publish module
on:
  pull_request:
    branches: [main]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read

    steps:
      - uses: actions/checkout@v4

      - name: Get JFrog Credentials
        uses: TRI-Actions/custom-actions/actions/get-jfrog-credentials@v1
        with:
          oidc-provider: ie-tf-modules

      # ~/.netrc is now populated; curl -n authenticates transparently
      - name: Upload artifact
        run: |
          curl -n -sSL -T module.zip \
            https://toyotaresearchinstitute.jfrog.io/artifactory/my-repo/module-1.0.0.zip

      # Or use Bearer auth via the exported env var
      - name: List repositories
        run: |
          curl -sSL -H "Authorization: Bearer $JF_ACCESS_TOKEN" \
            https://toyotaresearchinstitute.jfrog.io/artifactory/api/repositories | jq 'length'

      - name: Cleanup credentials
        if: always()
        run: rm -f ~/.netrc
```

### Cleanup

When `write-netrc` is left at its default, add an `if: always()` step that runs `rm -f ~/.netrc` as the last step in the job. Composite actions cannot register post-cleanup steps, so this stays the caller's responsibility.

---

## Troubleshooting

If the token exchange fails, the action prints JFrog's full error response **and** a redacted view of the GitHub ID-token claims (`sub`, `aud`, `repository`, `event_name`, `ref`, `job_workflow_ref`). Compare those values against the Identity Mapping's Claims JSON in JFrog — `FORBIDDEN` almost always means the caller's `sub` (or whichever claim you're filtering on) doesn't match the mapping.
