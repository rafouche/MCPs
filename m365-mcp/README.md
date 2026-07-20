# Microsoft 365 Multi-Tenant MCP

Direct Microsoft Graph API access across all client M365 tenants.
Read/write users, groups, devices, licenses, Conditional Access, sign-in logs,
service health, SharePoint, and more — without going through CIPP.

## How it differs from the CIPP MCP

| CIPP MCP | This MCP |
|---|---|
| Goes through CIPP middleware | Direct Graph API calls |
| Limited to what CIPP exposes | Full Graph API surface |
| Consent already done via GDAP | One-time consent URL per client |
| ~35 tools | 60 tools |

Both are useful — CIPP for its workflow automations, this for raw Graph access.

## Phase 1: Create the App Registration (one time)

1. Go to portal.azure.com → Azure Active Directory → App Registrations → New Registration
2. Name: Altec MCP Server
3. Supported account types: **"Accounts in any organizational directory"** (multi-tenant)
4. Redirect URI (Web): https://m365-mcp.young-math-a33a.workers.dev/consent-complete
5. Click Register — copy the Application (client) ID
6. Go to Certificates & Secrets → New client secret — copy the Value (shown once)
7. Go to API Permissions → Add a permission → Microsoft Graph → Application permissions

### Required permissions

| Permission | Purpose |
|---|---|
| User.ReadWrite.All | Create/update/delete/read users |
| Group.ReadWrite.All | Manage groups and members |
| Directory.ReadWrite.All | Directory-wide access |
| MailboxSettings.ReadWrite | OOO, mailbox settings |
| Mail.ReadWrite | Email access |
| DeviceManagementManagedDevices.ReadWrite.All | Intune device management |
| DeviceManagementConfiguration.ReadWrite.All | Intune policies |
| Policy.Read.All | Read Conditional Access policies |
| AuditLog.Read.All | Sign-in and audit logs |
| Reports.Read.All | Usage reports (OneDrive, etc.) |
| Organization.Read.All | Org info and domains |
| RoleManagement.Read.Directory | Read directory roles |
| ServiceHealth.Read.All | M365 service health |
| Sites.ReadWrite.All | SharePoint sites |
| IdentityRiskyUser.ReadWrite.All | Identity Protection risky users |

8. Click "Grant admin consent for Altec" to consent in your own tenant

## Phase 2: Secrets

```
wrangler secret put M365_CLIENT_ID
```
Enter: the Application (client) ID from your app registration

```
wrangler secret put M365_CLIENT_SECRET
```
Enter: the client secret value (shown once)

```
wrangler secret put M365_TENANTS
```
Enter a JSON object on one line mapping friendly names to tenant IDs:
```json
{"altec":"your-altec-tenant-id-guid","goldmechanical":"their-tenant-id-guid"}
```
Tenant IDs are GUIDs found in portal.azure.com → Azure AD → Overview → Tenant ID.

## Phase 3: Deploy

```
npm install
wrangler deploy
```

## Phase 4: Per-Client Consent (one time per client)

Each client's Global Admin needs to grant consent once. After deploying, generate
the consent URL for each client:

```cmd
curl https://m365-mcp.young-math-a33a.workers.dev/consent/goldmechanical
```

This returns a `consentUrl`. Send that URL to the client's Global Admin — they
log in and click Accept. After that, the tenant is accessible.

The `/consent-complete` redirect shows them a success page.

## Routes

- `POST /mcp` — MCP JSON-RPC endpoint for Claude
- `GET /status` — NOC wallboard: per-tenant org name and service health
- `GET /health` — Health check
- `GET /consent/{tenantName}` — Generate consent URL for a client tenant
- `GET /consent-complete` — Landing page after successful admin consent

## Claude.ai Integration URL

`https://m365-mcp.young-math-a33a.workers.dev/mcp`

## Tools (60 total)

| Category | Tools |
|---|---|
| **Management** | list_tenants, healthcheck, get_organization |
| **Users — Read** | list_users, get_user, get_user_member_of, get_user_licenses, get_user_auth_methods, get_user_manager, get_user_mailbox_settings |
| **Users — Write** | create_user, update_user, delete_user, reset_user_password, revoke_user_sessions, update_user_mailbox_settings, assign_license, remove_license |
| **Groups** | list_groups, get_group, list_group_members, create_group, add_group_member, remove_group_member, delete_group |
| **Licenses** | list_subscribed_skus |
| **Intune** | list_managed_devices, get_managed_device, wipe_managed_device, retire_managed_device, sync_managed_device, list_device_compliance_policies, list_device_configuration_profiles |
| **Conditional Access** | list_conditional_access_policies, get_conditional_access_policy |
| **Security** | list_risky_users, list_risk_detections, confirm_user_compromised, dismiss_user_risk |
| **Audit Logs** | list_sign_in_logs, list_audit_logs |
| **Service Health** | list_service_health, list_service_messages |
| **SharePoint** | list_sharepoint_sites, get_sharepoint_site, list_onedrive_usage |
| **Directory** | list_directory_roles, list_role_members, list_domains |
| **Escape hatch** | graph_raw_request (any Graph endpoint, any method) |

## Test Commands (CMD — verified working on Windows)

Health check:
```cmd
curl https://m365-mcp.young-math-a33a.workers.dev/health
```

List tools:
```cmd
echo {"jsonrpc":"2.0","id":1,"method":"tools/list"} | curl -X POST https://m365-mcp.young-math-a33a.workers.dev/mcp -H "Content-Type: application/json" --data-binary @-
```

Get consent URL for a client:
```cmd
curl https://m365-mcp.young-math-a33a.workers.dev/consent/goldmechanical
```

NOC status:
```cmd
curl https://m365-mcp.young-math-a33a.workers.dev/status
```

> **Note:** PowerShell quoting is unreliable for JSON. Use CMD or pipe from echo.
