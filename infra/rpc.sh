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

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <method> '<params_json>'" >&2
  exit 1
fi

METHOD="$1"
PARAMS_JSON="${2:-{}}"
REQ_ID=$((RANDOM % 9000 + 1000))

PAYLOAD=$(jq -cn --arg method "$METHOD" --argjson params "$PARAMS_JSON" --argjson id "$REQ_ID" '{
  jsonrpc: "2.0",
  id: $id,
  method: $method,
  params: $params
}')

RESP=$(curl -s "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --data-binary "$PAYLOAD")

echo "$RESP" | jq .
