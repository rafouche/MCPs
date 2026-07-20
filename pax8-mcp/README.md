# pax8-mcp

Passthrough gateway for Pax8. Proxies MCP JSON-RPC to `mcp.pax8.com/v1/mcp`
and exposes a raw REST reverse-proxy at `/api/pax8/*`. Both paths use the
same OAuth2 token from `api.pax8.com/v1/token`.

## Secrets Required

```
wrangler secret put PAX8_CLIENT_ID      # From app.pax8.com > Partner Portal > Company > API
wrangler secret put PAX8_CLIENT_SECRET  # From same location
```

> **Note:** `PAX8_MCP_TOKEN` is no longer needed — the worker now uses OAuth2
> client credentials for both the MCP passthrough and the REST proxy.

## Setup in Pax8

1. Log into app.pax8.com
2. Go to **Partner Portal → Company → API**
3. Create a new API client — copy the **Client ID** and **Client Secret**
4. Token endpoint: `https://api.pax8.com/v1/token`
5. MCP endpoint: `https://mcp.pax8.com/v1/mcp`

## Deploy

```
npm install
wrangler secret put PAX8_CLIENT_ID
wrangler secret put PAX8_CLIENT_SECRET
wrangler deploy
```

## Routes

- `POST /mcp` — MCP JSON-RPC passthrough to Pax8
- `GET /api/pax8/*` — Raw REST reverse-proxy to api.pax8.com/v2/
- `GET /health` — Health check

## Claude.ai Integration URL

`https://pax8-mcp.young-math-a33a.workers.dev/mcp`

## Test Commands (CMD — verified working on Windows)

Health check:
```cmd
curl https://pax8-mcp.young-math-a33a.workers.dev/health
```

List tools (confirms MCP is reachable and credentials work):
```cmd
curl -X POST https://pax8-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

NOC status endpoint:
```cmd
curl https://pax8-mcp.young-math-a33a.workers.dev/status
```

> **Note:** PowerShell quoting is unreliable for JSON bodies. Use CMD (cmd.exe) for curl test commands.
