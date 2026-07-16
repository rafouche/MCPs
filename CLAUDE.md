# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of independent Cloudflare Worker MCP servers, each exposing one IT/MSP vendor's API (RMM, PSA, networking, identity, M365, etc.) as an MCP connector for Claude, plus a single static wallboard dashboard that polls several of them for a NOC-style status display. There is no root build system, monorepo tool, or shared package — every `*-mcp/` folder is deployed and versioned independently.

Account workers.dev subdomain used throughout: `young-math-a33a` (e.g. `https://meraki-mcp.young-math-a33a.workers.dev`).

This directory is **not a git repository** — there is no version control here. Treat file edits as directly affecting the only copy of the code.

## Projects

| Folder | Vendor | Pattern | Notes |
|---|---|---|---|
| `meraki-mcp` | Cisco Meraki | tool-implementation | also exposes `/licenses` |
| `halopsa-mcp` | HaloPSA (PSA/ticketing) | tool-implementation | feeds Dashboard's Tickets zone |
| `cipp-mcp` | CIPP (M365 via CIPP) | tool-implementation | feeds Dashboard's Security zone |
| `m365-mcp` | Microsoft Graph (direct, multi-tenant) | tool-implementation | not yet wired into Dashboard |
| `jumpcloud-mcp` | JumpCloud directory | tool-implementation | OAuth2 Service Account, org-scoped only — not yet wired into Dashboard |
| `ninjarmm-mcp` | NinjaRMM | tool-implementation | Dashboard's Ninja `/status` route is a known pending item |
| `gworkspace-mcp` | Google Workspace | tool-implementation | uses a service-account JSON key file in-folder |
| `3cx-mcp` | 3CX phone system | tool-implementation | |
| `peplink-mcp` | Peplink InControl2 | tool-implementation | also exposes `/licenses` |
| `unifi-mcp` | UniFi | tool-implementation | |
| `huntress-mcp` | Huntress EDR | **passthrough gateway** | plain JS, not TS |
| `pax8-mcp` | Pax8 billing/provisioning | **passthrough gateway** | plain JS, not TS |
| `Dashboard/dashboard.html` | — | static wallboard client | no build step |

## Commands

Every `*-mcp/` project uses the same scripts (run from inside that project's folder — there is no top-level script that operates across all of them):

```bash
npm install          # only needed once per project; several projects (huntress-mcp, pax8-mcp, jumpcloud-mcp) currently have no node_modules committed
wrangler dev          # local dev server
wrangler deploy       # deploy — this is the only way changes take effect; there is no CI
wrangler secret put <NAME>   # set a secret (never put values in wrangler.jsonc)
wrangler secret list  # list secret names (not values) on the deployed worker
```

Only `meraki-mcp` and `cipp-mcp` currently have vitest scaffolding (`test/index.spec.ts`), and it's the default Cloudflare template "Hello World" placeholder test, not real coverage of the worker's actual tool logic:

```bash
npx vitest            # run from inside meraki-mcp/ or cipp-mcp/
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

### 2. Passthrough gateway workers (huntress-mcp, pax8-mcp)

These don't implement their own `TOOLS`/`runTool` at all. They relay `POST /mcp` JSON-RPC verbatim to the vendor's own hosted MCP server, injecting auth on the way through, and additionally expose a raw REST reverse-proxy at `/api/<vendor>/*`. Written in plain `.js`, not TypeScript, unlike every tool-implementation worker.

## Auth patterns (varies per vendor — check the specific project before assuming)

- **Static API key header**: Meraki, UniFi.
- **OAuth2 client-credentials** (POST to a token endpoint with Basic auth of `client_id:client_secret`, cache the bearer token, retry): JumpCloud, Peplink, Pax8, HaloPSA. For JumpCloud specifically, Service Account credentials are org-scoped only — JumpCloud does not currently support a single MSP-wide credential across child orgs (confirmed via their own docs: Service Accounts are "not available for MSP customers" as of this writing).
- **Basic auth passthrough**: Huntress (credentials attached to every proxied request, not exchanged for a token).

Getting the auth type wrong for a given vendor is the most common cause of "tools/list works but every tools/call fails" — because every tool call in a tool-implementation worker re-derives its token/headers first, one bad credential fails 100% of tools uniformly. The repo convention across every project is to **never swallow API errors**: every `xGet`/`xPost`/etc. helper throws `Error(status + response body text)`, and the top-level `tools/call` catch puts that straight into the JSON-RPC `error.message` — so a real vendor HTTP status and response body should always be visible in the tool result, not a generic message. If a worker isn't doing this, that's a regression, not the intended pattern.

## Dashboard (`Dashboard/dashboard.html`)

Single self-contained HTML file — all CSS/JS inline, no build step, no framework. Opened directly in a browser (any TV, `file://` or hosted, doesn't matter).

- Hardcoded `ENDPOINTS` map near the top of the `<script>` block points at each worker's `/status` (and `/licenses`) route. New workers must be added here manually — nothing is auto-discovered.
- Query params: `?zone=network|tickets|security|business|all` (default `all`), `?demo=1` forces demo data everywhere, `?<name>=<url>` overrides any single endpoint at load time.
- Each zone degrades independently — if one worker's `/status` is unreachable, that zone falls back to its own hardcoded `demo*()` data while unrelated zones keep showing live data.
- `APP_VERSION` constant (shown in the header badge) should be bumped on every meaningful change to this file — minor bump for regular updates, jump to the next whole number for a breaking change (new zone structure, changed `/status` contract, etc).

## Secrets

Secrets are per-worker via `wrangler secret put <NAME>` and never appear in `wrangler.jsonc` (some files include a comment block listing expected secret names, but the values themselves must never be committed there). `MCPs.txt` at the repo root currently holds plaintext copies of several live API keys/secrets — this is a standing risk, not a documented convention; don't add to it, and flag it if asked to touch credentials in this repo.
