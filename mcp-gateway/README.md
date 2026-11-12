# mcp-gateway

The Altec MCP Gateway: `https://mcp-gateway.altecusa.com`. One OAuth 2.1 front
door, with Microsoft Entra sign-in, that lets third-party chatbots (claude.ai,
ChatGPT, Grok) use the backend MCP Workers read-only.

Each backend is served at `https://mcp-gateway.altecusa.com/<key>/mcp`. `GET /`
lists them.

## Where this code came from

The gateway was first deployed on 2026-10-05 by uploading it, and its source
was never committed. On 2026-11-12 the source was rebuilt from the live
deployed bundle: same `@cloudflare/workers-oauth-provider` (1.2.1), same code.
A dry-run build of this folder matched the live bundle exactly apart from
whitespace and bundler name helpers. The original TypeScript types were not
recoverable, so the source is plain JS.

## How it works

- **Sign-in:** the chatbot registers itself (dynamic client registration) and
  sends the user to `/authorize`. That page shows a consent screen, then sends
  the user on to Entra (app `ENTRA_CLIENT_ID` in tenant `ENTRA_TENANT_ID`). The
  sign-in can only return to a host in `ALLOWED_REDIRECT_HOSTS` (or to a
  loopback address).
- **Access:** the user needs the app role `MCP.ReadOnly` or `MCP.Admin`, plus
  the role named in that backend's `roles` (for example `MCP.Hudu`). Every
  token refresh asks Entra again, so a disabled account or a removed role
  loses access within one access-token lifetime (1 hour).
- **Read-only:** a backend with `allowWrite: false` (all of them today) only
  forwards `initialize`, `ping`, `tools/list` and `tools/call`. `tools/list` is
  filtered to the backend's `readTools`, and any other tool is refused.
- **Backend auth:** the gateway sends the secret named in `secret` as
  `Authorization: Bearer ...`. That value is the backend Worker's own
  `MCP_AUTH_TOKEN`. A backend marked `noAuth: true` has no token set, so the
  gateway forwards without one. If a backend is not `noAuth` and its secret is
  missing, the gateway answers "Gateway is not configured for this server" and
  never calls the backend.
- **Audit:** every forwarded or blocked call is logged as JSON (`evt: "mcp"`)
  with the user's UPN, in Workers observability.
- **Admin:** `GET /admin/grants?user=<oid>` and `POST /admin/revoke?user=<oid>`,
  with `Authorization: Bearer <ADMIN_API_KEY>`.
- **Cron** `17 7 * * *`: purges expired grants and tokens from `OAUTH_KV`.

## Backends (servers.json)

| key | Worker | Entra role | upstream secret |
|---|---|---|---|
| 3cx | threecx-mcp | MCP.3CX | UPSTREAM_3CX_TOKEN |
| halo | halopsa-mcp | MCP.HaloPSA | UPSTREAM_HALO_TOKEN |
| ninja | ninjarmm-mcp | MCP.NinjaOne | UPSTREAM_NINJA_TOKEN |
| huntress | huntress-mcp | MCP.Huntress | (noAuth) |
| meraki | meraki-mcp | MCP.Meraki | (noAuth) |
| peplink | peplink-mcp | MCP.Peplink | (noAuth) |
| unifi | unifi-mcp | MCP.UniFi | (noAuth) |
| gws | gworkspace-mcp | MCP.GoogleWorkspace | (noAuth) |
| hudu | hudu-mcp | MCP.Hudu | UPSTREAM_HUDU_TOKEN |
| cipp | cipp-mcp | MCP.CIPP | UPSTREAM_CIPP_TOKEN |
| pax8 | pax8-mcp | MCP.Pax8 | (noAuth) |
| m365 | m365-mcp | MCP.M365 | (noAuth) |
| gchannel | gchannel-mcp | MCP.GoogleChannel | UPSTREAM_GCHANNEL_TOKEN |

JumpCloud was removed on 2026-11-12: the Worker is retired and no longer deployed.

To add a backend, give it an entry with `upstream`, `secret`, `roles` and an
exact `readTools` allowlist. Leave out writes, raw `*_api_get` escape hatches,
and any tool that can return stored secrets. Then create its app role on the
Entra app registration and, unless it is `noAuth`, set its upstream secret.

## Deploying

Push to `main`. `.github/workflows/deploy.yml` deploys this folder whenever it
changes. Never deploy from a local copy that is not on GitHub.

```bash
npm install
npm run check    # dry-run build into .wrangler/dry-run
```

## Settings

Plain variables are in `wrangler.jsonc`. Secrets are set in the Cloudflare
dashboard: `ENTRA_CLIENT_SECRET`, `ADMIN_API_KEY`, optionally `CONSENT_SECRET`,
and one `UPSTREAM_<X>_TOKEN` per backend that is not `noAuth`.
