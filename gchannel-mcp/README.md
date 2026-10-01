# gchannel-mcp

Multi-tenant Google Workspace for the MSP, the Google counterpart of
cipp-mcp. One MCP server sees every client's Google tenant:

- **Channel Partner customers.** These are listed through the Cloud Channel API
  and reached through the reseller admin's delegated access to each customer's
  Admin console.
- **Standalone tenants.** These are Google tenants where we hold admin but which
  are not in the Partner portal. They are listed in the `GOOGLE_TENANTS` secret.

URL: `https://gchannel-mcp.young-math-a33a.workers.dev/mcp`

It **fails closed** like hudu-mcp. `/mcp` answers 503 until both
`MCP_AUTH_TOKEN` and `GOOGLE_SERVICE_ACCOUNT_JSON` are set, and 401 without the
Bearer token. `/health` is open and reports what is configured.

## How access works

Both kinds of tenant use **one service account key** with domain-wide
delegation (DWD). DWD is authorized per Google tenant by client ID, so the
same service account can be trusted by many tenants. You do not need a key
per client.

| Tenant kind | Impersonates | Customer addressed as |
|---|---|---|
| Channel customer | `GOOGLE_RESELLER_ADMIN_EMAIL` (reseller domain super admin) | the customer's `cloudIdentityId` (C0...) |
| Standalone | that tenant's `adminEmail` | its `customerId`, or `my_customer` |

Every tenant tool takes `tenant`: a primary domain, a customer ID (C0...),
or a name from `list_tenants`. If a standalone entry and a Channel customer
both match, the standalone entry is used.

## Setup

### 1. Service account (Google Cloud project)

1. Create a project, or reuse one. Enable these APIs: **Cloud Channel API**,
   **Google Workspace Reseller API**, **Admin SDK API**, **Enterprise License
   Manager API** and **Google Workspace Alert Center API**.
2. Create a service account and a JSON key. Note the service account's
   **client ID** (numeric).

### 2. Reseller domain (Channel side)

1. In the **reseller domain's** Admin console, go to Security > Access and data
   control > API controls > Domain-wide delegation. Add the client ID with
   every scope in the list below.
2. In the Partner Sales Console, go to Settings and copy the **Account ID**.
   This is `CHANNEL_ACCOUNT_ID`.
3. Choose a super admin in the reseller domain for
   `GOOGLE_RESELLER_ADMIN_EMAIL`.

### 3. Each standalone tenant

1. In that tenant's Admin console, go to Domain-wide delegation. Add the
   **same** client ID with the scopes below. A tenant may authorize only a
   subset of the scopes; tools that need the other scopes fail for that tenant
   with `unauthorized_client`.
2. Add the tenant to `GOOGLE_TENANTS`:

```json
[
  { "name": "Client Co", "domain": "clientco.com", "adminEmail": "admin@clientco.com" },
  { "name": "Other Co", "domain": "other.org", "adminEmail": "it@other.org", "customerId": "C01abcd23" }
]
```

`customerId` is optional; the server uses `my_customer` when it is absent.
An entry can include `"serviceAccountJson": {...}` to use a different key for
that tenant only.

### DWD scopes (paste as one comma-separated line)

```
https://www.googleapis.com/auth/apps.order,https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.user.security,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.orgunit.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly,https://www.googleapis.com/auth/admin.directory.customer.readonly,https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly,https://www.googleapis.com/auth/admin.directory.device.mobile.readonly,https://www.googleapis.com/auth/admin.directory.rolemanagement.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/apps.licensing,https://www.googleapis.com/auth/apps.alerts
```

Standalone tenants do not need `apps.order`.

### 4. Secrets

Set these in the Cloudflare dashboard: Workers & Pages > gchannel-mcp >
Settings > Variables and Secrets. Add each one with type **Secret**, then
click Deploy.

| Secret | Value |
|---|---|
| `MCP_AUTH_TOKEN` | a long random string; the same value goes in the MCP registration's `Authorization: Bearer` header |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the full contents of the service account JSON key file |
| `GOOGLE_RESELLER_ADMIN_EMAIL` | super admin in the reseller domain (Channel side) |
| `CHANNEL_ACCOUNT_ID` | Partner Sales Console > Settings > Account ID (Channel side) |
| `GOOGLE_TENANTS` | optional JSON array of standalone tenants (above) |

Either side, Channel or standalone, can be left unset. Code changes are
deployed from this repo by Claude; secrets never go in the repo.

Then run `healthcheck` with no arguments, and again with `tenant` set to test
a specific tenant's access.

## Tools

- **Discovery:** `healthcheck`, `list_tenants`.
- **Channel, read-only:** `channel_get_customer`, `channel_list_entitlements`,
  `reseller_list_subscriptions`, and `channel_api_get` (any Channel v1 path;
  `{account}` is substituted).
- **Tenant:** `get_customer_info`, `list_domains`.
- **Users:** `list_users` (compact rows; `full: true` for raw), `get_user`,
  `create_user`, `update_user` (sends only the changed fields),
  `sign_out_user`, `get_2sv_report` (MFA-style summary), `list_admins`.
- **Groups:** `list_groups`, `list_group_members`, `add_group_member`,
  `remove_group_member`.
- **Org units and devices:** `list_org_units`, `list_chromeos_devices`,
  `list_mobile_devices`.
- **Licensing:** `list_license_assignments`.
- **Audit and alerts:** `get_login_activity`, `get_admin_activity`, `list_alerts`.
- **Generic:** `google_api_get` (GET any Directory, Reports, Licensing or Alert
  Center path; `{customer}` is substituted).

Two kinds of action are deliberately not exposed. No tool orders, changes or
cancels an entitlement, because that moves money; use the Partner Sales
Console. No tool deletes users.

## Not yet verified against a live tenant

The code was built from Google's API docs and tested locally: auth gating,
tenant resolution, and JWT signing against Google's token endpoint. It has not
yet been run with real credentials. Check these points first:

- Channel customers: the reseller admin calling the Admin SDK with
  `customer=<cloudIdentityId>`. This is Google's documented reseller pattern,
  but it only works for customers whose Workspace the reseller manages.
- Alert Center and Reports with `customerId` for a Channel customer. These may
  require the customer's own admin. If they return 403, add that customer
  to `GOOGLE_TENANTS` as a standalone tenant; standalone entries take
  precedence.
