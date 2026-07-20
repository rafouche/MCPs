# UniFi MCP Server

## Secrets Required
```
wrangler secret put UNIFI_API_KEY   # From unifi.ui.com > Settings > API
```

## Setup in UniFi
1. Log into unifi.ui.com
2. Go to Settings → API
3. Generate a new API key

## Deploy
```
npm install
wrangler deploy
```

## Routes
- `POST /mcp` — MCP JSON-RPC endpoint for Claude
- `GET /status` — NOC wallboard: per-host device online/offline counts
- `GET /health` — Health check

## Claude.ai Integration URL
`https://unifi-mcp.<account>.workers.dev/mcp`

## Test Commands (CMD — verified working on Windows)

Health check:
```cmd
curl https://unifi-mcp.young-math-a33a.workers.dev/health
```

List tools (confirms MCP is reachable and credentials work):
```cmd
curl -X POST https://unifi-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

NOC status endpoint:
```cmd
curl https://unifi-mcp.young-math-a33a.workers.dev/status
```

> **Note:** PowerShell quoting is unreliable for JSON bodies. Use CMD (cmd.exe) for curl test commands.
