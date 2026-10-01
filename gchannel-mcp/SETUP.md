# gchannel-mcp setup guide

This guide sets up gchannel-mcp from nothing: the Google Cloud service account, the
reseller (Channel Partner) side, each standalone client tenant, and the Cloudflare
secrets. You can follow it by hand or hand it to Claude in Cowork.

Code deploys are already done. Everything here is configuration in Google's and
Cloudflare's web consoles.

---

## Part 0 - How it connects to each tenant (read this first)

There are no passwords or per-client logins anywhere in this setup. It runs on one
Google service account plus **domain-wide delegation (DWD)**.

1. **The service account.** This is a robot identity in a Google Cloud project you
   own. It has a private key (the JSON file) and a numeric **Client ID**. The key
   lives only in Cloudflare.

2. **The permission slip (DWD).** In any Google Workspace tenant, a super admin can
   go to *Security > API controls > Domain-wide delegation* and add: "Client ID
   1234567890 may act as any user in this tenant, but only with these scopes." That
   entry is the only thing that grants access. The tenant can delete it at any time
   to revoke access.

3. **The connection.** When a tool runs against a tenant, the worker:
   - signs a request with the service account key that says "I am client 1234567890,
     acting as `adminEmail`, and I want these scopes";
   - sends it to Google. Google looks up the tenant that `adminEmail` belongs to and
     checks whether that tenant has a DWD entry for client 1234567890 with those
     scopes;
   - if so, gets back a one-hour access token for that tenant and calls the Admin
     API with it.

So **`adminEmail` is what decides which tenant you land in**, and the DWD entry in
that tenant is what allows it. One key serves any number of tenants: each tenant
adds the same Client ID to its own DWD list.

A `GOOGLE_TENANTS` entry therefore needs only:

```json
{ "name": "Client Co", "domain": "clientco.com", "adminEmail": "admin@clientco.com" }
```

| Field | Purpose |
|---|---|
| `name` | Friendly name. You can pass it as `tenant` in tools. |
| `domain` | Primary domain. You can pass it as `tenant` in tools. |
| `adminEmail` | An **active super admin** in that tenant. The worker acts as this user. |
| `customerId` (optional) | The tenant's `C0xxxxxxx` ID. The worker uses `my_customer` when it is absent. |
| `serviceAccountJson` (optional) | A different key for this tenant only. Normally left out. |

**Channel Partner customers** work the same way, with one difference: the worker
acts as a super admin of **your reseller domain**. Google lets a reseller admin
manage the Admin consoles of the reseller's customers, and the worker addresses each
customer by its customer ID. So Channel customers need **no** per-customer setup;
the DWD entry in your reseller domain covers them all. You only need
`GOOGLE_TENANTS` for clients that are not in your Partner Sales Console, or for a
customer that has turned off reseller access.

---

## Part 1 - Information to gather first

If Cowork is doing the clicking, have these ready. Claude will ask for them.

| # | Item | Where it comes from |
|---|---|---|
| 1 | Your **reseller domain** | The Google Workspace domain your Partner Sales Console sign-in belongs to (e.g. `altecusa.com`, or a separate reseller domain if you have one). |
| 2 | A **super admin email in the reseller domain** | Becomes `GOOGLE_RESELLER_ADMIN_EMAIL`. Must be an active user. |
| 3 | Which **Google Cloud organization/project** to use | Use one under the reseller domain's Cloud organization. Step 2.1 creates one if needed. |
| 4 | **Channel Account ID** | Partner Sales Console. Step 3.4. |
| 5 | For each standalone tenant: domain, a super admin email there, and a way to sign in as a super admin | From your records. |

You do these steps yourself, not Claude, because they involve credentials:

- signing in to Google and Cloudflare;
- downloading the service account JSON key;
- pasting secret values into Cloudflare.

Claude can navigate, read pages, and tell you exactly what to click and type.

---

## Part 2 - Google Cloud: project, APIs, service account, key

Sign in to https://console.cloud.google.com as a **super admin of the reseller
domain**.

### 2.1 Pick or create the project

1. Open the project picker at the top, then **New Project**.
2. **Name:** `gchannel-mcp`. **Organization:** your reseller domain's organization.
   **Location:** that organization.
3. Click **Create**, then make sure the new project is selected in the picker.

### 2.2 Enable the APIs

Go to **APIs & Services > Library**. Search for each of these and click **Enable**:

| API | Used for |
|---|---|
| **Cloud Channel API** | listing customers and entitlements |
| **Google Workspace Reseller API** (search "Reseller") | Workspace subscriptions |
| **Admin SDK API** | users, groups, OUs, devices, domains, audit logs |
| **Enterprise License Manager API** | license assignments |
| **Google Workspace Alert Center API** | security alerts |

### 2.3 Create the service account

1. Go to **IAM & Admin > Service Accounts > + Create service account**.
2. **Name:** `gchannel-mcp`. The ID fills in automatically.
3. Click **Create and continue**.
4. **Skip** the "Grant this service account access to project" roles. It needs no
   Cloud IAM roles; its access comes from DWD.
5. Click **Done**.
6. Click the new service account. On the **Details** tab, copy the **Unique ID**
   (a long number). **This is the Client ID** used in every DWD entry. Write it
   down.

### 2.4 Create the JSON key

1. In the service account, go to the **Keys** tab and click **Add key > Create new
   key > JSON > Create**. A `.json` file downloads.

   If you get **"Service account key creation is disabled"**, an organization
   policy is blocking it. Google turns this on by default for organizations
   created since 2024. To allow it:

   1. Switch the picker to the **organization** (not the project).
   2. Go to **IAM & Admin > IAM** and grant your own account
      **Organization Policy Administrator**. Super admin does not include it.
   3. Go to **IAM & Admin > Organization Policies** and find **Disable service
      account key creation** (`iam.disableServiceAccountKeyCreation`).
   4. Click **Manage policy**, then **Override parent's policy**. Add a rule with
      **Enforcement: Off**, scope it to the `gchannel-mcp` project if offered,
      and click **Set policy**.
   5. Return to step 1 of 2.4.

2. **Keep the file safe.** It is the master key to every tenant that trusts this
   Client ID. You will paste its contents into Cloudflare in Part 5. After that,
   delete the downloaded file. Never put it in the repo, `MCPs.txt`, email, or
   chat.

---

## Part 3 - Reseller domain and Partner Sales Console

### 3.1 Confirm the reseller admin

1. Sign in to https://admin.google.com as a super admin of the reseller domain.
2. Go to **Directory > Users** and confirm the user chosen for
   `GOOGLE_RESELLER_ADMIN_EMAIL` exists and is **active**.
3. Open the user, go to **Admin roles and privileges**, and confirm it shows
   **Super Admin**.

### 3.2 Add the DWD entry in the reseller domain

1. In the reseller domain's Admin console, go to **Security > Access and data
   control > API controls**.
2. At the bottom, under **Domain wide delegation**, click **Manage Domain Wide
   Delegation > Add new**.
3. **Client ID:** the Unique ID from step 2.3.
4. **OAuth scopes:** paste this single line, which includes `apps.order` for the
   Channel and Reseller APIs:

```
https://www.googleapis.com/auth/apps.order,https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.user.security,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.orgunit.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly,https://www.googleapis.com/auth/admin.directory.customer.readonly,https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly,https://www.googleapis.com/auth/admin.directory.device.mobile.readonly,https://www.googleapis.com/auth/admin.directory.rolemanagement.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/apps.licensing,https://www.googleapis.com/auth/apps.alerts
```

5. Click **Authorize**. The entry usually works within minutes, but Google says it
   can take up to 24 hours.

### 3.3 Check the Partner Sales Console for an API link step

1. Sign in to https://partners.cloud.google.com (Partner Sales Console) with your
   reseller sign-in.
2. Open **Settings** and look for a section about the **Cloud Channel API**,
   **API access**, or **integrations**. If it asks you to link a Google Cloud
   project or add a service account, add the `gchannel-mcp` project or the service
   account email (`gchannel-mcp@<project>.iam.gserviceaccount.com`).

   This step is not certain to exist. The code uses the DWD route Google documents
   for the Channel API, which needs no link. Google has changed this page over
   time, so check it once. If the first test in Part 6 returns a 403 from the
   Channel API, this page is the first place to look.

### 3.4 Copy the Channel Account ID

In the Partner Sales Console, go to **Settings** and copy the **Account ID**. It
looks like `C01abc2de`, or a longer string. Some screens show it as
`accounts/XXXX`; copy only the part after `accounts/`. This is
`CHANNEL_ACCOUNT_ID`.

### 3.5 Customers that block reseller access

A Workspace customer can switch off its reseller's admin access in its own Admin
console (Account settings > reseller access). If a Channel customer fails in Part 6
with a 403 or "not authorized for this customer", either ask them to re-enable
reseller access, or treat them as a standalone tenant (Part 4).

---

## Part 4 - Each standalone tenant (not in the Partner Sales Console)

Repeat for each client. This takes about 5 minutes per tenant.

### 4.1 Choose the admin user the worker will act as

Choose an **active super admin** in the client's tenant. Either:

- **Recommended:** a dedicated account such as `msp-api@clientdomain.com`, made a
  super admin. Audit logs then show clearly that the MSP tool made a change. It
  may need a license, depending on the client's edition and auto-licensing.
- An existing admin account you already use for that client. If that person
  leaves or the account is suspended, the worker loses access to the tenant.

### 4.2 Add the DWD entry in the client's tenant

1. Sign in to https://admin.google.com as a **super admin of the client's tenant**.
2. Go to **Security > Access and data control > API controls > Manage Domain Wide
   Delegation > Add new**.
3. **Client ID:** the **same** Unique ID from step 2.3.
4. **OAuth scopes:** the same line as in step 3.2, but **without** `apps.order` at
   the front:

```
https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.user.security,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.orgunit.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly,https://www.googleapis.com/auth/admin.directory.customer.readonly,https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly,https://www.googleapis.com/auth/admin.directory.device.mobile.readonly,https://www.googleapis.com/auth/admin.directory.rolemanagement.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly,https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/apps.licensing,https://www.googleapis.com/auth/apps.alerts
```

   If a client wants the tool to be **read-only**, drop the three write scopes:
   `admin.directory.user`, `admin.directory.user.security` and
   `admin.directory.group`. Read tools keep working, and write tools fail for that
   tenant with `unauthorized_client`.

5. Click **Authorize**.

### 4.3 (Optional) Note the customer ID

In the client's Admin console, go to **Account > Account settings > Profile** and
copy the **Customer ID** (`C0xxxxxxx`). Adding it lets you pass it as `tenant`. It
is not required.

### 4.4 Add the tenant to the list

Build up the `GOOGLE_TENANTS` value as one JSON array containing every standalone
tenant:

```json
[
  { "name": "Client Co", "domain": "clientco.com", "adminEmail": "msp-api@clientco.com" },
  { "name": "Other Org", "domain": "other.org", "adminEmail": "admin@other.org", "customerId": "C01abcd23" }
]
```

Cloudflare secrets cannot be read back once saved. Keep the current list in Hudu
(for example, a "gchannel-mcp tenants" article), or rebuild it from `list_tenants`
output. To add a tenant later, paste the **whole** updated array as the new secret
value; it replaces the old one.

To remove a tenant: delete its DWD entry in that tenant's Admin console, which
revokes access immediately, and remove it from the array.

---

## Part 5 - Cloudflare secrets

1. Go to https://dash.cloudflare.com, then **Workers & Pages > gchannel-mcp >
   Settings > Variables and Secrets**.
2. Click **+ Add** for each of the following, with **Type: Secret**:

| Name | Value |
|---|---|
| `MCP_AUTH_TOKEN` | A long random string (40+ characters). Generate it in a password manager. You also need it for the connector registration in Part 6. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the downloaded `.json` key in Notepad, select all, and paste the **entire** contents. |
| `GOOGLE_RESELLER_ADMIN_EMAIL` | The reseller super admin from step 3.1. |
| `CHANNEL_ACCOUNT_ID` | The value from step 3.4. |
| `GOOGLE_TENANTS` | The JSON array from step 4.4. Skip it if you have no standalone tenants yet. |

3. Click **Deploy**.
4. Delete the downloaded `.json` key file from your computer.

---

## Part 6 - Connect and test

1. Register the connector the same way as the other workers, such as cipp-mcp:
   - **URL:** `https://gchannel-mcp.young-math-a33a.workers.dev/mcp`
   - **Header:** `Authorization: Bearer <MCP_AUTH_TOKEN>`
2. Ask Claude to run **`healthcheck`**. Expected result: the service account email,
   a `channelCustomers` count, and your standalone domains.
3. Ask Claude to run **`list_tenants`**. Every Channel customer and standalone
   tenant should appear.
4. Ask Claude to run **`healthcheck` with `tenant`** set to one Channel customer
   and to one standalone tenant. Both should show `directoryOk: true`.
5. Try `get_2sv_report`, `list_alerts` and `get_login_activity` on a Channel
   customer. These are the calls Google's documentation leaves unclear for
   reseller admins. If any return 403, add that customer as a standalone tenant
   (Part 4).

### Troubleshooting

| Error text | Meaning | Fix |
|---|---|---|
| `unauthorized_client` | The tenant has no DWD entry for this Client ID, or the entry lacks a scope the tool asked for. The error lists the requested scopes. | Check the DWD entry's Client ID and scopes in that tenant (step 3.2 or 4.2). Wait up to 24 hours after a new entry. |
| `invalid_grant ... Not a valid email` | `adminEmail` / `GOOGLE_RESELLER_ADMIN_EMAIL` does not exist or is suspended. | Correct the email. |
| `invalid_grant ... Invalid JWT Signature` | The key was pasted incompletely or has been deleted in Google Cloud. | Re-paste the full JSON, or create a new key. |
| 403 `... has not been used in project ... or it is disabled` | An API is not enabled. | Enable it (step 2.2). |
| 403 from `cloudchannel.googleapis.com` | The reseller admin or project is not recognized by the Partner Sales Console. | Re-check step 3.3, and confirm the admin is a reseller domain super admin. |
| 403 on a Channel customer's users or alerts | The customer blocked reseller access, or that API does not accept reseller admins. | Use step 3.5 or Part 4. |
| `No tenant matches` | Typo, or the customer is new. | Run `list_tenants` with `refresh: true`. |
| HTTP 503 from the worker | `MCP_AUTH_TOKEN` or `GOOGLE_SERVICE_ACCOUNT_JSON` is not set. | Part 5. |

---

## Security notes

- The JSON key plus a tenant's DWD entry gives near-full admin access to that
  tenant. Keep the key only in Cloudflare.
- To rotate the key: in Google Cloud, create a new key, update the secret in
  Cloudflare, then delete the old key. You do not need to change any tenant's DWD
  entry, because the Client ID stays the same.
- To revoke everything at once, delete the service account key in Google Cloud.
  To revoke one tenant, delete its DWD entry.
- The worker cannot place orders, change subscriptions, or delete users.
