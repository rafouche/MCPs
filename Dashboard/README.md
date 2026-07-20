# Altec Wallboard — Final Package

## What's in this zip

```
dashboard.html       ← the entire client. One file, all JS inline, nothing else to run locally.
huntress-mcp/         ← new standalone Worker (deploy fresh)
pax8-mcp/              ← new standalone Worker (deploy fresh)
```

That's it. Your existing `ninjarmm-mcp`, `halopsa-mcp`, `meraki-mcp`, and `cipp-mcp`
projects already have their `/status` routes merged in (from the files you pasted
and I merged back) — just redeploy those 3 you updated, same as always
(`wrangler deploy` from each project's folder). Nothing further needed from me on
those.

## Deploy order

1. **Redeploy your 3 updated existing Workers** (Halo, Meraki, CIPP — wherever you
   merged the `/status` route in): `wrangler deploy` from each project folder.
2. **Deploy the 2 new ones:**

```bash
cd huntress-mcp
wrangler secret put HUNTRESS_API_KEY
wrangler secret put HUNTRESS_API_SECRET
wrangler deploy

cd ../pax8-mcp
wrangler secret put PAX8_MCP_TOKEN
wrangler secret put PAX8_CLIENT_ID
wrangler secret put PAX8_CLIENT_SECRET
wrangler deploy
```

3. **Open `dashboard.html`** — anywhere, any TV's browser. `?zone=network|tickets|security|business|all` still works the same way.

## One outstanding item: Ninja

You haven't sent over `ninjarmm-mcp`'s `index.ts` yet, so I couldn't merge a
`/status` route into it — the dashboard still points at
`https://ninjarmm-mcp.young-math-a33a.workers.dev/status`, but until that route
exists there, the Network zone's Ninja half will fall back to demo data (Meraki's
half will still show live, since that one's done). Paste that file whenever you're
ready and I'll do the same merge as the other three.

## What changed in this version of dashboard.html

The Security zone now merges **two** independent sources instead of one:
Huntress incidents (as before) **and** CIPP's M365 security posture (Secure
Score %, MFA coverage %, and any tenants below threshold) — since you asked for
CIPP folded into Security. Each source still degrades independently; if CIPP's
`/status` is unreachable, you still see Huntress incidents live and vice versa.

## Endpoint map (for reference)

| Zone | Source(s) | URL |
|---|---|---|
| Network | Ninja | `ninjarmm-mcp.young-math-a33a.workers.dev/status` *(pending)* |
| Network | Meraki | `meraki-mcp.young-math-a33a.workers.dev/status` |
| Tickets | Halo | `halopsa-mcp.young-math-a33a.workers.dev/status` |
| Security | Huntress | `huntress-mcp.young-math-a33a.workers.dev/api/huntress/*` |
| Security | CIPP | `cipp-mcp.young-math-a33a.workers.dev/status` |
| Business | Pax8 | `pax8-mcp.young-math-a33a.workers.dev/api/pax8/*` |

## Known TODOs (unchanged from before)

Field-name assumptions in the `/status` routes you merged (Halo ticket fields,
CIPP secure score/MFA fields, Meraki's are solid since they reuse your existing
tested helper) may need small adjustments once you see real payloads — same
caveat as when those files were handed back to you.
