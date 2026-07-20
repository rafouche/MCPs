# huntress-mcp

Passthrough gateway for Huntress only. Independent of pax8-mcp — deploying
or breaking this one has zero effect on Pax8, or on any future vendor
gateway you add later.

## Deploy

```bash
cd huntress-mcp
wrangler secret put HUNTRESS_API_KEY
wrangler secret put HUNTRESS_API_SECRET
wrangler deploy
```

Deploys to `https://huntress-mcp.young-math-a33a.workers.dev`.

## Test

```bash
curl -X POST https://huntress-mcp.young-math-a33a.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Should return Huntress's real tool list, unprefixed, exactly as their own
MCP server would return it — this is a straight relay, not a rename.

## Swapping into Claude's connector settings

Point the Huntress connector at `https://huntress-mcp.young-math-a33a.workers.dev/mcp`
once you've confirmed it works. Consider keeping the official one active
alongside it at first as a fallback.

## Test Commands (CMD — verified working on Windows)

Health check:
```cmd
curl https://huntress-mcp.young-math-a33a.workers.dev/health
```

List tools (confirms MCP is reachable and credentials work):
```cmd
curl -X POST https://huntress-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
```

NOC status endpoint:
```cmd
curl https://huntress-mcp.young-math-a33a.workers.dev/status
```

> **Note:** PowerShell quoting is unreliable for JSON bodies. Use CMD (cmd.exe) for curl test commands.
