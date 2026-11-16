# acronis-mcp

Acronis Cyber Protect Cloud as an MCP server for Allie (HelpDeskAgent) and Claude, over the Acronis Cyber Platform REST API. **Read-only:** nothing here dismisses alerts, starts or edits plans, deletes backups or touches agents.

Worker: `https://acronis-mcp.young-math-a33a.workers.dev/mcp` (deployed by GitHub Actions on push to `main`).

## What you need from Acronis

1. Sign in to the Acronis **Management Portal** at the partner level (the tenant that holds our customers) as an administrator.
2. Go to **Settings > API clients > Create API client**, name it (e.g. `altec-mcp`), and click **Next**.
3. Copy all three values before you click **Done**. The secret is shown only once.
   - **Client ID**
   - **Secret**
   - **Datacenter URL**, e.g. `https://us5-cloud.acronis.com`

The API client gets the rights of the person who creates it and keeps them if that person is later removed. Create it from an account whose rights are as narrow as reads need. Losing the secret means resetting it, which invalidates every token.

## Cloudflare settings (Workers > acronis-mcp > Settings > Variables and Secrets)

| Name | Type | Value |
|---|---|---|
| `ACRONIS_BASE_URL` | Text | the datacenter URL, no `/api` |
| `ACRONIS_CLIENT_ID` | Secret | client ID |
| `ACRONIS_CLIENT_SECRET` | Secret | secret |
| `MCP_AUTH_TOKEN` | Secret | a long random string; the MCP registration sends it as `Authorization: Bearer ...` |

The Worker fails closed: every route except `GET /health` returns 503 until all four are set. `/health` reports `configured: true|false`.

**Optional:** bind a KV namespace as `ACRONIS_TOKENS` to share the 2-hour token across isolates, the way peplink-mcp and 3cx-mcp do. Without the binding, each isolate mints its own token, which is about one per cold start. Acronis does not document a one-token-per-client rule or a token rate limit.


## Tools

| Tool | What it answers |
|---|---|
| `healthcheck` | Token works; the API client's tenant; how many customers it sees |
| `list_customers` | Customer tenants (name, UUID). Every `tenant` argument takes a name or a UUID |
| `get_tenant`, `get_tenant_usage` | Tenant details and its units; non-zero usage against quota |
| **`get_backup_status`** | Start here. One customer (optionally one machine name): each workload's status, last backup run, last **successful** backup and days since, problems first; offline agents; open warning-or-worse alerts |
| **`list_activities`** | Why a backup failed: each run/step for a machine, newest first, with the readable cause (e.g. `Disk 'E:\...avhdx' is not found`). By `resource_name`, `resource_id` or `task_id`; `errors_only` |
| `list_workloads`, `get_workload` | Protection status per workload (`only_problems`, `stale_days`); one resource with its attributes |
| `list_alerts`, `get_alert`, `customer_alert_counts` | Alerts filtered by tenant, severity, category, type, machine and since; open-alert counts per customer |
| `list_tasks` | Plan-level task history (logged against the machine running the agent, e.g. the Hyper-V host) |
| `list_agents` | Agents: online, version, OS, update status |
| `list_protection_plans` | A customer's plans, which parts are on, and optionally which workloads each covers |
| `list_backups`, `list_archives` | Vault Manager recovery points and archives. Returns nothing to this partner-level client so far; says so instead of an empty list |
| `acronis_find_endpoints`, `acronis_describe_endpoint` | Search and describe every documented Acronis endpoint (317 operations, 151 reads, 12 APIs) from the catalog below |
| `acronis_api_get` | Raw GET on any catalog path (under `/api`, or `/fc/api/v1/...` for File Sync & Share). Token, secret, password and credential paths are refused |

List tools return a trimmed view. Pass `full: true` to get Acronis's raw rows. Results are capped at 60K characters. Response keys that look secret (password, secret, tokens, API keys) are redacted.

## How Acronis scopes data (verified live, 2026-11-16)

A customer's machines, agents and backup tasks do not belong to the customer tenant. They belong to a **unit** under it, named after the account the agent registered with (e.g. customer "Fritz, Nippes & Associates, LLC" > unit "BackupUser@fncpas.com"). The Worker builds each customer's scope as the customer plus every tenant below it, from the tenant list it caches for 5 minutes.

| Area | Path under `{dc}/api` | What works |
|---|---|---|
| Token | `POST /2/idp/token` | Basic `client_id:secret`, `grant_type=client_credentials`, 2 h; renewed 15 min early. The branded host (`cloudbackup.altecusa.com`) serves the API |
| Tenants | `/2/tenants?subtree_root_id=` | Includes the units |
| Alerts | `/alert_manager/v1/alerts`, `/customer_alerts_count` | `tenant=<customer UUID>` includes its units; `severity=or(a,b)` and `updated_at=gt(<unix ns>)` work |
| Workload status | `/resource_management/v4/resource_statuses` | `tenant_id=<UUID>` matches that exact tenant only, so every unit's UUID is sent. The customer's own UUID alone returns nothing |
| Plans | `/policy_management/v4/policies` | `tenant_id=<customer UUID>`; plans live at the customer, not the unit |
| Agents | `/agent_manager/v2/agents` | `tenant_id` ignores UUIDs (only Acronis's numeric ids work). The Worker lists all agents (cached 2 min) and keeps the scope's units by name |
| Tasks, activities | `/task_manager/v2/tasks`, `/activities` | Resource ids are UPPERCASE. `like()` and `gt()` filters return 500 or time out, and `X-Apigw-Tenant-Id` is ignored, so the Worker sorts `desc(id)` and filters dates and tenants itself. A VM's per-run detail is in activities; the plan task is logged against the host |
| Backups | `/vault_manager/v1/backups`, `/archives` | Returns nothing to the partner-level client |
## Every Acronis API: the endpoint catalog

`src/catalog.json` is generated from Acronis's own OpenAPI specs in `spec/` (the 12 "OpenAPI 3.0 format" links on [the API library page](https://developer.acronis.com/doc/outbound/apis/api-library/index.html), downloaded 2026-11-16). To pick up new endpoints, re-download them and run `npm run catalog`. `acronis_find_endpoints` searches it, `acronis_describe_endpoint` shows one endpoint's parameters, and `acronis_api_get` calls any GET. Writes are listed but not callable.

What the partner-level API client could do with each API (checked live 2026-11-16):

| API | Reads | With this client |
|---|---|---|
| Account Management | 45 | Works |
| Alert Manager | 11 | Works |
| Agent Management | 6 | Works (numeric tenant ids only) |
| Resource and Policy Management | 11 | Works, incl. `/policy_management/v4/applications` (per-machine deployment state) |
| Task Management | 4 | Works (UPPERCASE ids, no server-side date filter) |
| Event Manager | 5 | Works (`/topics`) |
| Vault Manager | 29 | **Empty lists** (vaults, archives, backups, storage stats) |
| Disaster Recovery | 4 | **Refused**: "not allowed for tenant kind partner" |
| EDR incidents | 3 | Needs `customer_id`; only customers with EDR |
| Acronis PSA, Pricelist, File Sync & Share | 17, 1, 15 | Not tested (Altec uses HaloPSA; File Sync & Share is a separate product) |

**File-level search inside backups: there is no public API for it.** None of the 12 specs can search or browse files in a recovery point; the console uses an internal index (the API only reports that index's size, `/vault_manager/v1/search_index_size_stats/{tenantID}`). Vault and Disaster Recovery probably need an API client created at the customer level; not tried yet.

## Local checks

```bash
npm install
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

**Windows:** PowerShell mangles JSON bodies. Use `cmd.exe`, or pipe from `echo` into `curl --data-binary @-`.
