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
| `cipp-mcp` | CIPP (M365 via CIPP) | tool-implementation | feeds Dashboard's Security zone. Points at the CyberDrain-hosted "CIPP-NG" instance `https://cipp.altecusa.com` (client-credentials against a dedicated, non-MCP-flagged CIPP-API client — separate from CIPP's own native MCP feature). Beyond its ~33 named tools it also exposes generic `cipp_api_get`/`cipp_api_post` tools that call any CIPP endpoint by name (see the file header comment in `cipp-mcp/src/index.ts`), giving it full read/write coverage of CIPP's API without one hand-written tool per endpoint — this is why the native CIPP MCP connector was retired in favor of this worker. |
| `m365-mcp` | Microsoft Graph (direct, multi-tenant) | tool-implementation | not yet wired into Dashboard |
| `jumpcloud-mcp` | JumpCloud directory | tool-implementation | OAuth2 Service Account, org-scoped only — not yet wired into Dashboard. Contains a fully duplicated nested project at `jumpcloud-mcp/jumpcloud-mcp/` (own `wrangler.jsonc`/`src`/`package.json`, currently identical to the outer one) — treat the outer `jumpcloud-mcp/src/index.ts` as canonical and confirm which copy you're editing before making changes |
| `ninjarmm-mcp` | NinjaRMM | tool-implementation | feeds Dashboard's Network zone (individually-tracked devices) |
| `gworkspace-mcp` | Google Workspace | tool-implementation | uses a service-account JSON key file in-folder |
| `3cx-mcp` | 3CX phone system | tool-implementation | |
| `peplink-mcp` | Peplink InControl2 | tool-implementation | also exposes `/licenses` |
| `unifi-mcp` | UniFi | tool-implementation | |
| `huntress-mcp` | Huntress EDR | **passthrough gateway** | plain JS, not TS |
| `pax8-mcp` | Pax8 billing/provisioning | **passthrough gateway** | plain JS, not TS |
| `teams-meeting-notes-worker` | Microsoft Graph + Teams + Claude API | **webhook automation** | not an MCP tool server — no `TOOLS`/`runTool`, no `/mcp` endpoint. Receives Graph change notifications when a Teams meeting transcript is ready, summarizes it via the Claude API, and posts to a Teams channel via Incoming Webhook. Plain JS, not TS. See its own README for the full secrets list and setup flow. |

## Commands

Every `*-mcp/` project uses the same scripts (run from inside that project's folder — there is no top-level script that operates across all of them):

```bash
npm install          # only needed once per project; m365-mcp currently has no node_modules installed
wrangler dev          # local dev server
wrangler deploy       # deploy — this is the only way changes take effect; there is no CI
wrangler secret put <NAME>   # set a secret (never put values in wrangler.jsonc)
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

### 2. Passthrough gateway workers (huntress-mcp, pax8-mcp)

These don't implement their own `TOOLS`/`runTool` at all. They relay `POST /mcp` JSON-RPC verbatim to the vendor's own hosted MCP server, injecting auth on the way through, and additionally expose a raw REST reverse-proxy at `/api/<vendor>/*`. Written in plain `.js`, not TypeScript, unlike every tool-implementation worker.

## Auth patterns (varies per vendor — check the specific project before assuming)

- **Static API key header**: Meraki, UniFi.
- **OAuth2 client-credentials** (POST to a token endpoint with Basic auth of `client_id:client_secret`, cache the bearer token, retry): JumpCloud, Peplink, Pax8, HaloPSA. For JumpCloud specifically, Service Account credentials are org-scoped only — JumpCloud does not currently support a single MSP-wide credential across child orgs (confirmed via their own docs: Service Accounts are "not available for MSP customers" as of this writing).
- **Basic auth passthrough**: Huntress (credentials attached to every proxied request, not exchanged for a token).

Getting the auth type wrong for a given vendor is the most common cause of "tools/list works but every tools/call fails" — because every tool call in a tool-implementation worker re-derives its token/headers first, one bad credential fails 100% of tools uniformly. The repo convention across every project is to **never swallow API errors**: every `xGet`/`xPost`/etc. helper throws `Error(status + response body text)`, and the top-level `tools/call` catch puts that straight into the JSON-RPC `error.message` — so a real vendor HTTP status and response body should always be visible in the tool result, not a generic message. If a worker isn't doing this, that's a regression, not the intended pattern.

## Inbound auth (MCP_AUTH_TOKEN) — every Worker, opt-in

Until 2026-09-19 no Worker in this repo checked who was calling it: `tools/list` — and so every write tool — answered a bare, credential-less request on the public `workers.dev` URL, even though the MCP client registrations (HelpDeskAgent's README, `claude mcp add --header "Authorization: Bearer <token>"`) had been sending a token all along. Every Worker's `fetch()` now starts with the same check: if the `MCP_AUTH_TOKEN` secret is set, every route except `OPTIONS` and `/health` must present exactly that bearer token (constant-time compare) or gets a `401`; if the secret is unset, behavior is unchanged. That ordering is deliberate — deploy the code first, then `wrangler secret put MCP_AUTH_TOKEN` per Worker with the token its registrations already send, so nothing breaks in between. Keep the check when adding a new Worker (copy the block; it's identical everywhere), and never make it conditional on the route beyond the two exemptions above.

## Secrets

Secrets are per-worker via `wrangler secret put <NAME>` and never appear in `wrangler.jsonc` (some files include a comment block listing expected secret names, but the values themselves must never be committed there). `MCPs.txt` at the repo root currently holds plaintext copies of several live API keys/secrets — this is a standing risk, not a documented convention; don't add to it, and flag it if asked to touch credentials in this repo. `MCPs.txt` and `**/altec-mcp-server-*.json` are gitignored, so they won't show up in `git status`/diffs even though they're on disk — don't assume gitignored means absent.

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
refuses a second run on the same ticket. Paging default `ON_CALL_MODE`
"ticket": ONE hidden emailed action on the same ticket (outcome 16,
`emailto` = `ON_CALL_EMAIL`, `emailcc` = `ON_CALL_CC_EMAILS`,
hiddenfromuser true) - Halo does send mail for a hidden action (confirmed
on ticket #22417: email_status 2, dateemailed set). Subject carries the
ticket id; the client never sees it; no second ticket. "halo" (an internal
alert ticket - rejected by Roger: two tickets for the tech) and "m365"
(m365-mcp send_on_call_alert; that Worker has no Graph credentials, and
CIPP-SAM has no Mail.Send) remain selectable. `page_test: true` with a
scratch ticket_id of ours sends a marked TEST page from that ticket.

Who gets paged (ticket mode) is looked up at send time from Halo's own
Shifts calendar, not fixed: `resolveOnCall` GETs `/Appointment` with
`showshifts=true&shiftsonly=true&showall=true` (shifts are appointments of
`type` 4 and are invisible without showshifts; recurring masters are
templates and skipped), keeps the ones whose `shift_type_id` equals
`ON_CALL_SHIFT_TYPE_ID` (default 1 = Halo's stock "On-call" shift type; a
subject containing "on call" also counts) and whose start<=now<end (Halo
times are UTC without a suffix), then reads each agent's email and Mobile
Number (Halo's `sms` field) from `/Agent/{id}`; the text address is the
number's digits at `ON_CALL_SMS_DOMAIN` (default altec.text.email, Roger's
email-to-SMS service), no number = email only (Roger asked for exactly
this on 2026-09-21; the earlier ON_CALL_SMS_MAP var is gone). First agent =
`emailto`, the rest + every SMS address = `emailcc`. Nobody scheduled, agent without an email, or any error
-> `ON_CALL_EMAIL` / `ON_CALL_CC_EMAILS` (the fixed fallback), and both the
response (`on_call_alert.on_call.source`) and the `[EMERGENCY ACK SENT]`
audit note say which was used. `ON_CALL_LOOKUP: "off"` disables the lookup.
`get_on_call` (read-only, optional `at`) shows the same resolution;
`escalate_emergency` accepts `at` only with `dry_run`/`page_test`. A
Leo-style "Fixed shift" (shift_type_id 0) never matches. Verified against
Roger's test shift (appointment 19875, 2026-09-22T01:30-02:00Z): `at` inside
it resolves to agent 28, outside it falls back. `halo_api_get` is the
read-only raw GET tool this was discovered with; it is not in the
pipeline's allowlist.

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
