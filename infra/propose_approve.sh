#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script." >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <tool_name> '<json_arguments>'" >&2
  echo "Examples:" >&2
  echo "  $0 tasks_create '{\"title\":\"PCC Test Task\",\"dueDateTime\":\"2026-02-19T17:00:00-05:00\",\"contactId\":\"CONTACT_ID\"}'" >&2
  echo "  $0 tasks_create @/tmp/task_args.json" >&2
  exit 1
fi

TOOL_NAME="$1"
ARGS_RAW="$2"

if [[ "$ARGS_RAW" == @* ]]; then
  ARGS_RAW="$(cat "${ARGS_RAW#@}")"
fi

ARGS="$(printf '%s' "$ARGS_RAW" | tr -d '\r\n')"

if ! printf '%s' "$ARGS" | jq -e . >/dev/null 2>&1; then
  PREVIEW="$(printf '%s' "$ARGS_RAW" | tr -d '\r\n' | head -c 120)"
  echo "Params JSON is invalid. Preview: ${PREVIEW}" >&2
  echo "Tip: use @/path/to/file.json for complex JSON." >&2
  exit 1
fi

PROPOSE_PARAMS="$(jq -nc --arg name "$TOOL_NAME" --argjson args "$(printf '%s' "$ARGS" | jq -c .)" '{name:$name,arguments:$args}')"

RESP="$(RPC_RAW=1 ./infra/rpc.sh tools/call "$PROPOSE_PARAMS")"

PROPOSAL_ID=$(echo "$RESP" | jq -r '
  if .result.proposal_id then .result.proposal_id
  elif .result.proposalId then .result.proposalId
  else
    (.result.content[0].text // empty)
    | (try (fromjson | .proposal_id // .proposalId) catch empty)
  end
')

if [[ -z "$PROPOSAL_ID" || "$PROPOSAL_ID" == "null" ]]; then
  echo "No proposal_id found in response." >&2
  echo "$RESP" | jq .
  exit 2
fi

APPROVE_PARAMS="$(jq -nc --arg pid "$PROPOSAL_ID" '{proposal_id:$pid,approve:true}')"
RPC_RAW=1 ./infra/rpc.sh tools/approve "$APPROVE_PARAMS" | jq .

echo "Get proposal status:"
echo "./infra/rpc.sh tools/proposals/get '{\"proposal_id\":\"$PROPOSAL_ID\"}'"
