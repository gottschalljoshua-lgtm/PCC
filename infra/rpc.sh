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
  echo "Examples:" >&2
  echo "  $0 tools/proposals/list '{\"limit\":5}'" >&2
  echo "  $0 tools/proposals/list @/tmp/params.json" >&2
  exit 1
fi

METHOD="$1"
PARAMS_RAW="${2:-{}}"
REQ_ID=$((RANDOM % 9000 + 1000))

if [[ "$PARAMS_RAW" == @* ]]; then
  PARAMS_RAW="$(cat "${PARAMS_RAW#@}")"
fi

PARAMS="$(printf '%s' "$PARAMS_RAW" | tr -d '\r\n')"

if ! printf '%s' "$PARAMS" | jq -e . >/dev/null 2>&1; then
  PREVIEW="$(printf '%s' "$PARAMS_RAW" | tr -d '\r\n' | head -c 120)"
  echo "Params JSON is invalid. Preview: ${PREVIEW}" >&2
  echo "Tip: use @/path/to/file.json for complex JSON." >&2
  exit 1
fi

PARAMS_COMPACT="$(printf '%s' "$PARAMS" | jq -c .)"

PAYLOAD=$(jq -nc --arg method "$METHOD" --argjson id "$REQ_ID" --argjson params "$PARAMS_COMPACT" '{
  jsonrpc: "2.0",
  id: $id,
  method: $method,
  params: $params
}')

RESP=$(curl -s "$BASE_URL" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  --data-binary "$PAYLOAD")

if [[ "${RPC_RAW:-}" == "1" ]]; then
  printf '%s' "$RESP"
else
  printf '%s' "$RESP" | jq .
fi
