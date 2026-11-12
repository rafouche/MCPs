# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of independent Cloudflare Worker MCP servers, each exposing one IT/MSP vendor's API (RMM, PSA, networking, identity, M365, etc.) as an MCP connector for Claude. There is no root build system, monorepo tool, or shared package — every `*-mcp/` folder is deployed and versioned independently.

Account workers.dev subdomain used throughout: `young-math-a33a` (e.g. `https://meraki-mcp.young-math-a33a.workers.dev`).

This repo is pushed to `https://github.com/rafouche/MCPs` (branch `main`) — that's the source of truth going forward, not just a local backup. Pull/check against `origin/main` before assuming the local checkout is current, and push after committing rather than treating local commits as sufficient on their own.

A NOC-style wallboard dashboard (`dashboard.html`) polls several of these workers' `/status` routes for a status display, but it lives in its own separate repo now — `https://github.com/rafouche/Dashboard` — since it isn't itself an MCP server, just a consumer of these workers' data. See that repo for its own docs.

## Projects

| Folder | Vendor | Pattern | Notes |
|---|---|---|---|
| `meraki-mcp` | Cisco Meraki | tool-implementation | also exposes `/licenses`. Added full MV camera management coverage against Meraki's Dashboard API v1 camera surface: device-level video/RTSP settings, quality & retention (incl. profile assignment), MV Sense (person/vehicle detection, object detection models), custom analytics, live snapshot generation, video links, and MV Sense zone analytics (live/overview/recent/zone history); network-level recording schedules, wireless profiles (MV2), and quality/retention profiles (full CRUD); and org-level onboarding statuses, camera roles/permissions, MV Sense boundary (area/line) config by device, and cross-org detection history. The org-level `get_org_camera_detections_history` tool's `ranges` param (array of `{startTime,endTime,interval}`) is forwarded as a single JSON-encoded query string - the exact array-of-objects query encoding Meraki expects isn't confirmed against a live call, so verify before relying on it (if it 400s, Meraki likely wants indexed params like `ranges[0][startTime]=...` instead). Everything else in this addition maps 1:1 to documented Meraki camera endpoints and request/response shapes. |
| `halopsa-mcp` | HaloPSA (PSA/ticketing) | tool-implementation | feeds Dashboard's Tickets zone. `list_tickets` now also accepts `agent_id` (HaloPSA's own `/Tickets` single-agent filter, confirmed against the live HaloPSA REST API v2 swagger spec), forwarded straight through — added because a caller (the HelpDeskAgent triage bot in `rafouche/HelpDeskAgent`) was relying on `count`/`open_only` alone with no `agent_id`, which returns an account-wide list capped at `count` (default 20, and larger values like 30/100/500 already exceed a typical MCP caller's own response-size limit given each ticket row carries its full body text). A ticket that goes quiet can silently fall outside that window even though it's genuinely open and assigned - `agent_id` lets a caller ask for a specific agent's (or HaloPSA's real "Unassigned" agent's) tickets directly instead of hoping they're still inside the last `count` by recency. Also added `pageinate`/`page_no`/`page_size` (HaloPSA's own real pagination, confirmed in the same swagger spec - `page_size` capped at 100 by HaloPSA itself) for when even one agent's ticket count is too large for one response - untested against a live tenant so far, so the actual safe `page_size` (given this MCP server's own response-size limit and that each row carries full body text) isn't confirmed yet; start small and verify before relying on a specific number. No `team`/`status` array filters added - HaloPSA's swagger types those as a bare `string` (not `array`), meaning the wire format is an encoded-array string whose exact shape (JSON-array text vs. something else) isn't documented and wasn't verified against a live call before this fix shipped - don't add them without testing against a real tenant first. `update_ticket` now also accepts `client_id`/`user_id` to re-link a ticket to a different client/contact (confirmed against the live swagger spec's `Faults` schema - the same POST `/Tickets` body used for create and update), and `list_contacts` now accepts `search_phonenumbers` (confirmed against `/Users`' own documented parameter) to match a caller's phone number against existing contacts rather than name/email alone - both added for HelpDeskAgent's voicemail-ticket-reassociation use case, forwarded straight through, not yet tested against a live tenant. `list_agents`' `include_inactive` originally sent `includeinactive=true`, which isn't a real parameter on `/Agent` at all (that's the convention for `/Client`/`/Users`, not `/Agent`) — silently ignored by HaloPSA, confirmed live (identical 7-agent result with and without the flag). Fixed to send the real parameter, `includedisabled` (confirmed against the live swagger spec), verified live — surfaces 3 actually-disabled agents that were previously invisible. Separately, added `include_api_agents` (`includeapiagents` on `/Agent`, also confirmed against the live swagger spec) — API-only agents (no interactive login; this tenant has 3: `halointegrator`, `Huntress`, and a human staff member's identity, Cynthia Hicks, provisioned as API-only) are a **distinct** category from disabled agents on HaloPSA's own endpoint, not a subset — an API-only agent is not necessarily disabled and vice versa, so `include_inactive` alone can never surface one. Both flags verified live together (7 → 13 agents). |
| `cipp-mcp` | CIPP (M365 via CIPP) | tool-implementation | feeds Dashboard's Security zone. Points at the CyberDrain-hosted "CIPP-NG" instance `https://cipp.altecusa.com` (client-credentials against a dedicated, non-MCP-flagged CIPP-API client — separate from CIPP's own native MCP feature). Beyond its ~33 named tools it also exposes generic `cipp_api_get`/`cipp_api_post` tools that call any CIPP endpoint by name (see the file header comment in `cipp-mcp/src/index.ts`), giving it full read/write coverage of CIPP's API without one hand-written tool per endpoint — this is why the native CIPP MCP connector was retired in favor of this worker. Five named tools called endpoints that don't exist or need a parameter they never sent, found 2026-09-28 from ticket #22821 and verified against the live instance: `list_sharepoint_sites` and `list_onedrive_usage` are both `ListSites` with `Type` = `SharePointSiteUsage` / `OneDriveUsageAccount` (no `Type` = 400, `ListOneDriveUsage` = 404); `list_user_licenses` is built from `ListUsers`' `LicJoined` (`ListUserLicenses` = 404); `list_standards` combines `listStandardTemplates` (filtered to the tenant) with `ListStandardsCompare` (`ListStandardsRun` = 404); `list_intune_policies` is `ListIntunePolicy` `type=Policies` (`ListIntuneTemplates` is CIPP's own template library, not the tenant's policies). When adding a named tool, call its endpoint once through `cipp_api_get` first. |
| `m365-mcp` | Microsoft Graph (direct, multi-tenant) | tool-implementation | not yet wired into Dashboard |
| `jumpcloud-mcp` | JumpCloud directory | tool-implementation | **Being retired (Roger, 2026-09-30)** - removed from HelpDeskAgent in v2.15.7; **the `jumpcloud-mcp` Worker no longer exists on Cloudflare** (checked 2026-11-12); removed from mcp-gateway the same day, and the deploy workflow skips this folder so a push cannot bring it back. OAuth2 Service Account, org-scoped only — not yet wired into Dashboard. Contains a fully duplicated nested project at `jumpcloud-mcp/jumpcloud-mcp/` (own `wrangler.jsonc`/`src`/`package.json`, currently identical to the outer one) — treat the outer `jumpcloud-mcp/src/index.ts` as canonical and confirm which copy you're editing before making changes |
| `ninjarmm-mcp` | NinjaRMM | tool-implementation | feeds Dashboard's Network zone (individually-tracked devices). `ninja_api_get` raw read tool; script runs need the user-context token from `/oauth/start` (see below) |
| `gworkspace-mcp` | Google Workspace | tool-implementation | uses a service-account JSON key file in-folder |
| `gchannel-mcp` | Google Cloud Channel (Partner Sales Console) + Admin SDK, multi-tenant | tool-implementation | 2026-10-01. Google counterpart of cipp-mcp: every tool takes `tenant` (domain, C0... customer ID, or name). One service account key with domain-wide delegation reaches both Channel Partner customers (impersonating `GOOGLE_RESELLER_ADMIN_EMAIL`, customer addressed by its `cloudIdentityId`; customers listed via the Channel API under `CHANNEL_ACCOUNT_ID`, cached 5 min) and standalone tenants not in the Partner portal (`GOOGLE_TENANTS` JSON secret; each tenant authorizes the same client ID in its own Admin console; a standalone match wins over a Channel match). Tokens request only the scopes each call needs, so a tenant that authorized a subset still works for those tools. Channel/billing side is read-only by design (no ordering/entitlement changes); no user delete. Fails closed like hudu-mcp. Not yet verified with live credentials - see its README for the setup steps, full scope list, and the open questions (Alert Center/Reports on Channel customers via the reseller admin). |
| `3cx-mcp` | 3CX v20 phone systems, multi-client | tool-implementation | 2026-10-05, Worker `threecx-mcp` (first deploy - the old `TCX_SERVERS` version was never deployed). Client list = Hudu: every non-archived "Api secrets" asset (`HUDU_SECRETS_LAYOUT`) whose name contains 3CX, named `<Client> 3CX API - https://<pbx>/` with Client ID / Client Secret fields; cached 5 min. No per-client Cloudflare secret, no deploy to add a client. Every tool takes `client` (key, name, company or host). Full API coverage from `src/catalog.json`, generated from 3CX's own OpenAPI spec (`spec/swagger.yaml`, build 20.0.10.1621, 603 ops; `npm run catalog`): `tcx_find_endpoints`/`tcx_describe_endpoint`/`tcx_describe_schema` browse it, `tcx_call` runs any operationId and writes the OData URL (typed literals, aliases); `tcx_api_get`/`tcx_api_request` raw. 3CX allows ONE active token per API client (Peplink trap), so tokens are shared in KV `TCX_TOKENS` (489712bfbd99493bbb6c240f337a59b1) with the same 401-retry rule. Fails closed (503 until `MCP_AUTH_TOKEN` and `HUDU_API_KEY` are set). Redacts password/PIN/secret-named fields. Verified live 2026-10-05 against Altec (altec.mo.3cx.us, 20.0.9.995): users, queues+agents, trunks, event logs, health, call log, abandoned-queue report. 3CX report functions reject `null` for optional strings (send `''`), the call log needs time filters `'0:00:0'`; `CallHistoryView` is legacy (stops 2025-06, date filter 500s) so there is no tool for it; Hudu `/asset_layouts` is paged (look up by name). See its README. |
| `peplink-mcp` | Peplink InControl2 | tool-implementation | also exposes `/licenses`. InControl2 seems to honour only the newest client_credentials token for the API client, so isolates minting their own tokens invalidate each other (confirmed 2026-10-01: `/status` alternated between full data, an org silently missing, and a whole 401 `invalid_accessor`). The token now lives in KV namespace `PEPLINK_TOKENS` (id db180c4f2ba0477e9d36e658fd7861d3), shared by every isolate; `ic2Get` retries a 401 up to twice and only mints a new token if KV still holds the rejected one. `/status` and `/licenses` make ONE `GET /rest/o/{org}/d` per org (each device carries `group_id`/`group_name`) instead of a call per group: the "ASG Direct Clients" org holds one group per client (47 groups), and the per-group fan-out kept failing and silently dropping that whole org. An org whose devices span more than one group becomes one tile per group, named after the group (decided from the data, nothing hardcoded); single-group orgs keep the org name. Verified 2026-10-01: 46 tiles / 155 devices, 10/10 identical under concurrent `/status` + `/licenses` load. |
| `unifi-mcp` | UniFi | tool-implementation | |
| `hudu-mcp` | Hudu documentation | tool-implementation | 2026-09-24. Drop-in for Hudu's hosted OAuth MCP (same tool names) over Hudu's REST API with an `x-api-key`; `HUDU_BASE_URL` https://altecusa.huducloud.com. Fails closed without `MCP_AUTH_TOKEN`, redacts passwords and secret-looking text, refuses password endpoints, edits send only changed fields. Registered as `HUDU` in HelpDeskAgent. **Redaction by label and asset type (2026-10-05):** asset 6321 (layout 32, asset_type "Api secrets") returned its "Client Secret" Text field in clear, because only Password/ConfidentialText field types were nulled. `redact()` now also nulls (`value: null, redacted: true`) any field whose label looks secret (secret, password, passphrase, passcode, PIN, API/access/private key, token, PSK, OTP, credential, connection string) unless the label is an ID, date/expiry, URL, name or username; and on an asset whose `asset_type` or layout name contains secret/credential/api key, every field except IDs ("Client ID", "Tenant ID") and dates/expiry. It runs on every response via `safe()`, so asset_index_tool, asset_show_tool, create/edit results, hudu_api_get `/assets`, `/companies/{id}/assets[/{id}]` and searches all get it; verified live on 6321 through each (version 9b033729). License/product keys are not treated as secret. asset_edit_tool's refusal is still password-type only. See its README and the section below. |
| `huntress-mcp` | Huntress EDR | **passthrough gateway** | plain JS, not TS. `/api/huntress/*` is read-only (405 on writes) |
| `pax8-mcp` | Pax8 billing/provisioning | tool-implementation | plain JS, not TS. **Rebuilt 2026-11-12 as tools over the Pax8 REST API** (Roger: it was always meant to be a direct-API MCP, because the API covers more than Pax8's own MCP). Until then `/mcp` was actually a relay to Pax8's hosted MCP (`mcp.pax8.com`), which is why the 2026-11-11 token fix broke it: that server refuses REST API tokens. 21 read-only tools (no ordering): the Pax8-MCP tool and argument names the gateway allowlist uses (`pax8-list-companies`, `companyId`, `billingTerm`, `invoiceDate`, ...), plus `pax8-list-company-contacts`, `pax8-list-draft-invoice-items` and the raw `pax8_api_get`. Dropped (only existed on Pax8's MCP): `get-pax8-help-documents`, `pax8-semantic-search-product`, `pax8-get-hitl-result`. `companyId` also takes a company name (matched against the full company list, cached 5 min; Pax8's `/companies` has no name search). `/v1` for companies/contacts/products/subscriptions/usage/orders/invoices, `/v2` for quotes and the invoice line-item finance report (`pax8-search-invoice-line-items`); endpoint table in its README. **One credential:** `PAX8_CLIENT_ID`/`PAX8_CLIENT_SECRET` -> token from `api.pax8.com/v1/token` (Pax8's documented endpoint, cached server-side, same token for every caller until near its 24h expiry), used by both `/mcp` and the wallboard's read-only `/api/pax8/*`; a 401 refreshes once and retries once. **Never use `login.pax8.com/oauth/token`:** Pax8 flagged this client (`hrUIlCVE3KNaWwnoGaqbdq2CaJ7HtWpK`) on 2026-11-11 for ~770 tokens/day minted there, one per cold isolate. `PAX8_MCP_TOKEN` is unused and can be deleted from the Worker. Deployed 2026-11-12 as version `f952a2b3` (91fe890, from a fresh clone before the deploy secret existed). Verified live: all 21 tools return data (company by name, subscriptions, orders, quotes on `/v2`, invoices with items, draft items, the `/v2` finance report with facets, `pax8_api_get` on `/v1` and `/v2`); `pax8-get-detailed-usage-summary` is untested because no subscription had usage summaries yet. `/api/pax8/companies` 200, GET `/mcp` 405. A 403 "User does not have permission to access company" comes from Pax8 for orders of a company the API client can no longer see (seen on a 2025 order), not from the Worker. mcp-gateway exposes 20 of the 21 tools (all but `pax8_api_get`, per its no-raw-escape-hatch rule); `readTools` updated 2026-11-12. |
| `mcp-gateway` | Altec MCP Gateway (front door for third-party chatbots) | **OAuth gateway** | 2026-11-12 into the repo. `https://mcp-gateway.altecusa.com` (custom domain only). OAuth 2.1 with Entra sign-in (`@cloudflare/workers-oauth-provider` 1.2.1) for claude.ai/ChatGPT/Grok, proxying `/<key>/mcp` to the backend Workers **read-only**: `tools/list` is filtered to each backend's exact `readTools` in `servers.json` and any other tool is refused. Each backend needs the `MCP.ReadOnly`/`MCP.Admin` app role plus its own (e.g. `MCP.Hudu`); token-protected backends get their `MCP_AUTH_TOKEN` from the gateway secret `UPSTREAM_<X>_TOKEN`. Deployed by upload on 2026-10-05 with no source anywhere; the source was rebuilt from the live bundle (dry-run build identical apart from whitespace), so it is plain JS. Backends: 3cx, halo, ninja, huntress, meraki, peplink, unifi, gws, plus hudu, cipp, pax8, m365, gchannel (added 2026-11-12); JumpCloud removed. When adding a tool to a backend, it stays hidden behind the gateway until its name is added to `readTools`. See its README. |
| `teams-meeting-notes-worker` | Microsoft Graph + Teams + Claude API | **webhook automation** | not an MCP tool server — no `TOOLS`/`runTool`, no `/mcp` endpoint. Receives Graph change notifications when a Teams meeting transcript is ready, summarizes it via the Claude API, and posts to a Teams channel via Incoming Webhook. Plain JS, not TS. See its own README for the full secrets list and setup flow. |

## Deploys go through GitHub, never from a local machine (Roger, 2026-11-12)

Pushing to `main` runs `.github/workflows/deploy.yml`, which deploys every top-level folder with a wrangler config that the push changed (wrangler 4.94.0). Untouched folders are not redeployed, and `jumpcloud-mcp` is skipped. Actions > Deploy Workers > Run workflow deploys one folder by name. It needs the repo secret `CLOUDFLARE_API_TOKEN` (set 2026-11-12: a token from the "Edit Cloudflare Workers" template, scoped to the Altec account and the altecusa.com zone; first manual run deployed pax8-mcp successfully). Never deploy code that is not committed and pushed. If the workflow cannot run yet, deploy from a fresh clone of `origin/main` in a temp folder, then delete the clone. Don't leave copies of Worker code on the machine (live code downloaded for a drift check included). GitHub Actions artifacts and logs are kept for 3 days (repo setting).

## Commands

Every `*-mcp/` project uses the same scripts (run from inside that project's folder — there is no top-level script that operates across all of them):

```bash
npm install          # only needed once per project; m365-mcp currently has no node_modules installed
wrangler dev          # local dev server
wrangler deploy --dry-run --outdir .wrangler/dry-run   # build check only; real deploys go through GitHub (below)
wrangler secret put <NAME>   # set a secret (never put values in wrangler.jsonc); Roger usually sets them in the Cloudflare dashboard
wrangler secret list  # list secret names (not values) on the deployed worker
```

`3cx-mcp`, `cipp-mcp`, `gworkspace-mcp`, `halopsa-mcp`, `meraki-mcp`, and `ninjarmm-mcp` have vitest scaffolding (`test/index.spec.ts`), but in every one of them it's still the unmodified default Cloudflare template "Hello World" test, not real coverage of the worker's actual tool logic:

```bash
npx vitest            # run from inside any of the six projects listed above
```

Type-check a file without deploying (useful when validating a hand-edited/candidate `index.ts` before overwriting the live source):

```bash
npx tsc --noEmit --skipLibCheck ./src/index.ts
```

**Windows shell note (repeated in every project README):** PowerShell's quoting mangles JSON request bodies. Use `cmd.exe`, or pipe from `echo` into curl's `--data-binary @-`, when hand-testing an `/mcp` endpoint from the command line.

## Architecture: two worker patterns

### 1. Tool-implementation workers (most of them)

Each defines, in a single `src/index.ts`:

- An `Env` interface listing the secrets/vars it needs.
- A `TOOLS` array — MCP tool definitions (`name`, `description`, JSON-schema `inputSchema`) — this is what `tools/list` returns verbatim.
- `runTool(name, args, env)` — a big `switch` that dispatches each tool name to a thin API helper (`xGet`/`xPost`/`xPut`/`xPatch`/`xDelete`) and returns a JSON-stringified result string.
- A shared `fetch` handler exposing:
  - `POST /mcp` — JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `ping`); batched array requests are supported.
  - `GET /status` — flattened JSON for the wallboard Dashboard (**not** part of the MCP protocol — a repo-specific addition per project, field shapes are bespoke per vendor).
  - `GET /health` — plain liveness check.
  - Some also add `GET /licenses` (Meraki, Peplink) for expiring-license wallboard data.

When adding a tool to one of these, add it to both `TOOLS` (schema) and the `runTool` switch (implementation) — `tools/list` and `tools/call` are hand-kept in sync, nothing derives one from the other.

**Keep this file current as you go, unprompted.** Whenever a change to any `*-mcp/` project is more than a one-line fix — a new tool, a changed auth/secrets setup, a new external dependency (like `cipp-mcp` pointing at a specific hosted instance), a design decision worth knowing before touching that project again — update its row in the Projects table (or the relevant section below) in the same commit. Don't wait to be asked; treat an undocumented change as an incomplete one.

### 2. Passthrough gateway workers (huntress-mcp; pax8-mcp was one until 2026-11-12)

These don't implement their own `TOOLS`/`runTool` at all. They relay `POST /mcp` JSON-RPC verbatim to the vendor's own hosted MCP server, injecting auth on the way through, and additionally expose a raw REST reverse-proxy at `/api/<vendor>/*`. Written in plain `.js`, not TypeScript, unlike every tool-implementation worker.

## Auth patterns (varies per vendor — check the specific project before assuming)

- **Static API key header**: Meraki, UniFi.
- **OAuth2 client-credentials** (POST to a token endpoint with Basic auth of `client_id:client_secret`, cache the bearer token, retry): JumpCloud, Peplink, Pax8 (JSON body to `api.pax8.com/v1/token`, never `login.pax8.com`), HaloPSA. For JumpCloud specifically, Service Account credentials are org-scoped only — JumpCloud does not currently support a single MSP-wide credential across child orgs (confirmed via their own docs: Service Accounts are "not available for MSP customers" as of this writing).
- **Basic auth passthrough**: Huntress (credentials attached to every proxied request, not exchanged for a token).
- **API key header (`x-api-key`)**: Hudu.
- **OAuth2 client-credentials plus an optional user-context token** (authorization code, for script runs): NinjaOne - see below.

Getting the auth type wrong for a given vendor is the most common cause of "tools/list works but every tools/call fails" — because every tool call in a tool-implementation worker re-derives its token/headers first, one bad credential fails 100% of tools uniformly. The repo convention across every project is to **never swallow API errors**: every `xGet`/`xPost`/etc. helper throws `Error(status + response body text)`, and the top-level `tools/call` catch puts that straight into the JSON-RPC `error.message` — so a real vendor HTTP status and response body should always be visible in the tool result, not a generic message. If a worker isn't doing this, that's a regression, not the intended pattern.

## Inbound auth (MCP_AUTH_TOKEN) — every Worker, opt-in

History: until 2026-09-19 no Worker checked who was calling it; every tool,
write tools included, answered a bare request on the public `workers.dev`
URL. Every Worker's `fetch()` now starts with the same constant-time bearer
check against `MCP_AUTH_TOKEN`. **The current rule (which routes are open,
Secrets only, `keep_vars`, which Workers have it set) is the "STANDING RULE:
inbound auth for every Worker" section below** — follow that, and copy the
same block into any new Worker.

## Secrets

Secrets are per-worker via `wrangler secret put <NAME>` and never appear in `wrangler.jsonc` (some files include a comment block listing expected secret names, but the values themselves must never be committed there). `MCPs.txt` at the repo root (on Roger's machine; not in cloud checkouts) holds plaintext copies of several live API keys/secrets — this is a standing risk, not a documented convention; don't add to it, and flag it if asked to touch credentials in this repo. `MCPs.txt` and `**/altec-mcp-server-*.json` are gitignored, so they won't show up in `git status`/diffs even though they're on disk — don't assume gitignored means absent.

## Replay support in halopsa-mcp: `as_of` on the action-log tools
`get_ticket_time_entries` and `get_ticket_history` take an optional `as_of`
(ISO, Halo time). Actions dated after it are dropped and `human_touch` is
computed over what remains; the response echoes `as_of` and
`actions_hidden_after_as_of`. HelpDeskAgent's replay harness (v2.11.5)
passes it so a ticket is judged as it stood at that moment - without it,
`human_touch.found` is today's answer and a replay of an untouched-at-the-
time ticket stops HUMAN_OWNED. Production never passes it.

## halopsa-mcp: `GET /helpdesk-triage` (HelpDeskAgent's deterministic classifier)
Plain HTTP, no LLM. Query: `team_id`, `agent_id` (required), `tracked_ids`,
`ready_status_id`, `waiting_approval_status_id`, `approved_status_id`,
`history` (default 6), `max_details_chars`, `max_note_chars`. Returns the
classifier prompt's six candidate buckets - unassigned (paged, capped at
100), stuck_claimed, ready_for_ai, waiting_approval, approved, tracked - each
ticket trimmed (`trimTicket`, now including `dateclosed` /
`hasbeenclosed` / `closure_agent_id`) with its most recent actions and a
`recent_human_touch` over that window. The exclusion rules live in the
PowerShell caller, not here; this route only gathers. Read-only.

## Emergency path: halopsa-mcp `escalate_emergency`
The one sending path HelpDeskAgent keeps under -RequireApproval (v2.13.x).
`escalate_emergency` emails the ticket's contact a FIXED template (caller
supplies a summary phrase, max 200 chars, no links), pages on-call, writes
the page text as the audit trail, optionally sets status/agent/team, and
refuses a second run on the same ticket. The page is ONE hidden emailed
action on the same ticket (outcome 16, `emailto`/`emailcc` overrides,
hiddenfromuser true) - Halo does send mail for a hidden action (confirmed
on ticket #22417: email_status 2, dateemailed set). Subject carries the
ticket id; the client never sees it; no second ticket. The older "halo"
(internal alert ticket - rejected by Roger: two tickets for the tech) and
"m365" (m365-mcp send_on_call_alert; no Graph credentials) modes were
removed on 2026-09-21 along with every fixed-recipient var. `page_test:
true` with a scratch ticket_id of ours sends a marked TEST page from that
ticket to whoever it would page right then (current on-call, else the
fallback list; nobody = nothing sent).

Who gets paged is looked up at send time from Halo's own Shifts calendar,
and ONLY from there: `resolveOnCall` GETs `/Appointment` with
`showshifts=true&shiftsonly=true&showall=true` (shifts are appointments of
`type` 4 and are invisible without showshifts; recurring masters are
templates and skipped), keeps the ones whose `shift_type_id` equals
`ON_CALL_SHIFT_TYPE_ID` (default 1 = Halo's stock "On-call" shift type; a
subject containing "on call" also counts) and whose start<=now<end (Halo
times are UTC without a suffix), then reads each agent's email and Mobile
Number (Halo's `sms` field) from `/Agent/{id}`; the text address is the
number's digits (a leading US 1 dropped) at `ON_CALL_SMS_DOMAIN` (default
altec.text.email, Roger's email-to-SMS service), no number = email only.
First agent = `emailto`, the rest + every SMS address = `emailcc`.

**Reworked 2026-11-09 (Roger): page first, acknowledge second, with a
fallback.** Deployed 2026-11-09 (78d5dff, version 9471aa87); live check:
get_on_call showed nobody on shift and the fallback = Roger (agent 28,
email + text, shift ended 2026-11-06 23:00Z). Order in `escalate_emergency`: (1) page the current on-call
(`pageOnCall`); if nobody's shift covers the moment, nobody on it has an
email, or that page fails to post, page the FALLBACK list instead: whoever
had the most recent On-call shift that already ended (`resolvePreviousOnCall`,
14-day lookback; every shift ending at that same moment counts); no previous
shift either = nobody paged. (2) Only then email the client the fixed
acknowledgment, its last sentence chosen from the real result: paged = "our
on-call engineer has been notified and will follow up as soon as
possible"; nobody paged = "our team has been alerted and will respond as
soon as possible" (never a promise of a page that did not happen; never
"escalated"). (3) Nobody paged = the Worker sets priority level
`CRITICAL_PRIORITY_ID` (default 1: "Critical"/"Critial"/"Urgent" on this
tenant's three SLAs) and the follow-up status (`follow_up_status_id` if
passed, else the status named `FOLLOW_UP_STATUS_NAME`, default "Follow Up
Needed"). (4) The private `[EMERGENCY ACK SENT]` note says either way who
was paged (and which list) or every reason nobody was, with
`page=on_call|fallback|none` for the follow-up to read. This replaces the
2026-09-21 rule "nobody on call = nobody paged, no fallback".

`emergency_follow_up(ticket_id)` is called every cycle by AllieService for
each ticket it raised an emergency on (not by the resolver). It does what
is due, once each, marked by `[EMERGENCY REPAGE] stage=...` on the ticket:
`retry` on the next run when nobody was paged (fallback list first, then
the current on-call), `30min` with no human action (current on-call first:
the Critical response target), `60min` (fallback list first). It stops
(`done: true`) once a person acts on the ticket (same rule as human_touch),
the ticket is closed, or the 60-minute page has run. A re-page that reaches
nobody writes a private note that a person must call on-call by hand.
Ack-only retry (2026-11-09, from #24262 where the contact had no email):
when the first call's note says "Client acknowledgment FAILED", a second
`escalate_emergency` call sends only the acknowledgment (worded by the
first call's page result), writes `[EMERGENCY ACK RESENT]`, never pages
again, and works once; the first response carries `ack_retry` telling the
caller to fix the contact and call again.
Tested against a mock Halo: `test/emergency.sim.mjs` (how to run is at its
top). `get_on_call` (read-only, optional `at`) shows the same
resolution and says email+text vs email only; `escalate_emergency` accepts
`at` only with `dry_run`/`page_test`. A Leo-style "Fixed shift"
(shift_type_id 0) never matches. Verified against Roger's test shift
(appointment 19875, 2026-09-22T01:30-02:00Z): `at` inside it resolves to
agent 28 (email only - his record has no mobile number), outside it
resolves to nobody and a real page_test sends nothing. `halo_api_get` is
the read-only raw GET tool this was discovered with; it is not in the
pipeline's allowlist. Worker vars: `ON_CALL_SHIFT_TYPE_ID`, `ON_CALL_SMS_DOMAIN`,
`CRITICAL_PRIORITY_ID`, `FOLLOW_UP_STATUS_NAME` (all optional); the old `ON_CALL_ALERT_URL` secret is unused and can
be deleted from the Worker whenever convenient.

## ninjarmm-mcp: running scripts needs a USER-context token (2026-09-22)
NinjaOne refuses `POST /v2/device/{id}/script/run` to a client-credentials
token - 403 `user_context_required` - for library scripts by id AND for
"Install Application" automations by uid alike. Found on ticket #22484:
the approved Wrike update failed twice with that error, so every "Run
NinjaOne script" whitelist entry had been unrunnable via API since day
one (the earlier claim here that scripts by id run fine was wrong; it was
never exercised). Reads and device-management writes work with either
token. Fix: the Worker now holds a user-context token obtained once by a
person: `GET /oauth/start` (302 to NinjaOne's `/ws/oauth/authorize`,
scopes monitoring management control offline_access, state cookie) ->
`/oauth/callback` exchanges the code at `/ws/oauth/token`
(authorization_code) and stores {access_token, expires_at, refresh_token}
in KV namespace NINJA_TOKENS (id 67d6fba4a3b04ab7a13c1154b9cf8e56);
`getToken()` prefers it, refreshes with grant_type=refresh_token when
under 2 min left, keeps the newest refresh token, records last_error and
falls back to client credentials on failure so reads never stop.
`GET /oauth/status` shows the state without secrets. Requirements on the
NinjaOne client app (Administration > Apps > API > Client app IDs):
platform Web, grants Authorization Code + Refresh Token (+ Client
Credentials for the fallback), scopes monitoring/management/control/
offline_access, redirect URI https://ninjarmm-mcp.young-math-a33a.workers.dev/oauth/callback.
If the existing app is "API Services" it cannot do this - make a new Web
app and rotate NINJA_CLIENT_ID/SECRET (`wrangler secret put`, which the
sandbox classifier blocks - Roger runs it). Script runs then appear in
Ninja as "User <signed-in person> requested start". Also: `/automation/
scripts` never lists Install Application automations; their uid is the
`sourceConfigUid` on ACTION activities, and `script_uid` on the run tools
uses `{type:"ACTION", uid}` (works only with the user token). `ninja_api_get`
is the read-only raw GET tool (not in the pipeline allowlist).

First real run through the API (script 234 "Latest Wrike Desktop Install"
on device 671, 2026-09-22 01:55Z, SUCCESS, 4.6.1.3034 -> 4.6.1.3034) took
three more fixes, all in `scriptRunBody`/`run_script_and_wait`: the run
body's `parameters` is a STRING (an object 400s with "Cannot deserialize
value of type java.lang.String"); `runAs` must be the lowercase `system`
identifier (uppercase SYSTEM is treated as a credential name and the run
fails with "Unable to retrieved credential information" / a
SECURITY_CREDENTIAL_ACCESS_DENIED activity); and runs are logged as
ACTIONSET START_REQUESTED -> ACTION STARTED -> ACTION COMPLETED
(activityResult SUCCESS|FAILURE, full script output in `message`) - there
is no SCRIPT activityType and filtering on one 500s
(InvalidFilterException), so the wait polls unfiltered and matches the
COMPLETED ACTION after the queue time. Roger did the one-time sign-in the
same night (obtained_at 2026-09-22T01:50Z); it needed the redirect URI
added to the NinjaOne client app first (unauthorized_client / Invalid
redirect_uri until then).

**KV write-quota fix (2026-11-11).** `NINJA_TOKENS` showed ~400 reads AND ~400
writes a day on one key (free limit: 1,000 writes). Cause: the stored refresh
token went dead on 2026-10-21 (`/oauth/status` last_error `invalid_token`;
either NinjaOne's refresh-token lifetime or a rotation race), and `getToken`
wrote `last_error` back to KV on every failed refresh, once per cold isolate,
then fell back to client credentials. Now: module-memory cache first (a warm
isolate never touches KV), one KV read per cold isolate, one KV put per real
refresh, a shared in-flight load per isolate, and a failed refresh writes at
most once per hour and only for a 4xx (transient errors write nothing). A lost
rotation race uses the winner's token and never writes a stale record back. A
401 from the API drops the cached token, refreshes once and retries once
(`authedFetch`, skipped if the token was minted under a minute ago). The
record is written WITHOUT `expirationTtl` - unlike peplink's disposable access
token it also holds the refresh token, which a TTL would delete. `/oauth/status`
now reports `user_context_working` and says so when the refresh token is being
rejected. **While the refresh token is dead, script runs fail with
`user_context_required`; a person must sign in again at `/oauth/start`.**

## halopsa-mcp: ticket attachments (2026-10-02)
`list_ticket_attachments` (GET /Attachment?ticket_id) and
`get_ticket_attachment` fetch Halo's signed `s3url` for an attachment. An
image (png/jpg/gif/webp, up to 3.5 MB) comes back as an MCP `image` content
block - `runTool` may now return `{ content: [...] }` instead of a string,
and tools/call passes it through; text files (txt/log/csv/json/xml/html/eml)
come back as text (50K chars); anything else returns metadata only.
`get_ticket_brief` adds `attachments` when `attachment_count` > 0. Read-only.
Why: #22951's real error (AADSTS90072) was only in the screenshot and the
resolver couldn't open it. Deployed version 288d9c09; brief listing verified
live, base64 path verified offline on the #22951 PNG.

## halopsa-mcp `send_approved_draft` - FLOW A in one atomic call
Posts the [DRAFT PENDING APPROVAL] note's own text (after the marker, up
to any [INTENDED ...] line) verbatim as a public emailed reply, collapses
the draft to [APPROVED DRAFT], deletes this pipeline's [PIPELINE NOTE]s,
sets status/agent/team, verifies. Optional `emailto` corrects emailtolist
first; `require_status_id` refuses unless the ticket is in that status;
refuses on 0 or 2+ drafts or an empty draft. It can only send text a human
already approved - never text supplied in the call. `dry_run: true`.
Real incident: #22390's reply sent but its draft never collapsed when
these were separate model-driven steps.


**Collapse keeps internal text (2026-10-01).** The draft note used to be
overwritten with a bare `[APPROVED DRAFT]`, deleting anything else in it -
#22920's findings sat below the `[INTENDED ...]` lines and would have been
erased on approval. `collapsedDraftNote()` (used by `send_approved_draft`
and `mark_draft_approved`) drops only the reply text, which is now in the
real reply, and keeps text above the marker and everything after the last
`[INTENDED ...]` line under the `[APPROVED DRAFT]` trace. `dry_run` shows
`draft_would_become`; the live result reports `draft_kept_internal_text`.
Verified with a dry run on #22920. Roger: findings must never be deleted or
need copying by hand. HelpDeskAgent still tells the resolver to write
findings as their own note (v2.15.12); this is the safety net.
## halopsa-mcp: an agent "Opened" action is not ownership (2026-09-23)

`human_touch` (get_ticket_history, get_ticket_time_entries, the candidate
feed) ignores actions whose outcome is "Opened": an agent opening a ticket
on a client's behalf and leaving it unassigned is not working it. Ticket
#22589: Roger opened it for SJP Law and it sat untouched because his Opened
action counted as a human touch. The opener is reported as
`human_touch.opened_by` / `opened_by_agentid` / `opened_at` instead.
HelpDeskAgent's deterministic classifier applies the same exclusion
(v2.14.3).

## meraki-mcp: `meraki_api_get` raw read tool (2026-09-24)

Roger: "any meraki api should be exposed, at least in read only for
troubleshooting" (a ticket where the resolver said it could not see the
firewall rules it needed). `meraki_api_get` GETs any Dashboard API v1 path
(relative to /api/v1, optional query params, 60K cap) - the same shape as
halopsa-mcp's `halo_api_get` and ninjarmm-mcp's `ninja_api_get`. GET only;
path may not contain `..` or `?`. HelpDeskAgent v2.14.4 allows it for every
resolver tier and the resolver prompt lists the useful firewall/NAT/content
filtering/uplink/switch-port-status paths.

## GET-only raw read tools on every diagnostic Worker (2026-09-24)

Roger: "All MCP's needed for diagnostics should expose all api tools needed
for diagnostics, at least in Read only mode." Each diagnostic Worker now has
a GET-only escape hatch (path must start with '/', no '..' or '?', query
params as an object, 60K response cap):

| Worker | Tool | Reaches |
|---|---|---|
| halopsa-mcp | `halo_api_get` | any Halo API path |
| ninjarmm-mcp | `ninja_api_get` | any NinjaOne v2 path |
| meraki-mcp | `meraki_api_get` | any Dashboard API v1 path |
| cipp-mcp | `cipp_api_get` | any CIPP endpoint by name |
| unifi-mcp | `unifi_api_get` | any Site Manager path on api.ui.com |
| unifi-mcp | `unifi_network_get` | one console's local Network Integration API via the Cloud Connector (`host_id` + path) |
| peplink-mcp | `peplink_api_get` | any InControl2 `/rest/` path |
| jumpcloud-mcp | `jc_api_get` | any JumpCloud v1/v2 path (GET only; `jc_raw_request` still allows every method) |

| hudu-mcp | `hudu_api_get` | any Hudu REST v1 path (password endpoints refused, secrets redacted) |
| pax8-mcp | `pax8_api_get` | any Pax8 Partner API path (`/v1` by default, `/v2/...` for quotes and finance reports) |
| gchannel-mcp | `channel_api_get`, `google_api_get` | any Cloud Channel v1 path (`{account}` substituted); any Directory/Reports/Licensing/Alert Center path in a tenant (`{customer}` substituted) |

huntress-mcp proxies Huntress's own MCP server, whose tools are read-only
already. hudu-mcp (new, 2026-09-24) replaces Hudu's hosted MCP, which takes
only an OAuth sign-in that kept expiring on the server: same tool names over
the REST API with an API key, fails closed until HUDU_API_KEY and
MCP_AUTH_TOKEN are set, and redacts secrets (password fields, secret-named
keys, "Password: x"-style text in articles). See hudu-mcp/README.md. unifi-mcp and peplink-mcp ship an older wrangler that
fails on `/memberships` with this token; deploy them with
`../meraki-mcp/node_modules/.bin/wrangler deploy`.

## halopsa-mcp: /helpdesk-gate fingerprints Ready for AI and AI Approved (2026-09-24)

`/helpdesk-gate` takes optional `ready_status_id` and `approved_status_id`
and returns `ready_for_ai` / `approved` lists of `{id, last_action_date}`
for those statuses (Help Desk team, open). Without the params the response
is unchanged. Ticket #22609 (assigned to Michael, set to Ready for AI) was
invisible to the gate once untracked, so HelpDeskAgent skipped every cycle
as "nothing changed" (fixed in HelpDeskAgent v2.15.2).

## halopsa-mcp: approved drafts read from note_html (2026-11-05)

#24147: Halo now keeps a note_html for a note written as plain text and
rebuilds `note` from it with every line break dropped, so an approved
draft's marker and reply came back on one line and send_approved_draft
refused it (nothing sent). draftNoteText uses the plain note when the
[DRAFT PENDING APPROVAL] marker still has a line of its own, otherwise
rebuilds the text from note_html (<br> to line breaks, tags stripped,
entities decoded). The ticket's action list (GET /Actions?ticket_id) has no
note_html, so send_approved_draft fetches the single action
(GET /Actions/{id}) when it needs it; mark_draft_approved already did.
Deployed 596d593d; dry run on #24147's draft gave the full reply with its
line breaks. A draft with neither form usable is still refused.

## cipp-mcp /status comes in batches (2026-10-29)

`/status?batch=i&of=n` builds only the i-th of n slices of the tenant list
(sorted by name). The free plan allows 50 outbound calls per request and each
tenant costs 2, so one build for 35 tenants left ~17 out ("Too many
subrequests"). Tenants with a LastGraphError in ListTenants (consent
withdrawn: Champ, Christian County Health, Fair Grove, Just The Doc, Ozarks
Transportation, Republic Animal Hospital; missing service principal: SMART
Transportation, Truck Parts) are skipped and listed in batch 1's `noAccess`.
RequiresRefresh alone doesn't count (the partner tenant shows it and works).
Each batch returns `tenants` (per-tenant secure score/MFA) and is cached for 5
minutes on its own. The wallboard (v1.7) fetches 3 batches and combines them.
Verified after deploy 537610f8: 27 tenants built across 3 batches, 8 no-access,
repeat requests answered from memory. Plain `/status` is batch 1 of 1.

## /status is rebuilt at most every 5 minutes on cipp-mcp and halopsa-mcp (2026-10-29)

Cloudflare warned that Workers hit the free plan's CPU limit (10 ms per
request) 100+ times in a day. Observability: all 197 hits in 48 h were
wallboard GET /status calls (cipp-mcp 129, halopsa-mcp 68; building it costs
cipp ~24-52 ms, halopsa ~8-19 ms), starting 2026-10-28 ~18:00 UTC when the
wallboard was polling every 30 s again. No /mcp or /helpdesk-* request went
over. Both Workers now keep the last /status body in memory for 5 minutes
(`cachedStatus`; the Cache API does nothing on workers.dev) and share a
build in progress; a failed build isn't kept. Deployed: cipp f833b07e,
halopsa ad29aaa9. The wallboard (rafouche/Dashboard v1.6) polls every 60 s.
Also seen in the same logs, separate and older: buildSecurityStatus fails
for ~17 tenants every build with "Too many subrequests" (the free plan's
50-per-request cap) and a few with CIPP consent errors (CIPP-SAM not
consented, tenants showing RequiresRefresh in list_tenants).

## GET and DELETE on /mcp answer 405 (2026-10-26, deployed 2026-10-26)

The nine Workers HelpDeskAgent uses (halopsa, cipp, ninjarmm, hudu, huntress,
meraki, unifi, peplink, threecx) answered GET /mcp with the 200 text banner.
A Streamable HTTP client opens GET /mcp as its event stream; AllieService's
.NET client read the banner as a stream that kept closing and retried it 3-6
times every cycle (cipp-mcp Workers observability, 2026-10-26). They now
answer GET and DELETE on /mcp with 405 (`Allow: POST`), which the protocol
defines as "no event stream here". Live code was compared with the repo
before this change: identical apart from this line. Deployed 2026-10-26 on Roger's
go: cipp d70bdf45, halopsa cf95fae3, ninjarmm 14cfefd2, hudu 6e5f3e52,
huntress 938f54c7, meraki 865a46e3, unifi d25046f8, peplink ed97efda,
threecx 8a59e0fe. GET /mcp without a token: 401 where MCP_AUTH_TOKEN is set,
405 on meraki/unifi/peplink; /health 200 everywhere; healthcheck tool OK on
Halo, CIPP, Ninja, Hudu, Meraki, UniFi, Peplink. ninjarmm's log then showed
the shadow's GET answered 405 once with no retries. Same check also caught
one healthcheck from this session that timed out without ever reaching the
Worker (no request logged) and worked on retry - the #23862 pattern, on the
client side of Cloudflare.

## STANDING RULE: inbound auth for every Worker (Roger, 2026-09-25 - "option 1")

Apply this to every Worker, including any new one. Roger chose it over a
separate view-only key for the wallboard.

- **Token:** `MCP_AUTH_TOKEN`, always a Cloudflare **Secret** (never a
  plain-text variable). Opt-in: unset means the Worker accepts any caller.
  The MCP registration sends it as `Authorization: Bearer <token>`.
- **Open without the token, GET/HEAD only:**
  - `/health`, `/status`, `/licenses` - the wallboard (rafouche/Dashboard,
    a static page on a TV) polls these with no token, so it can never carry
    one.
  - The wallboard's REST passthroughs, `/api/huntress/*` and `/api/pax8/*`.
    These are **read-only**: any other method gets 405, because they carry
    the account's full API credentials (Pax8's forwarded any method with no
    auth at all until this change).
  - Browser-only sign-in routes that carry their own protection: ninjarmm's
    `/oauth/start`, `/oauth/callback` (one-time state cookie) and
    `/oauth/status`.
- **Everything else needs the token:** `/mcp` (every tool), the HelpDeskAgent
  pipeline routes (`/helpdesk-gate`, `/helpdesk-triage`,
  `/helpdesk-candidates`), anything that writes.
- **hudu-mcp is the exception:** it fails closed (no token set = 503) and
  serves no wallboard routes.
- **Every wrangler config has `"keep_vars": true`,** so a deploy never deletes
  a variable set in the dashboard. Without it, a normal deploy replaces all
  plain-text dashboard variables with the ones in the config - this is how
  the Halo token was silently removed on 2026-09-24.
- **Before deploying a Worker,** compare its live code with the repo (tool
  names from `/workers/scripts/<name>/content/v2`) so a deploy cannot roll
  back something deployed from elsewhere, and list its bindings.
- unifi-mcp and peplink-mcp ship an old wrangler; deploy every Worker with
  `../meraki-mcp/node_modules/.bin/wrangler deploy`.

Checked 2026-09-30 with a bare POST to `/mcp`: halopsa, cipp, ninjarmm,
hudu 401; meraki, unifi, peplink, huntress, jumpcloud 400 (open - the
request reached the tool handler). State on 2026-09-25 after the rollout: token set and enforced on halopsa,
cipp, ninjarmm (converted to a Secret 2026-09-28) and hudu; not yet set on
meraki, unifi, peplink, jumpcloud, huntress, m365, gworkspace, pax8. m365
`/status` returns 502 because its M365_TENANTS secret is not valid JSON
(pre-existing; the wallboard does not use m365).


## halopsa-mcp: Shifts calendar write tools (2026-11-09)
`list_shifts`, `create_shift`, `update_shift`, `delete_shift` manage Halo's
Shifts calendar (appointments of `type` 4, invisible to `list_appointments`;
`/Appointment` with `showshifts/shiftsonly/showall`). Roger asked for write
access because `escalate_emergency` pages whoever the calendar says is on
call. Scoped to type-4 rows (a visit or meeting is refused), refuse
recurring-series templates (change those in Halo's own calendar), require a
real enabled agent (not Unassigned/disabled), refuse double-booking the same
agent unless `allow_overlap`, take `dry_run`, re-read after writing, and
report `on_call_now`. Times are ISO; no timezone = UTC (Halo's own
convention). **Verified live 2026-11-09 (version 4861f05d)**: create needs only
{type:4, agent_id, subject, start_date, end_date, shift_type_id, allday:false};
update takes {id, type:4, agent_id, subject, start_date, end_date,
shift_type_id} in place; DELETE /Appointment/{id} needs nothing extra. The
overlap check only compares shifts of the SAME shift_type_id (an On-call week
legitimately overlaps the agent's type-0 working shifts). Roger's first use:
the weekly Fri 5pm Central (23:00Z in CST) rotation Steven > Erick > Leo >
Roger, done by moving the three pre-existing On-call shifts (22403/22405/
22406) and creating Roger's (22836); get_on_call confirmed each handover. The claude.ai "Halo" connector
keeps an old tool list; use a fresh session/connector refresh to see the new
tools. Deploying needs `CLOUDFLARE_ACCOUNT_ID=77913d04ce44a8767e3736930eadc0c4`
(wrangler now sees several accounts and can't pick one non-interactively).
