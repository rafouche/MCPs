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

## Rotating the key (2026-10-14)

- The API credentials must be able to read **identities** (Huntress ITDR /
  M365 users). The original key could read organizations, agents, signals,
  incidents and escalations, but `list_identities`/`get_identity` returned
  `{"error":"Access denied","code":"forbidden"}` and the REST passthrough
  `/api/huntress/identities` said "You are not authorized to access this
  page" (HelpDeskAgent ticket #23377). A user's API credentials fixed it.
- **Editing a secret in the Cloudflare dashboard only saves a new version.**
  It is not live until that version is deployed (Workers & Pages >
  huntress-mcp > Deployments > the new version > Deploy). On 2026-10-14 the
  new secrets sat in two undeployed versions while the Worker kept running
  the old key. `wrangler secret put` deploys immediately.
- Test identity access with `list_identities`, not `get_actor`: for an API
  key `get_actor` shows only the account, whichever key it is.

```cmd
curl https://huntress-mcp.young-math-a33a.workers.dev/api/huntress/identities?limit=1
```

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

## Inbound auth (MCP_AUTH_TOKEN)
Follows the repo's standing rule (see `CLAUDE.md`, "STANDING RULE: inbound
auth for every Worker"). Set `MCP_AUTH_TOKEN` as a Cloudflare **Secret**
(Worker > Settings > Variables and Secrets, type Secret), never a plain-text
variable; `wrangler.jsonc` has `"keep_vars": true` so a deploy never removes
it. Once set, every request needs `Authorization: Bearer <token>` except
`/health`, `/status`, and the read-only `/api/huntress/*` passthrough (GET/HEAD only; any other method gets 405), which the wallboard polls without a token. Until it's set the Worker
accepts any caller. Add `-H "Authorization: Bearer <token>"` to the `/mcp`
test commands above once the token is on.
