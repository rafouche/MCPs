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
| `get_call_report` | Any of the admin console's call reports by name (inbound/outbound calls, queue performance, SLA, abandoned, callbacks, agent login history, ring group and extension statistics, user activity, call distribution, call cost, inbound rules, audit log, chat log...) with the console's defaults filled in, so only a date range is needed. Optional filters: queues, extensions, ring_groups, group, trunks, calls_type, wait_interval, timezone (default America/Chicago); `params` overrides any raw parameter. |
| `get_system_status`, `list_users`, `get_user`, `list_queues`, `list_ring_groups`, `list_receptionists`, `list_groups`, `list_trunks`, `list_active_calls`, `get_call_log`, `list_event_logs` | Shortcuts for common lookups. |

Every tool takes `client`: the key from `list_clients`, or the client's
name, company or PBX host. A unique partial match also works.

Writes (`tcx_call` with POST/PATCH/PUT/DELETE, and `tcx_api_request`) change
the client's phone system.

Responses redact fields named like passwords, PINs and secrets
(`AuthPassword`, `VMPIN`, ...). Responses over 60K characters are cut off.

## Live findings (Altec PBX, 20.0.9.995, 2026-10-05)

- **Report functions require every parameter.** Passing `null` for an
  optional text parameter gets a 400 ("The queueDns field is required"), so
  `tcx_call` sends `''` for omitted ones. The call log's time-of-day filters
  take `'0:00:0'` (the admin console's default), with `hidePcalls=true`.
- **`CallHistoryView` is the legacy table.** On Altec its data stops in June
  2025, and a `$filter` on `SegmentStartTime` returns a 500. Use
  `get_call_log` (ReportCallLogData) for real call history.
- **`GetExtensionStatisticsData` returns a 500** on 20.0.9 and on 20.0.10
  (1785 and 1801, re-checked 2026-11-25) whatever the filter. A null
  `extensionFilter` gets a validation 400, so the request is right and the
  fault is 3CX's. Use `queue_performance` or the call log instead.
- **Asset matching.** Only Hudu assets named "... 3CX API ..." (or with
  Service Name "3CX") count as PBXs. "3CX MCP -> Hudu API Key" is ignored.

## Live findings (20.0.10.1801, 2026-11-25)

- Every PBX was on 20.0.10.1785 or .1801. The 1801 spec has the same 603
  operations, schemas and enums as 1621; only the version stamp changed.
- `get_call_report`: all 27 reports were run on Altec and return data
  except `extension_statistics` (above).
- Chart reports (`queue_answered_unanswered_chart`,
  `queue_average_wait_chart`) with `chart_by` 'day' returned monthly points
  for the year; the accepted `chart_by` values are not documented.
- 3CX's public spec download (downloads-global.3cx.com, June 2024, 499 ops)
  is stale. Take the spec from a current PBX:
  `https://<pbx>/xapi/v1/swagger.yaml` (served without sign-in).

## Design notes

- **One token per PBX, shared through KV.** 3CX keeps only one active access
  token per API client. If each isolate minted its own, they would knock
  each other out; Peplink had the same problem. The token lives in KV
  namespace `TCX_TOKENS` (`489712bfbd99493bbb6c240f337a59b1`). On a 401 the
  worker mints a new token only if KV still holds the rejected one.
- **Catalog.** `src/catalog.json` is generated from `spec/swagger.yaml`
  (PBX build 20.0.10.1801). To refresh it, replace that file with a newer
  copy and run `npm run catalog`. Take it from a PBX on the newest build:
  `https://<pbx>/xapi/v1/swagger.yaml`, no sign-in needed (its `info` carries
  `x-pbx-version`). 3CX's public downloads are older. A PBX on an older build may not have every
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
