# pax8-mcp

MCP tools over the **Pax8 Partner REST API** (`api.pax8.com`), plus a
read-only raw REST passthrough at `/api/pax8/*` for the wallboard. It does not
use Pax8's own hosted MCP server: the REST API covers more than Pax8's MCP, and
this Worker is built on it on purpose.

One credential for everything: an OAuth2 client-credentials token from
`https://api.pax8.com/v1/token` (Pax8's documented endpoint). Pax8 caches that
token server-side and hands every caller the same one until near its 24h
expiry, so Worker isolates don't each mint their own. Never use
`login.pax8.com/oauth/token`: minting a token there per isolate is what Pax8
flagged on 2026-11-11 (~770 tokens/day).

## Secrets

| Secret | From |
|---|---|
| `PAX8_CLIENT_ID` | app.pax8.com > Partner Portal > Company > API (create an API client) |
| `PAX8_CLIENT_SECRET` | same place |
| `MCP_AUTH_TOKEN` | optional inbound bearer token, see below |

Roger sets secrets in the Cloudflare dashboard (Worker > Settings > Variables
and Secrets, type Secret). `PAX8_MCP_TOKEN` is not used by anything and can be
deleted from the Worker.

## Tools

Tool names and argument names match the ones Pax8's hosted MCP used, so
mcp-gateway's allowlist and existing prompts keep working. Everything is
read-only; nothing can order. Anywhere a tool takes `companyId`, a company
**name** works too (partial match; it errors with the candidates if more than
one company matches).

| Tool | Pax8 API |
|---|---|
| `pax8-list-companies` | `GET /v1/companies` (`company_name` is matched here, since Pax8 has no name search) |
| `pax8-get-company-by-uuid` | `GET /v1/companies/{id}` (+ contacts with `include_contacts`) |
| `pax8-list-company-contacts` | `GET /v1/companies/{id}/contacts` |
| `pax8-list-products` | `GET /v1/products` (`search` matches name, vendor, SKU, ID) |
| `pax8-lookup-product` | `GET /v1/products/{id}` or `GET /v1/products?search=` |
| `pax8-get-product-by-uuid` | `GET /v1/products/{id}` |
| `pax8-get-product-ordering-requirements` | `GET /v1/products/{id}/provision-details` + `/dependencies` |
| `pax8-get-product-pricing-by-uuid` | `GET /v1/products/{id}/pricing` (optional `companyId`) |
| `pax8-list-subscriptions` | `GET /v1/subscriptions` (status defaults to Active; `All` for every status) |
| `pax8-get-subscription-by-uuid` | `GET /v1/subscriptions/{id}` (+ `/history` with `include_history`) |
| `pax8-list-orders` | `GET /v1/orders` |
| `pax8-get-order-by-uuid` | `GET /v1/orders/{id}` |
| `pax8-list-quotes` | `GET /v2/quotes` (paged with `limit`, not `size`) |
| `pax8-get-quote-by-uuid` | `GET /v2/quotes/{id}` (+ `/sections` with `include_sections`) |
| `pax8-list-invoices` | `GET /v1/invoices` |
| `pax8-get-invoice-by-uuid` | `GET /v1/invoices/{id}` (+ `/items` with `include_items`) |
| `pax8-list-draft-invoice-items` | `GET /v1/invoices/draftItems` (upcoming invoice) |
| `pax8-search-invoice-line-items` | `GET /v2/finance-reports/invoices` (needs `invoiceDate`, a date range or `invoiceNumber`) |
| `pax8-get-usage-summary` | `GET /v1/subscriptions/{id}/usage-summaries` |
| `pax8-get-detailed-usage-summary` | `GET /v1/usage-summaries/{id}/usage-lines` (one `usageDate` per call) |
| `pax8_api_get` | any GET path; `/v1` unless the path starts with `/v1/` or `/v2/` |

Gone compared with Pax8's hosted MCP, because they only exist there:
`get-pax8-help-documents`, `pax8-semantic-search-product` (use
`pax8-list-products` with `search`) and `pax8-get-hitl-result`.
`pax8-submit-order` was never allowed.

Endpoint reference: devx.pax8.com/reference. Lists are 0-based `page` and
`size` (max 200). Every tool error carries Pax8's real HTTP status and body.

## Routes

- `POST /mcp` - MCP JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`, batches)
- `GET /mcp`, `DELETE /mcp` - 405 (no event stream)
- `GET /api/pax8/*` - raw REST reverse-proxy to `api.pax8.com/v1/` (GET/HEAD only; the wallboard uses it)
- `GET /health` - health check

## Deploy

Deploys go through GitHub: pushing a change in this folder to `main` runs
`.github/workflows/deploy.yml`. Never `wrangler deploy` from a local checkout.

## Test commands (CMD)

```cmd
curl https://pax8-mcp.young-math-a33a.workers.dev/health
curl -X POST https://pax8-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"pax8-list-companies\",\"arguments\":{\"size\":3}}}"
curl "https://pax8-mcp.young-math-a33a.workers.dev/api/pax8/companies?size=2"
```

PowerShell quoting is unreliable for JSON bodies; use cmd.exe.

## Inbound auth (MCP_AUTH_TOKEN)

Follows the repo's standing rule (`CLAUDE.md`, "STANDING RULE: inbound auth
for every Worker"). Set `MCP_AUTH_TOKEN` as a Cloudflare **Secret**;
`wrangler.jsonc` has `"keep_vars": true` so a deploy never removes it. Once
set, every request needs `Authorization: Bearer <token>` except `/health` and
the read-only `/api/pax8/*` passthrough, which the wallboard polls without a
token. Until it's set the Worker accepts any caller.
