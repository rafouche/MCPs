# halopsa-mcp

HaloPSA as an MCP connector (Cloudflare Worker `halopsa-mcp`). Ticket, on-call and Help Desk pipeline tools are
documented in the repo's `CLAUDE.md`. This file covers the **billing write tools** added 2026-11-27 and the
`halo_api_get` changes that came with them.

## Billing write tools

Code: `src/billing.ts`. Config: `wrangler.jsonc`. Mock test: `test/billing.sim.mjs` (how to run is at its top).

Same Worker, same Halo API application, same credentials as every other tool. In Halo these writes show up as
agent **Allie (id 17)**, because that is the agent the API application runs as.

### Who can use them

- **Not part of the Help Desk agent's allowlist.** Allie's tools are an explicit list of names in
  `rafouche/AllieService`, `src/Packs.HelpDesk/Generated/Upstream.g.cs` (`ResolverTools` and the other lists,
  generated from HelpDeskAgent's script). A tool that is not named there cannot be called by her. None of the
  tools below is in it. Do not add them.
- **Hidden behind mcp-gateway.** They are not in `mcp-gateway/servers.json` `readTools`, and the gateway is
  read-only.
- Anyone holding this Worker's `MCP_AUTH_TOKEN` directly (Roger's own connector) can call them.

### Safety rules (every write tool)

| Rule | What it means |
|---|---|
| `dry_run` defaults to `true` | A dry run sends nothing. It returns the method, path and JSON body that would be sent, the current record, notes, and `confirm_to_send`. |
| `confirm` | A real write needs `dry_run: false` **and** `confirm` equal to `confirm_to_send`. Missing or different = error, nothing sent. |
| Read-back and diff | After a real write each record is re-read (up to 3 tries, 1.5 s apart, for Halo's eventual consistency) and a field-level diff is returned. `not_applied` lists fields Halo did not take; `unexpected_changes` lists fields that changed without being asked. `verified: true` means every record read back with the requested values. |
| Audit log | Every real write, failed ones included, is written to KV `HALO_AUDIT`: time, tool, method, path, record ids, body, HTTP status, and the record as it was before (the rollback copy). No binding = no write. Secret-looking fields are redacted. Read it with `get_billing_audit`. |
| Bulk limit | `HALO_BULK_MAX` records per call (20; the code never allows more than 50). 20 is what fits the free plan's 50 outbound calls per request, since each record is read before and after. |
| Small answers | Invoice lines are shown as a summary (id, item, quantity, price). `full: true` returns everything. The body **sent** always carries every field. |

`confirm` formats:

| Write | confirm |
|---|---|
| Update one record | `/RecurringInvoice/-143` |
| Update several | `/RecurringInvoice/-143,-138` (ids in the order given) |
| Create | `/RecurringInvoice` |
| One line | `/RecurringInvoice/-143/lines/1505` |
| Delete | `/Invoice/902` |
| Settings | `/Control` |
| Generate an invoice | `/RecurringInvoice/process/-143` |

### Config (`wrangler.jsonc` vars)

| Var | Value now | Meaning |
|---|---|---|
| `HALO_WRITE_PATHS` | `/RecurringInvoice,/RecurringInvoice/process,/ClientContract,/Client,/Item,/SoftwareLicence,/Pax8Details,/Control,/Invoice` | Collection paths that accept POST. Anything else is refused. Empty or missing = nothing allowed. |
| `HALO_DELETE_PATHS` | `/RecurringInvoice,/Invoice,/SoftwareLicence` | Collection paths that accept `DELETE /{id}`. Narrower than the write list on purpose (no client, item or contract deletes). |
| `HALO_CONTROL_KEYS` | `autocreaterecurringinvoices,autosendemailforautorinvoices,automaticallysendinvoiceemails,enableinvoiceapprovals,mergerecurringinvoices` | The only `/Control` keys that may be written. |
| `HALO_CONTROL_WRITES` | `dry_run_only` | `enabled` allows real `/Control` writes. See "Not verified yet". |
| `HALO_BULK_MAX` | `20` | Records per call. |
| KV `HALO_AUDIT` | `f411c09823be41d49a5e977e22e2d6e9` | Namespace `halopsa-mcp-halo-audit`, created by wrangler on the 2026-11-27 deploy (version `f69a76b8`). |

The contract path on this tenant is `/ClientContract` (the same path `get_contract` reads).

### Hard blocks (no config can lift these)

- Paths containing agent, application, auth, role, keyvault, token, credential, password, secret or webhook.
  That covers `/Agent`, `/Roles`, `/Application`, `/KeyVault`, `/MailboxCredential`, `/Webhook` and the like.
- Any body with a secret-looking field name (secret, password, token, apikey, credential, `_exchangecode`,
  `code_verifier`). This is what keeps `/Pax8Details` writes to its settings and away from its credentials.
- `DELETE` of an invoice that is `posted` or has a `qboid`. The message says to void it in QuickBooks.
- `/Control` keys outside `HALO_CONTROL_KEYS`, and `/Control` sub-paths (`/Control/setup`, `/Control/UpdateEnc`:
  not in the path list).
- An update whose `id` does not exist (it would silently become something else).

### Tools

All take `dry_run` (default true), `confirm` and `full` unless noted.

| Tool | Parameters | What it does |
|---|---|---|
| `halo_api_post` | `path`, `body` (object or array) | Generic POST to a configured path. An object with an existing `id` is an update, without one a create. A `lines` array is sent exactly as given, so use the line tools for recurring invoice lines. |
| `halo_api_delete` | `path`, `id` | Generic `DELETE {path}/{id}` on a configured delete path. No undo; the record is kept in the audit entry. |
| `set_recurring_invoice_active` | `ids[]`, `active` | Sends `{id, disabled: !active}` per template. Lines are not sent. |
| `create_recurring_invoice` | `client_id`, `contract_id?`, `fields?`, `lines?`, `active?` | Creates a template, **disabled** unless `active: true`. |
| `update_recurring_invoice` | `id`, `fields?`, `lines?`, `replace_all_lines?` | Header fields, and optionally the whole line set. `lines` must be the complete set and needs `replace_all_lines: true`; the dry run names every existing line left out. Existing lines go back whole with your changes on top. |
| `update_recurring_invoice_line` | `invoice_id`, `line_id`, `fields` | Changes one line. Reads the full line set, applies the change, sends the complete set. |
| `update_contract` | `id`, `fields` | POST `/ClientContract`. |
| `update_client` | `id`, `fields` | POST `/Client`. |
| `update_item` | `id`, `fields` | POST `/Item`. |
| `upsert_software_licence` | `client_id`, `id` or `name`, `count?`, `item_id?`, `fields?` | By `id`: update (refused if the licence belongs to another client). By `name`: exact name match for that client; one match = update, none = create, several = error. |
| `update_halo_settings` | `settings` `{key: value}` | `/Control`, allowlisted keys only. Compares every setting before and after and lists any other key that changed. Real writes are off until `HALO_CONTROL_WRITES` is `enabled`. |
| `create_invoice_from_recurring` | `recurring_invoice_id` | `POST /RecurringInvoice/process` with `[id]`. The dry run shows the template and the auto-send settings. See "Not verified yet". |
| `get_billing_audit` | `limit?` (10, max 20), `key?` | Read-only. Newest first; `key` returns one entry in full with the before-copy. |

Recurring invoice template ids are **negative** in this tenant (for example `-138`).

### What was checked, and how

Checked against the tenant's own swagger (`/api/swagger/v2/swagger.json`, read 2026-11-27) and read-only calls:

- The API application's agent is Allie (id 17), an API agent with `Administration: true` and
  `BillingDetail_Level: 3`; the token is requested with scope `all` and Halo grants it.
- `POST /RecurringInvoice`, `/Invoice`, `/ClientContract`, `/Client`, `/Item`, `/SoftwareLicence`, `/Pax8Details`
  and `/Control` all take a JSON array. `DELETE /{path}/{id}` exists for each except `/Control`.
- `disabled` is a real field on the recurring invoice record (`InvoiceHeader`), and the one the list shows.
- `POST /RecurringInvoice/process` takes an array of integer ids.
- All five `/Control` keys exist and are readable (`/Control` has about 4,400 keys).

### Not verified yet (each needs one approved write)

One write has been made so far (item 2). These are the open questions, and the tools are built so
the answer cannot cause damage either way:

1. **Does a POST with `lines` replace the line set or merge into it?** Unknown. Every line tool sends the complete
   set, which is right under both. What differs is removal: if Halo merges, leaving a line out does not delete it,
   and the read-back diff will show the line still there. Test: on a disabled template, `update_recurring_invoice`
   with the full set minus nothing (a no-op), then a one-line quantity change and back.
2. **Does a header-only POST (`{id, disabled}`) leave lines and other header fields alone?** **Yes, verified
   2026-11-27** on `-143` (audit `audit:8204177461935:2842mg`): HTTP 201, both lines and every header field
   unchanged; Halo itself changed only `last_modified`, `change_seq` (1 to 2) and `last_change_agent` (17, the API
   agent). Halo answers a successful POST with 201, not 200.
3. **Is `disabled` the field Halo honors on POST?** It is the field Halo returns. Proven only by flipping a
   template and reading it back; the approved no-op on `-143` does not prove it.
4. **Does a POST to `/Control` with only the changed keys leave the other settings alone?** Unknown, so real
   writes are off (`HALO_CONTROL_WRITES`). Test once approved: set it to `enabled`, send one allowlisted key at its
   **current** value, and check `other_keys_changed` is empty. If it is not, set it back to `dry_run_only` and do
   not use the tool.
5. **`create_invoice_from_recurring`.** The endpoint exists; what it does with one id (schedule, emailing,
   QuickBooks sync, a disabled template) has not been observed. Today `autosendemailforautorinvoices` is true, so
   assume a generated invoice may be emailed.
6. **`create_recurring_invoice`.** Not exercised. Which line fields Halo needs on a new template is unconfirmed.

Record the answers here as they come in.

## halo_api_get: fields and paging

`halo_api_get` cut answers at 60,000 characters, which made `/RecurringInvoice` and `/Control` unreadable.

- `fields`: comma-separated field names kept by the Worker, for one record or every row of a list (also inside
  Halo's `{record_count, <rows>: [...]}` wrapper). A dotted name reaches into a nested object or list:
  `id,client_name,disabled,lines.id,lines.qty_order`. With `fields` the answer is compact JSON.
- `page_no`, `page_size`: set Halo's `pageinate=true` and pass through (Halo's maximum page size is 100).
  Everything in `params` is passed through unchanged, as before.
- An answer that is still cut says how long the whole one was.

Examples:

```json
{ "path": "/Control", "fields": "autocreaterecurringinvoices,mergerecurringinvoices" }
{ "path": "/RecurringInvoice", "fields": "id,client_name,disabled,total", "page_no": 1, "page_size": 100 }
{ "path": "/RecurringInvoice/-143", "fields": "id,disabled,lines.id,lines.item_shortdescription,lines.qty_order,lines.unit_price" }
```

Note: `halo_api_get` **is** in Allie's resolver allowlist (`mcp__Halo__halo_api_get` in `Upstream.g.cs`), so she
can read any Halo path, billing included. Its old description said otherwise.
