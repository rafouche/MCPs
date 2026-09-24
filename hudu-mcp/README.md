# hudu-mcp

Hudu documentation for the HelpDeskAgent resolver, served from Hudu's REST
API with an API key. Hudu's own hosted MCP endpoint accepts only an OAuth
sign-in, which expires on an unattended server; an API key does not.

**Drop-in for Hudu's hosted MCP.** Tool names and arguments match it, so
register this Worker under the same name, `HUDU`, and the resolver's
`mcp__HUDU__*` allowlist and prompt keep working unchanged.

URL: `https://hudu-mcp.young-math-a33a.workers.dev/mcp`

## Secrets

Set both in Cloudflare (Workers & Pages > hudu-mcp > Settings > Variables and
Secrets, type Secret) or with `npx wrangler secret put <NAME>` in this folder:

| Secret | Value |
|---|---|
| `HUDU_API_KEY` | Hudu > Admin > API Keys |
| `MCP_AUTH_TOKEN` | a long random string; the same value goes in the MCP registration's `Authorization: Bearer` header |

Until both are set, `/mcp` answers 503 for every call: unlike the other
Workers this one fails closed, because Hudu holds client network and
credential documentation. `/health` reports `configured: true|false`.

`HUDU_BASE_URL` is a plain var in `wrangler.jsonc`.

## Tools

company_index/show, article_index/show/create/edit, article_semantic_search,
article_folder_index/show, asset_index/show/create/edit,
asset_layout_index/show, process_index/show, run_index/show, label_index,
label_type_index, activity_logs_index, public_photo_show, plus `healthcheck`
and `hudu_api_get` (GET any REST path).

Differences from the hosted server:

- `article_semantic_search_tool` is keyword-ranked: the whole phrase and
  each significant word are searched, results ranked by hits.
- Paging reports `page`, `per_page`, `returned`, `has_more` (REST gives no
  totals).
- `activity_logs_show_tool` is not available over REST.
- ListSelect values are returned as item names, not internal list ids.

## Secrets are never returned

- Password-type asset fields come back with `value: null, redacted: true`.
- Any `password`/`otp_secret`/`api_key`-style key is replaced with `[redacted]`.
- Free text (article bodies, RichText fields) has the value after a
  secret-looking label replaced: "Shared Secret: x" becomes
  "Shared Secret: [redacted]". Testing found a VPN shared secret stored in a
  plain article.
- `hudu_api_get` refuses the password endpoints.
- `asset_edit_tool` refuses assets whose layout has a password field.

## Tested (2026-09-24)

Every read tool against altecusa.huducloud.com; wrong token (401); password
field nulled on a Cloud Accounts asset; secret redacted in an article
snippet; article and Firewalls asset created, edited (other fields kept -
Hudu's update leaves unsent fields alone) and deleted.
