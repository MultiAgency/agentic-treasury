#!/bin/sh
# Deploys the owner adapter for a DAO. Run lock.sh afterwards, once you have checked it.
set -e
PARENT=${PARENT:-multiagentic.near}
ADAPTER=${ADAPTER:-agent-owner.$PARENT}
DAO=${DAO:-agentic.sputnik-dao.near}
# The account that brings the Agent API's requests to sign; the DAO can change it later (set_executors).
EXECUTOR=${EXECUTOR:-$PARENT}
WASM=$(dirname "$0")/../target/near/owner_adapter.wasm

# The owner key: what v1.signer derives from this contract on the "agent-owner" path.
OWNER_KEY=$(curl -s https://free.rpc.fastnear.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"v1.signer\",\"method_name\":\"derived_public_key\",\"args_base64\":\"$(printf '{"path":"agent-owner","predecessor":"%s","domain_id":1}' "$ADAPTER" | base64)\"}}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(Buffer.from(JSON.parse(s).result.result).toString())))')
echo "adapter $ADAPTER for $DAO; owner key $OWNER_KEY; executor $EXECUTOR"

near account create-account fund-myself "$ADAPTER" '3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$PARENT" network-config mainnet sign-with-legacy-keychain send
near contract deploy "$ADAPTER" use-file "$WASM" with-init-call new json-args "{\"dao\":\"$DAO\",\"path\":\"agent-owner\",\"owner_key\":\"$OWNER_KEY\",\"recipients\":[\"api.demo.agentsonintents.com\",\"api.agentsonintents.com\"],\"executors\":[\"$EXECUTOR\"]}" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
near contract call-function as-read-only "$ADAPTER" owner json-args '{}' network-config mainnet now
