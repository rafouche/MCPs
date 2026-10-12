# halopsa-mcp

HaloPSA MCP server (Cloudflare Worker). See the repo's `CLAUDE.md` for the
ticket tools, the HelpDeskAgent routes and the inbound-auth rule. This README
currently covers only the billing tools.

## Billing tools (`POST /billing/mcp`)

Write access for billing administration: recurring invoices, contracts,
clients, items, software licences and five billing settings. Added 2026-10-12.

### Who can call them (the Allie exclusion)

`halopsa-mcp` has one `MCP_AUTH_TOKEN`, shared by the Help Desk agent (Allie,
HelpDeskAgent) and the Claude connector, so the Worker cannot tell those
callers apart on `/mcp`. The billing tools therefore live on their **own
route with their own token**:

- They are listed and callable **only** on `POST /billing/mcp`, which accepts
  only `BILLING_MCP_AUTH_TOKEN`. `MCP_AUTH_TOKEN` gets 401 there.
- `/mcp` is unchanged: its `tools/list` is byte-identical to before this
  change (checked), so Allie's allowlist and her permissions are untouched,
  and nothing needs adding to or removing from HelpDeskAgent.
- `BILLING_MCP_AUTH_TOKEN` opens nothing else (401 on `/mcp`).
- Fails closed: unset = route returns 503. If it equals `MCP_AUTH_TOKEN` the
  route also returns 503, because Allie's token would then open it.
- `/status`, `/health` and the wallboard are untouched.
- Register it as a separate Claude connector (URL
  `https://halopsa-mcp.young-math-a33a.workers.dev/billing/mcp`, header
  `Authorization: Bearer <BILLING_MCP_AUTH_TOKEN>`). Never give that URL or
  token to HelpDeskAgent.

### Halo credentials

All billing tool calls - reads included - use a separate Halo API
application: `HALO_BILLING_CLIENT_ID` / `HALO_BILLING_CLIENT_SECRET` (token
scope `HALO_BILLING_SCOPE`, default `all`, i.e. every permission enabled on
that application). There is no fallback: without them every billing tool
returns a clear error, and the ticket credentials (`HALO_CLIENT_ID/SECRET`)
are never used.

### Safety rules (every write tool)

- `dry_run` defaults to **true**: returns the exact method, path and JSON body,
  `would_change` (each field it sets, current value -> new value) and the
  current record. Nothing is sent.
- A real write needs `dry_run: false` **and** `confirm` equal to the exact
  target path (the dry run prints it under `to_apply`).
- After a real write the record is read back and a field-level `diff` is
  returned (fields Halo bumps on every save, like `last_modified`, are listed
  separately as `volatile_changes`).
- Audit: every real write (and every failed one) is logged to Workers Logs as
  a `BILLING_AUDIT {...}` line - timestamp, caller (route, IP, user agent,
  cf-ray), tool, method, path, body, HTTP status, record ids, error. If KV
  namespace `BILLING_AUDIT` is bound, the same entry is stored there too and
  `get_billing_audit` lists it. Secret-looking fields are redacted.
- Bulk calls cap at 50 records (ids or body objects).
- Writable collections come from config, `BILLING_WRITE_PATHS` in
  `wrangler.jsonc`; anything else is refused.
- Refused whatever the config says: agents, roles, API applications and
  integration records (`/Agent*`, `/Roles`, `/UserRoles`, `/*Details` except
  `/Pax8Details`, `/*Integration*`, `/azuread*`, `/*Mailbox*`, `/*Webhook*`,
  `/Application`, ...; case-insensitive); any body field that looks like a
  secret (secret, password, token, apikey, credential, `code`...), which
  blocks the Pax8 OAuth fields; `/Control` keys outside
  `BILLING_CONTROL_KEYS`; deleting an `/Invoice` that is posted or has a
  `qboid` (void it in QuickBooks instead); deleting `/Control`.
- Field names are checked against this tenant's swagger
  (`src/billing-schema.ts`) plus the fields the current record carries, so a
  typo is rejected with a suggestion instead of being silently ignored.
- Outputs never include the client object Halo embeds in a recurring invoice
  (it carries the QuickBooks connection) or any `/Control` key other than the
  ones asked about.

### Tools

| Tool | Parameters | Does |
|---|---|---|
| `billing_healthcheck` | - | Tests the billing credentials; shows the scope Halo granted, the write paths, the control keys and where audit goes. Read-only. |
| `get_billing_audit` | `limit` | Recent KV audit entries. Read-only. |
| `halo_api_post` | `path`, `body` (array), `dry_run`, `confirm`, `verbose` | POST to an allowlisted collection, body passed through. An object with an `id` is an update. |
| `halo_api_delete` | `path` (collection), `id`, `dry_run`, `confirm` | DELETE `{path}/{id}`. |
| `set_recurring_invoice_active` | `ids[]`, `active` | Sets `disabled` on templates, resending each template's complete lines. |
| `create_recurring_invoice` | `client_id`, `contract_id?`, `header{}`, `lines[]`, `active?` | New template, created **disabled** unless `active: true`. |
| `update_recurring_invoice` | `id`, `fields{}`, `lines[]?` | Header fields and line patches (`{id, ...}` patches a line, no `id` adds one). Always sends the complete line set. Cannot remove lines. |
| `update_recurring_invoice_line` | `invoice_id`, `line_id`, `fields{}` | One line; sends all lines. |
| `update_contract` | `id`, `fields{}` | `/ClientContract` (this tenant has no `/Contract`). |
| `update_client` | `id`, `fields{}` | `/Client`, e.g. `accountsid`, `inactive`. |
| `update_item` | `id`, `fields{}` | `/Item`, e.g. `recurringprice`, `recurringcost`, `income_account`, `nominalcode`. |
| `upsert_software_licence` | `client_id`, `id` or `name`, `count`, `item_id?`, `fields{}` | Sets a client's licence count, creating the licence if missing. Warns when the licence is synced from Pax8. |
| `update_halo_settings` | `keys{}` | `/Control`, allowlisted keys only; reads and shows only those keys. |
| `create_invoice_from_recurring` | `recurring_invoice_ids[]` | `POST /RecurringInvoice/process`; the dry run shows the invoice-email settings. |

All write tools also take `dry_run`, `confirm` and `verbose`.

### What was verified, and what was not (2026-10-12)

Against the live swagger and read-only GETs on the tenant:

- `/ClientContract` is the contract collection; `/Contract` does not exist.
- A recurring invoice template's on/off field is `disabled` (template -143
  reads `disabled: true`). `/Control` POST takes an array, and the five
  default control keys all exist. `/Item` has no `inactive` field (only an
  undocumented `status`), so `update_item` rejects `inactive`.
- `/RecurringInvoice/process` (body: array of template ids) is the only
  generate-now endpoint in the swagger. What it does exactly is **not
  verified**.
- Whether POSTing a template's `lines` **replaces or merges** the line set is
  **not verified** - it cannot be without a write. The tools therefore always
  send the complete current line set, which is correct either way. Removing a
  line is not offered until this is known.
- That Halo honours `disabled` on POST is not proven by the planned end-to-end
  test (re-disabling -143, which is already disabled); that test proves the
  write path, the audit and that resending the full lines changes nothing.
- Halo's value for a contract "Live" status is not in the swagger.
- Halo's permission scope names are **not** in the swagger or the API docs
  text (the docs show them as an image). `billing_healthcheck` reports the
  scope Halo actually grants.

Offline test: the real Worker bundle run against records read from the tenant
(every non-GET to Halo fails the run) - every tool's dry run, every refusal
above, the route isolation, and one simulated write through confirm, diff and
audit. The harness is not committed (its fixtures contain client data).

### Setup

1. In Halo (Roger), **Configuration > Integrations > Halo API > View
   Applications > New**:
   - Application name `Claude Billing`, Active.
   - Authentication method **Client ID and Secret (Services)**.
   - Login type **Agent**; agent to log in as: one whose role can edit
     billing/invoices, recurring invoices, contracts, customers, items,
     software licences and the billing settings in Configuration. A dedicated
     API-only agent keeps these writes attributable.
   - **Permissions** tab: enable only the permissions covering those areas
     (invoices/billing, contracts, customers, items, software/licences, and
     settings/admin for `/Control`). Their exact names were not verifiable
     here - note them as shown, then compare with `granted_scope` from
     `billing_healthcheck`.
   - Save, copy the Client ID and Secret.
2. Secrets (run in `halopsa-mcp/`, or set them in the Cloudflare dashboard):
   ```bash
   wrangler secret put BILLING_MCP_AUTH_TOKEN      # a NEW random value, e.g. openssl rand -hex 32; not MCP_AUTH_TOKEN
   wrangler secret put HALO_BILLING_CLIENT_ID
   wrangler secret put HALO_BILLING_CLIENT_SECRET
   ```
3. Optional KV audit trail: `wrangler kv namespace create BILLING_AUDIT`, then
   add `"kv_namespaces": [{ "binding": "BILLING_AUDIT", "id": "<id>" }]` to
   `wrangler.jsonc`.
4. Deploy per the standing rule in `CLAUDE.md` (compare the live tool names
   with the repo first), with `../meraki-mcp/node_modules/.bin/wrangler deploy`.
5. Add the Claude connector for `/billing/mcp` and run `billing_healthcheck`.

Regenerate `src/billing-schema.ts` if Halo adds fields: download
`https://altecusa.halopsa.com/api/swagger/v2/swagger.json` and write the
`properties` keys of `InvoiceHeader`, `InvoiceDetail`, `ContractHeader`,
`Area`, `Item`, `Licence_List` and `Control` under the names
`RecurringInvoice`, `InvoiceLine`, `ClientContract`, `Client`, `Item`,
`SoftwareLicence`, `Control`.
