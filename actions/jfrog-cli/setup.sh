#!/usr/bin/env bash
set -euo pipefail

echo "Setting up JFrog CLI..."

# Install JFrog CLI
if [ "$JFROG_CLI_VERSION" = "latest" ]; then
  echo "Installing latest version of JFrog CLI..."
  curl -fL https://install-cli.jfrog.io | sh
else
  echo "Installing JFrog CLI version $JFROG_CLI_VERSION..."
  curl -fL "https://releases.jfrog.io/artifactory/jfrog-cli/v2-jf/${JFROG_CLI_VERSION}/jfrog-cli-linux-amd64/jf" -o jf
  chmod +x jf
  sudo mv jf /usr/local/bin/jf
fi

echo "JFrog CLI installed:"
jf -v

# Get GitHub OIDC ID token
echo "Fetching GitHub OIDC token..."
ID_TOKEN=$(curl -sSL \
  -H "User-Agent: actions/oidc-client" \
  -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}" \
  | jq -r .value)

if [ -z "$ID_TOKEN" ] || [ "$ID_TOKEN" = "null" ]; then
  echo "ERROR: Failed to fetch GitHub OIDC token"
  exit 1
fi

echo "::add-mask::$ID_TOKEN"

# Debug: Show token claims for troubleshooting
echo "ID token claims (for debugging identity mapping):"
ID_PAYLOAD=$(echo "$ID_TOKEN" | cut -d. -f2)
PAD=$(( 4 - ${#ID_PAYLOAD} % 4 ))
[ $PAD -lt 4 ] && ID_PAYLOAD="${ID_PAYLOAD}$(printf '=%.0s' $(seq 1 $PAD))"
echo "$ID_PAYLOAD" | tr '_-' '/+' | base64 -d | jq '{sub, aud, repository, event_name, ref, job_workflow_ref, repository_owner}'

# Exchange OIDC token for JFrog access token using CLI
echo "Exchanging OIDC token for JFrog access token..."
echo "Provider: $OIDC_PROVIDER"
echo "Audience: $AUDIENCE"
echo "URL: $JFROG_URL"
EXCHANGE_ARGS=("eot" "$OIDC_PROVIDER" "$ID_TOKEN" "--url" "$JFROG_URL")

# Add audience if provided
if [ -n "$AUDIENCE" ]; then
  EXCHANGE_ARGS+=("--oidc-audience" "$AUDIENCE")
fi

# Run the exchange command and capture output
EXCHANGE_OUTPUT=$(jf "${EXCHANGE_ARGS[@]}" 2>&1) || {
  echo "ERROR: Failed to exchange OIDC token"
  echo "$EXCHANGE_OUTPUT"
  exit 1
}

# Extract access token and username from output
# Try JSON format first (CLI 2.75.0+)
if ACCESS_TOKEN=$(echo "$EXCHANGE_OUTPUT" | jq -r '.AccessToken // empty' 2>/dev/null) && [ -n "$ACCESS_TOKEN" ]; then
  USERNAME=$(echo "$EXCHANGE_OUTPUT" | jq -r '.Username // empty')
else
  # Fallback to regex parsing for older output format
  if [[ "$EXCHANGE_OUTPUT" =~ AccessToken:[[:space:]]*([^[:space:]]+)[[:space:]]*Username:[[:space:]]*([^[:space:]]+) ]]; then
    ACCESS_TOKEN="${BASH_REMATCH[1]}"
    USERNAME="${BASH_REMATCH[2]}"
  else
    echo "ERROR: Failed to parse access token from exchange output"
    echo "$EXCHANGE_OUTPUT"
    exit 1
  fi
fi

if [ -z "$ACCESS_TOKEN" ]; then
  echo "ERROR: Access token is empty after exchange"
  exit 1
fi

echo "::add-mask::$ACCESS_TOKEN"
echo "::add-mask::$USERNAME"

# Set outputs for potential use in subsequent steps
echo "oidc-token=$ACCESS_TOKEN" >> "$GITHUB_OUTPUT"
echo "oidc-user=$USERNAME" >> "$GITHUB_OUTPUT"

# Configure JFrog CLI with the access token
echo "Configuring JFrog CLI..."
jf config add "$SERVER_ID" \
  --url="$JFROG_URL" \
  --access-token="$ACCESS_TOKEN" \
  --interactive=false

echo "JFrog CLI configured successfully!"
echo "Server ID: $SERVER_ID"
echo "Username: $USERNAME"
echo ""
jf config show
