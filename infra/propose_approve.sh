#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script." >&2
  exit 1
fi

BASE_URL="${BASE_URL:-https://api.command-finfitlife.com/mcp}"
API_KEY="${API_KEY:-${MCP_API_KEY:-}}"

if [[ -z "${API_KEY}" ]]; then
  echo "Missing API key. Set API_KEY or MCP_API_KEY." >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <tool_name> '<json_arguments>'" >&2
  exit 1
fi

TOOL_NAME="$1"
ARGS_JSON="$2"
REQ_ID=$((RANDOM % 9000 + 1000))

PROPOSE_PAYLOAD=$(jq -cn --arg name "$TOOL_NAME" --argjson args "$ARGS_JSON" --argjson id "$REQ_ID" '{
  jsonrpc: "2.0",
  id: $id,
  method: "tools/call",
  params: { name: $name, arguments: $args }
}')

RESP=$(curl -s "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --data-binary "$PROPOSE_PAYLOAD")

PROPOSAL_ID=$(echo "$RESP" | jq -r '
  (.result.content[0].text // empty)
  | (try (fromjson | .proposal_id // .proposalId) catch empty)
')

if [[ -z "$PROPOSAL_ID" || "$PROPOSAL_ID" == "null" ]]; then
  echo "No proposal_id found in response." >&2
  echo "$RESP" | jq .
  exit 2
fi

APPROVE_PAYLOAD=$(jq -cn --arg pid "$PROPOSAL_ID" --argjson id "$((REQ_ID + 1))" '{
  jsonrpc: "2.0",
  id: $id,
  method: "tools/approve",
  params: { proposal_id: $pid, approve: true }
}')

curl -s "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --data-binary "$APPROVE_PAYLOAD" | jq .
