#!/bin/sh
# Deletes the adapter's only access key, so no one can replace its code and sign as the owner.
# Irreversible: the contract can never be upgraded; a fix means a new adapter (and a new agent).
set -e
ADAPTER=${ADAPTER:-agent-owner.multiagentic.near}
KEY=$(node -e 'process.stdout.write(require(process.argv[1]).public_key)' "$HOME/.near-credentials/mainnet/$ADAPTER.json")
near account delete-keys "$ADAPTER" public-keys "$KEY" network-config mainnet sign-with-legacy-keychain send
near account list-keys "$ADAPTER" network-config mainnet now
