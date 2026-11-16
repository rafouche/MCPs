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
| `get_tenant`, `get_tenant_usage` | Tenant details; non-zero usage against quota |
| **`get_backup_status`** | Start here. Takes one customer (optionally one machine name) and returns each workload's status with last run and last success (problems first), offline agents, and open warning-or-worse alerts |
| `list_workloads`, `get_workload` | Protection status per workload; one resource with its attributes |
| `list_alerts`, `get_alert`, `customer_alert_counts` | Alerts filtered by tenant, severity, category, type, machine and since; open-alert counts per customer across the partner |
| `list_tasks`, `list_activities` | Backup run history with result codes; the steps of one task (why it failed) |
| `list_agents` | Agents: online, version, OS |
| `list_protection_plans` | Plans and, optionally, the workloads each one covers |
| `list_backups`, `list_archives` | Recovery points of a workload, newest first; archives with storage size |
| `acronis_api_get` | Raw GET on any `/api` path. Token, secret, password and credential paths are refused |

List tools return a trimmed view. Pass `full: true` to get Acronis's raw rows. Results are capped at 60K characters. Response keys that look secret (password, secret, tokens, API keys) are redacted.

## APIs and tenant scoping

| Area | Path under `{dc}/api` | Tenant scoping |
|---|---|---|
| Token | `POST /2/idp/token` | Basic `client_id:secret`, `grant_type=client_credentials`, 2 h; renewed 15 min early |
| Tenants, usage | `/2/clients/{id}`, `/2/tenants?subtree_root_id=`, `/2/tenants/usages` | n/a |
| Alerts | `/alert_manager/v1/alerts`, `/customer_alerts_count` | `tenant=` |
| Workload status | `/resource_management/v4/resource_statuses`, `/resources/{id}` | `tenant_id=` |
| Plans | `/policy_management/v4/policies` | `tenant_id=` |
| Agents | `/agent_manager/v2/agents` | `tenant_id=` |
| Tasks | `/task_manager/v2/tasks`, `/activities` | No filter. Uses the `X-Apigw-Tenant-Id` header, then drops rows whose `tenant` is another customer's |
| Backups | `/vault_manager/v1/backups`, `/archives` | By `resourceId`, plus the header |

Sources: developer.acronis.com, the Account Management v2, Alerts v1, Tasks v2, Resource/Policy Management v4, Agents v2 and Vault Manager v1 references (read 2026-11-16).

## Not yet verified against a live tenant

These were built from the reference documentation only. Check each one on the first live run:

- The filter syntaxes `completedAt=gt(<ISO>)`, `severity=or(a,b)`, `updated_at=gt(<unix ns>)` and `resourceName=like(%x%)`.
- Whether `X-Apigw-Tenant-Id` scopes task and vault calls. The post-filter covers tasks either way.
- The exact row shapes of `/policies` and `/tenants/usages`. Use `full: true` if the trimmed view looks empty.
- Whether a partner-level API client sees customer data on every service. Acronis documents this per service, but not as one rule.

## Local checks

```bash
npm install
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

**Windows:** PowerShell mangles JSON bodies. Use `cmd.exe`, or pipe from `echo` into `curl --data-binary @-`.
