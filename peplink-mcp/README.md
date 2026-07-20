# Peplink InControl2 MCP Server

## Secrets Required
```
wrangler secret put PEPLINK_CLIENT_ID      # From InControl2 portal > Settings > API
wrangler secret put PEPLINK_CLIENT_SECRET  # From same location
```

## Setup in Peplink InControl2
1. Log into incontrol.peplink.com
2. Go to Settings → API Applications → Add
3. Copy Client ID and Client Secret

## Deploy
```
npm install
wrangler deploy
```

## Routes
- `POST /mcp` — MCP JSON-RPC endpoint for Claude
- `GET /status` — NOC wallboard: per-org device online/offline counts
- `GET /licenses` — NOC wallboard: warranty/subscription renewals expiring within 60 days
- `GET /health` — Health check

## Claude.ai Integration URL
`https://peplink-mcp.<account>.workers.dev/mcp`

## Test Commands (CMD — verified working on Windows)

Health check:
```cmd
curl https://peplink-mcp.young-math-a33a.workers.dev/health
```

List tools (confirms MCP is reachable and credentials work):
```cmd
curl -X POST https://peplink-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

NOC status endpoint:
```cmd
curl https://peplink-mcp.young-math-a33a.workers.dev/status
```

> **Note:** PowerShell quoting is unreliable for JSON bodies. Use CMD (cmd.exe) for curl test commands.
