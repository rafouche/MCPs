# pax8-mcp

Passthrough gateway for Pax8. Proxies MCP JSON-RPC to `mcp.pax8.com/v1/mcp`
and exposes a read-only raw REST reverse-proxy at `/api/pax8/*`. The two
paths use **different credentials**:

| Route | Credential | Sent as |
|---|---|---|
| `/mcp` | `PAX8_MCP_TOKEN` (Pax8 MCP token) | `x-pax8-mcp-token` header |
| `/api/pax8/*` | `PAX8_CLIENT_ID`/`PAX8_CLIENT_SECRET` -> token from `api.pax8.com/v1/token` | `Authorization: Bearer` |

Pax8's MCP server does not accept REST API tokens. A client_credentials token
from `api.pax8.com/v1/token` gets 401 `Invalid JWT: Unexpected 'iss' value`.
Its Bearer option only takes tokens from its own OAuth server
(`mcp.pax8.com/v1`, authorization code + refresh token only, so a person
signs in), which doesn't suit an unattended Worker. The MCP token header needs
no token minting at all. Don't move `/mcp` back to `login.pax8.com` tokens:
minting those once per Worker isolate is what Pax8 flagged on 2026-11-11.

## Secrets Required

```
wrangler secret put PAX8_MCP_TOKEN      # From app.pax8.com/integrations/mcp (Settings > Integrations > MCP server)
wrangler secret put PAX8_CLIENT_ID      # From app.pax8.com > Partner Portal > Company > API
wrangler secret put PAX8_CLIENT_SECRET  # From same location
```

If `/mcp` starts answering 401 `Invalid x-pax8-mcp-token` (token revoked or
regenerated in Pax8), generate a new MCP token and replace `PAX8_MCP_TOKEN`.

## Setup in Pax8

1. Log into app.pax8.com
2. MCP token: **Settings → Integrations → MCP server** (app.pax8.com/integrations/mcp)
3. REST client: **Partner Portal → Company → API**; create an API client and copy the **Client ID** and **Client Secret**
4. REST token endpoint: `https://api.pax8.com/v1/token`
5. MCP endpoint: `https://mcp.pax8.com/v1/mcp`

## Deploy

Deploys go through GitHub: pushing a change in this folder to `main` runs
`.github/workflows/deploy.yml`. Never `wrangler deploy` from a local checkout.

## Routes

- `POST /mcp` — MCP JSON-RPC passthrough to Pax8
- `GET /api/pax8/*` — Raw REST reverse-proxy to api.pax8.com/v1/ (GET/HEAD only)
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

## Inbound auth (MCP_AUTH_TOKEN)
Follows the repo's standing rule (see `CLAUDE.md`, "STANDING RULE: inbound
auth for every Worker"). Set `MCP_AUTH_TOKEN` as a Cloudflare **Secret**
(Worker > Settings > Variables and Secrets, type Secret), never a plain-text
variable; `wrangler.jsonc` has `"keep_vars": true` so a deploy never removes
it. Once set, every request needs `Authorization: Bearer <token>` except
`/health` and the read-only `/api/pax8/*` passthrough (GET/HEAD only; any other method gets 405), which the wallboard polls without a token. Until it's set the Worker
accepts any caller. Add `-H "Authorization: Bearer <token>"` to the `/mcp`
test commands above once the token is on.
