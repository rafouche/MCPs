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
| `meraki-mcp` | Cisco Meraki | tool-implementation | also exposes `/licenses` |
| `halopsa-mcp` | HaloPSA (PSA/ticketing) | tool-implementation | feeds Dashboard's Tickets zone. `list_tickets` now also accepts `agent_id` (HaloPSA's own `/Tickets` single-agent filter, confirmed against the live HaloPSA REST API v2 swagger spec), forwarded straight through — added because a caller (the HelpDeskAgent triage bot in `rafouche/HelpDeskAgent`) was relying on `count`/`open_only` alone with no `agent_id`, which returns an account-wide list capped at `count` (default 20, and larger values like 30/100/500 already exceed a typical MCP caller's own response-size limit given each ticket row carries its full body text). A ticket that goes quiet can silently fall outside that window even though it's genuinely open and assigned - `agent_id` lets a caller ask for a specific agent's (or HaloPSA's real "Unassigned" agent's) tickets directly instead of hoping they're still inside the last `count` by recency. Also added `pageinate`/`page_no`/`page_size` (HaloPSA's own real pagination, confirmed in the same swagger spec - `page_size` capped at 100 by HaloPSA itself) for when even one agent's ticket count is too large for one response - untested against a live tenant so far, so the actual safe `page_size` (given this MCP server's own response-size limit and that each row carries full body text) isn't confirmed yet; start small and verify before relying on a specific number. No `team`/`status` array filters added - HaloPSA's swagger types those as a bare `string` (not `array`), meaning the wire format is an encoded-array string whose exact shape (JSON-array text vs. something else) isn't documented and wasn't verified against a live call before this fix shipped - don't add them without testing against a real tenant first. |
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

## Secrets

Secrets are per-worker via `wrangler secret put <NAME>` and never appear in `wrangler.jsonc` (some files include a comment block listing expected secret names, but the values themselves must never be committed there). `MCPs.txt` at the repo root currently holds plaintext copies of several live API keys/secrets — this is a standing risk, not a documented convention; don't add to it, and flag it if asked to touch credentials in this repo. `MCPs.txt` and `**/altec-mcp-server-*.json` are gitignored, so they won't show up in `git status`/diffs even though they're on disk — don't assume gitignored means absent.
