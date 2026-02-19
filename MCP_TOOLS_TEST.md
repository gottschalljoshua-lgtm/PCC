# MCP Tools Test Reference

## Allowed Tools (13 total)

The MCP Gateway exposes only these tools, matching GHL Private Integration scopes:

1. `contacts_search` - Search contacts by query
2. `contacts_upsert` - Create or update a contact
3. `contacts_update_status` - Update tags/stage for a contact
4. `calendar_list_appointments` - List appointments in a calendar window
5. `calendar_create_appointment` - Create an appointment
6. `calendar_reschedule_appointment` - Reschedule an appointment
7. `calendar_cancel_appointment` - Cancel an appointment
8. `conversations_list_threads` - List recent threads for a channel
9. `conversations_get_thread` - Fetch messages for a thread
10. `conversations_send_message` - Send a message into an existing thread
11. `tasks_list` - List tasks by due window
12. `tasks_create` - Create a task
13. `tasks_complete` - Complete task

## Test Commands

### List All Tools

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: 11111111112222222222333333333344" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "contacts_search",
        "description": "Search contacts by query",
        "inputSchema": { ... }
      },
      ... (12 more tools)
    ]
  }
}
```

### Call contacts_search Tool

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: 11111111112222222222333333333344" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "contacts_search",
      "arguments": {
        "query": "test@example.com",
        "pageLimit": 10
      }
    }
  }'
```

**Expected Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "json",
        "json": {
          "contacts": [...]
        }
      }
    ]
  }
}
```

## Schema Compliance

All tool schemas use strict JSON Schema:
- No union types (e.g., `type: ["string", "null"]` → `type: "string"`)
- Optional fields are not in `required` array
- All types are single values: `"string"`, `"number"`, `"object"`, `"array"`, `"boolean"`

## Authentication

The gateway accepts both:
- `x-api-key: <MCP_API_KEY>` header
- `Authorization: Bearer <MCP_API_KEY>` header

Both methods are equivalent and use the same `MCP_API_KEY` value.

## Proposals (Approval Gating)

### List Recent Proposals

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 901,
    "method": "tools/proposals/list",
    "params": { "limit": 10 }
  }'
```

### Create Proposal (Write Tool)

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 902,
    "method": "tools/call",
    "params": {
      "name": "tasks_create",
      "arguments": {
        "title": "PCC Test Task",
        "dueDateTime": "2026-02-18T17:00:00-05:00",
        "contactId": "CONTACT_ID"
      }
    }
  }'
```

### Approve Proposal

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 903,
    "method": "tools/approve",
    "params": {
      "proposal_id": "PASTE_PROPOSAL_ID",
      "approve": true
    }
  }'
```

### Get Proposal Record

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 904,
    "method": "tools/proposals/get",
    "params": { "proposal_id": "PASTE_PROPOSAL_ID" }
  }'
```

## Verification (Proposals)

### List Recent Proposals

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 901,
    "method": "tools/proposals/list",
    "params": { "limit": 10 }
  }'
```

### Create Proposal (Write Tool)

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 902,
    "method": "tools/call",
    "params": {
      "name": "tasks_create",
      "arguments": {
        "title": "PCC Test Task",
        "dueDateTime": "2026-02-18T17:00:00-05:00",
        "contactId": "CONTACT_ID"
      }
    }
  }'
```

### Approve Proposal

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 903,
    "method": "tools/approve",
    "params": {
      "proposal_id": "PASTE_PROPOSAL_ID",
      "approve": true
    }
  }'
```

### Get Proposal Record

```bash
curl -X POST https://api.command-finfitlife.com/mcp \
  -H "Content-Type: application/json" \
  -H "x-api-key: $MCP_API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 904,
    "method": "tools/proposals/get",
    "params": { "proposal_id": "PASTE_PROPOSAL_ID" }
  }'
```
