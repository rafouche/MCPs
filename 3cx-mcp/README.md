# 3cx-mcp (Worker `threecx-mcp`)

One MCP connector for every client's 3CX v20 PBX.

- **URL:** `https://threecx-mcp.young-math-a33a.workers.dev/mcp`
- **Client list:** Hudu. No config file, no per-client secret in Cloudflare.
- **API coverage:** all 600+ XAPI operations, from 3CX's own OpenAPI spec.

## Adding a client

1. On the client's PBX: **Admin > Integrations > API > Add**. Tick **XAPI
   access** and choose role System Owner (or Admin). Save, then copy the
   **Client ID** (the DN it shows) and the **API key/secret** (shown once).
   The XAPI needs an Enterprise licence.
2. In Hudu, under the client's company, create an **Api secrets** asset:
   - **Name:** `<Client> 3CX API - https://<pbx fqdn>/`, for example
     `Altec 3CX API - https://altec.mo.3cx.us/`. The worker reads the client
     name from the text before "3CX" and the PBX address from the URL.
   - **Client ID:** the DN.
   - **Client Secret:** the key.

The worker picks the new client up within 5 minutes, or straight away with
`list_clients` and `refresh: true`. Run `list_clients` with `check: true` to
confirm it signs in.

If a 3CX asset is missing its URL, Client ID or Client Secret, `list_clients`
shows it with `ready: false` and says what's missing.

## Tools

| Tool | What it does |
|---|---|
| `list_clients` | Every PBX the worker can reach. With `check: true`, also each PBX's version, extensions/trunks registered and active calls. Never returns secrets. |
| `tcx_find_endpoints` | Searches the whole XAPI by keyword, e.g. "queue agents" or "reboot phone". Called with no query, it lists the API areas. |
| `tcx_describe_endpoint` | One operation's typed parameters (with enum values), query options, body fields and result, plus a ready-to-run example. |
| `tcx_describe_schema` | An entity's fields (User, Queue, ForwardingProfile...) or an enum's values. |
| `tcx_call` | Runs **any** operation by operationId on any client. The worker writes the OData URL: typed key and function literals, and parameter aliases for complex values. Collections default to `$top=100`. |
| `tcx_api_get` / `tcx_api_request` | Raw `/xapi/v1` path, GET only / write. |
| `get_system_status`, `list_users`, `get_user`, `list_queues`, `list_ring_groups`, `list_receptionists`, `list_groups`, `list_trunks`, `list_active_calls`, `get_call_log`, `get_call_history`, `list_event_logs` | Shortcuts for common lookups. |

Every tool takes `client`: the key from `list_clients`, or the client's
name, company or PBX host. A unique partial match also works.

Writes (`tcx_call` with POST/PATCH/PUT/DELETE, and `tcx_api_request`) change
the client's phone system.

Responses redact fields named like passwords, PINs and secrets
(`AuthPassword`, `VMPIN`, ...). Responses over 60K characters are cut off.

## Design notes

- **One token per PBX, shared through KV.** 3CX keeps only one active access
  token per API client. If each isolate minted its own, they would knock
  each other out; Peplink had the same problem. The token lives in KV
  namespace `TCX_TOKENS` (`489712bfbd99493bbb6c240f337a59b1`). On a 401 the
  worker mints a new token only if KV still holds the rejected one.
- **Catalog.** `src/catalog.json` is generated from `spec/swagger.yaml`
  (PBX build 20.0.10.1621). To refresh it, replace that file with a newer
  copy and run `npm run catalog`. Every PBX serves its own copy at
  `https://<pbx>/xapi/v1/swagger.yaml`, and 3CX publishes one in
  github.com/3cx/xapi-tutorial. A PBX on an older build may not have every
  operation and will return 404 for those.
- **Fails closed** like hudu-mcp. Until `MCP_AUTH_TOKEN` and `HUDU_API_KEY`
  are set, only `/health` answers; everything else returns 503.

## Secrets and vars

- **Secrets** (set in the Cloudflare dashboard):
  - `MCP_AUTH_TOKEN`: the Bearer token the MCP registration sends.
  - `HUDU_API_KEY`: a Hudu API key that can read the Api secrets layout.
- **Vars** (`wrangler.jsonc`):
  - `HUDU_BASE_URL`
  - `HUDU_SECRETS_LAYOUT` (default "Api secrets").

Deploy with `../meraki-mcp/node_modules/.bin/wrangler deploy`.
