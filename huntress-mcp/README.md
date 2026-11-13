# huntress-mcp

Read-only MCP tools over the Huntress REST API (`api.huntress.io/v1`), plus a
read-only REST passthrough at `/api/huntress/*` for the wallboard. One
credential: the API key and secret, sent as HTTP Basic on every request.

## Why it no longer relays Huntress's MCP (2026-11-12)

Until 2026-11-12 `/mcp` relayed tools/list and tools/call to Huntress's own
hosted MCP server (`https://api.huntress.io/v1/mcp`) with the API key as Basic
auth. Huntress changed that server to accept only a signed-in user's OAuth
token: its metadata (`/.well-known/oauth-authorization-server`) lists only
`authorization_code` with PKCE, scope `act_as_user`, no client-credentials
grant and no refresh token. Every tool call then failed with:

```
Huntress MCP returned 401: {"jsonrpc":"2.0","error":{"code":-32001,"message":"A valid OAuth bearer token is required."},"id":1}
```

The REST API still takes the API key, so the Worker now runs the tools itself.

## Tools

All tools are GETs. Nothing here isolates or uninstalls an agent, resolves an
incident or escalation, approves a remediation or edits a rule.

- The named tools are generated from Huntress's own API spec into
  `src/tools.json`: names kept from Huntress's MCP (`get_account`,
  `get_actor`, `list_/get_organization(s)`, `agents`, `incident_reports`,
  `remediations`, `escalations`, `signals`, `reports`, `identities`,
  `external_ports`, `platform_actions`, `unwanted_access_rules`,
  `list_known_vpns`, `memberships`, `invoices`), plus
  `list_incident_report_comments`, `list_remote_access_connections`,
  `list_siem_log_sources` and `get_siem_log_source`. Filters, enums and
  descriptions come straight from the spec.
- `huntress_api_get` GETs any v1 path (`path` relative to `/v1`, query in
  `params`; no `..` or `?` in the path). Responses are capped at 60,000
  characters.
- Lists are paged: `limit` (1-500, Huntress's default is 10) and `page_token`
  from the previous response's `pagination.next_page_token`.
- The spec is wrong about `list_remediations`' filters: it names them
  `types[]` / `statuses[]`, which Huntress rejects; `types=manual,containment`
  works. The generator sends the plain names, and arrays go comma-separated.

To pick up new endpoints or filters:

```bash
curl -L https://api.huntress.io/docs -o spec/swagger_doc.json
npm run tools
```

`scripts/build-tools.mjs` holds the tool name to path table.

## Deploy

Pushing to `main` deploys it through GitHub Actions (see the repo's
`CLAUDE.md`). Secrets are set on the Worker in the Cloudflare dashboard:
`HUNTRESS_API_KEY`, `HUNTRESS_API_SECRET`, and `MCP_AUTH_TOKEN`.

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

## Test (CMD - PowerShell quoting breaks JSON bodies)

Health check:
```cmd
curl https://huntress-mcp.young-math-a33a.workers.dev/health
```

List tools, then call one (proves the API key works). Add
`-H "Authorization: Bearer <MCP_AUTH_TOKEN>"` while the token is set:
```cmd
curl -X POST https://huntress-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}"
curl -X POST https://huntress-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"list_organizations\",\"arguments\":{\"limit\":1}}}"
```

## Inbound auth (MCP_AUTH_TOKEN)
Follows the repo's standing rule (see `CLAUDE.md`, "STANDING RULE: inbound
auth for every Worker"). Set `MCP_AUTH_TOKEN` as a Cloudflare **Secret**
(Worker > Settings > Variables and Secrets, type Secret), never a plain-text
variable; `wrangler.jsonc` has `"keep_vars": true` so a deploy never removes
it. Once set, every request needs `Authorization: Bearer <token>` except
`/health`, `/status`, and the read-only `/api/huntress/*` passthrough (GET/HEAD only; any other method gets 405), which the wallboard polls without a token. Until it's set the Worker
accepts any caller. Add `-H "Authorization: Bearer <token>"` to the `/mcp`
test commands above once the token is on.
