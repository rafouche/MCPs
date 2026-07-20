# JumpCloud MCP Server

Read/write access to the JumpCloud Admin API v1 and v2 via Claude.
Uses **Service Account OAuth2** authentication (Client ID + Client Secret).

## Secrets Required

```
wrangler secret put JUMPCLOUD_CLIENT_ID
wrangler secret put JUMPCLOUD_CLIENT_SECRET
```

> **Note:** Do NOT use `JUMPCLOUD_API_KEY` — this worker uses the newer Service
> Account OAuth2 flow, not the legacy single API key. The two auth methods are
> completely different. If you only have a legacy API key, see the Legacy API Key
> section at the bottom.

### Getting Your Service Account Credentials

1. Log into the [JumpCloud Admin Console](https://console.jumpcloud.com/)
2. Go to **Settings → Service Accounts**
3. Click **+ New** → enter a name → select a Role (Administrator for full access)
4. Under **Key Type**, select **Client Secret** → set an expiration → click **Activate**
5. Copy the **Client ID** and **Client Secret** immediately — the secret is only shown once
6. Store both securely (JumpCloud Password Manager, 1Password, etc.)

### Optional: MSP Multi-Org

```
wrangler secret put JUMPCLOUD_ORG_ID
```
Only needed if you manage multiple client orgs under one JumpCloud MSP parent
account. Found in Admin Console under **Organizations → select org → Org ID**.
Adds the `x-org-id` header to scope all requests to that org.

> **MSP Note:** Service Account auth does NOT currently support JumpCloud's
> MSP-specific endpoints. If you need MSP-level endpoints, use the legacy API
> key approach instead (see bottom of this README).

## Deploy

```
npm install
wrangler secret put JUMPCLOUD_CLIENT_ID
wrangler secret put JUMPCLOUD_CLIENT_SECRET
wrangler deploy
```

## Routes

- `POST /mcp` — MCP JSON-RPC endpoint for Claude
- `GET /status` — NOC wallboard: total user and system counts
- `GET /health` — Health check

## Claude.ai Integration URL

`https://jumpcloud-mcp.young-math-a33a.workers.dev/mcp`

## How the Auth Works

The worker exchanges your Client ID + Secret for a short-lived Bearer token via:
```
POST https://admin-oauth.id.jumpcloud.com/oauth2/token
Authorization: Basic base64(clientId:clientSecret)
Body: scope=api&grant_type=client_credentials
```
The token (~1 hour TTL) is cached in worker memory and auto-refreshed as needed.

## Tools (42 total)

| Category | Tools |
|---|---|
| **Connectivity** | healthcheck |
| **Users — Read** | list_users, get_user, list_user_system_bindings |
| **Users — Write** | create_user, update_user, delete_user, unlock_user, reset_mfa, suspend_user, activate_user |
| **Systems — Read** | list_systems, get_system, get_system_user_associations |
| **Systems — Write** | delete_system, bind_user_to_system, unbind_user_from_system |
| **User Groups — Read** | list_user_groups, get_user_group, list_user_group_members |
| **User Groups — Write** | create_user_group, update_user_group, delete_user_group, add_user_to_group, remove_user_from_group |
| **System Groups — Read** | list_system_groups, list_system_group_members |
| **System Groups — Write** | create_system_group, delete_system_group, add_system_to_group, remove_system_from_group |
| **SSO Applications** | list_applications, get_application, get_application_user_associations, bind_user_to_application, unbind_user_from_application |
| **Directory Insights** | search_directory_insights |
| **Policies** | list_policies, get_policy |
| **Commands** | list_commands, run_command |
| **Escape hatch** | jc_raw_request (any endpoint, any method) |

## Test Commands (CMD — verified working on Windows)

Health check:
```cmd
curl https://jumpcloud-mcp.young-math-a33a.workers.dev/health
```

List tools:
```cmd
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | curl -X POST https://jumpcloud-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" --data-binary @-
```

NOC status:
```cmd
curl https://jumpcloud-mcp.young-math-a33a.workers.dev/status
```

> **Note:** PowerShell quoting is unreliable for JSON bodies. Use CMD (cmd.exe)
> or pipe from echo as shown above.

## Legacy API Key (alternative)

If you only have a legacy API key (single value from **Settings → API Settings**),
you can swap the auth by changing two things in `src/index.ts`:

1. Change `Env` interface: replace `JUMPCLOUD_CLIENT_ID` and `JUMPCLOUD_CLIENT_SECRET` with `JUMPCLOUD_API_KEY: string`
2. Replace the `getToken()` function and `jcHeaders()` function with:

```typescript
async function jcHeaders(env: Env): Promise<Record<string, string>> {
  return {
    "x-api-key": env.JUMPCLOUD_API_KEY,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}
```

Then set `wrangler secret put JUMPCLOUD_API_KEY` instead of the two Service Account secrets.
