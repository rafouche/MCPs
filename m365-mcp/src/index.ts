export interface Env {
  M365_CLIENT_ID: string;
  M365_CLIENT_SECRET: string;
  M365_TENANTS: string;    // JSON: { "altec": "tenant-guid", "goldmechanical": "tenant-guid" }
}

const GRAPH = "https://graph.microsoft.com/v1.0";

// ─── Multi-tenant token cache ─────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expires: number }>();

function getTenants(env: Env): Record<string, string> {
  try { return JSON.parse(env.M365_TENANTS); }
  catch { throw new Error("M365_TENANTS is not valid JSON. Format: {\"altec\":\"tenant-id-guid\"}"); }
}

function resolveTenant(env: Env, name?: string): { tenantId: string; name: string } {
  const tenants = getTenants(env);
  const keys = Object.keys(tenants);
  if (!keys.length) throw new Error("No tenants configured in M365_TENANTS");
  const key = name?.toLowerCase() ?? keys[0];
  const tenantId = tenants[key];
  if (!tenantId) throw new Error(`Tenant "${name}" not found. Available: ${keys.join(", ")}`);
  return { tenantId, name: key };
}

async function getToken(env: Env, tenantId: string): Promise<string> {
  const cached = tokenCache.get(tenantId);
  if (cached && cached.expires > Date.now() + 60000) return cached.token;
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.M365_CLIENT_ID,
        client_secret: env.M365_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }).toString(),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`M365 token failed for tenant ${tenantId} (${res.status}): ${err}`);
  }
  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache.set(tenantId, { token: data.access_token, expires: Date.now() + data.expires_in * 1000 });
  return data.access_token;
}

// ─── Graph API helpers ────────────────────────────────────────────────────────

async function gGet(env: Env, tenantId: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken(env, tenantId);
  const url = new URL(`${GRAPH}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function gPost(env: Env, tenantId: string, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken(env, tenantId);
  const res = await fetch(`${GRAPH}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  const text = await res.text(); return text ? JSON.parse(text) : { success: true };
}

async function gPatch(env: Env, tenantId: string, path: string, body: unknown): Promise<unknown> {
  const token = await getToken(env, tenantId);
  const res = await fetch(`${GRAPH}${path}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function gDelete(env: Env, tenantId: string, path: string): Promise<unknown> {
  const token = await getToken(env, tenantId);
  const res = await fetch(`${GRAPH}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`DELETE ${path} failed (${res.status}): ${await res.text()}`);
  return { success: true };
}

// ─── Status builder ───────────────────────────────────────────────────────────

async function buildStatus(env: Env): Promise<unknown> {
  const tenants = getTenants(env);
  const results = await Promise.all(
    Object.entries(tenants).map(async ([name, tenantId]) => {
      try {
        const [org, health] = await Promise.allSettled([
          gGet(env, tenantId, "/organization", { "$select": "displayName,verifiedDomains" }),
          gGet(env, tenantId, "/admin/serviceAnnouncement/healthOverviews", { "$select": "service,status" }),
        ]);
        const orgName = org.status === "fulfilled" ? (org.value as any)?.value?.[0]?.displayName ?? name : name;
        const services: any[] = health.status === "fulfilled" ? (health.value as any)?.value ?? [] : [];
        const unhealthy = services.filter((s: any) => s.status !== "serviceOperational").length;
        return { tenant: name, org: orgName, status: "ok", unhealthyServices: unhealthy };
      } catch (err) {
        return { tenant: name, status: "error", error: (err as Error).message };
      }
    })
  );
  return { updated: new Date().toISOString(), tenants: results };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const TENANT_PARAM = { tenant: { type: "string", description: "Tenant name key e.g. altec, goldmechanical (omit to use first configured tenant)" } };

const TOOLS = [
  // Management
  { name: "list_tenants", description: "List all configured M365 tenants managed by this MCP", inputSchema: { type: "object", properties: {} } },
  { name: "healthcheck", description: "Test connectivity to a tenant and verify credentials", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },
  { name: "get_organization", description: "Get organization details including display name, verified domains, and license summary", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },

  // Users — Read
  { name: "list_users", description: "List users in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number", description: "Max results (default 100)" }, filter: { type: "string", description: "OData filter e.g. accountEnabled eq true" }, select: { type: "string", description: "Comma-separated fields to return" }, search: { type: "string", description: "Search by displayName or email" } } } },
  { name: "get_user", description: "Get full details for a user by ID or UPN", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string", description: "User ID (GUID) or UPN (email)" } }, required: ["userId"] } },
  { name: "get_user_member_of", description: "Get groups and directory roles a user is a member of", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "get_user_licenses", description: "Get licenses assigned to a user", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "get_user_auth_methods", description: "Get MFA authentication methods registered for a user", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "get_user_manager", description: "Get the manager of a user", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "get_user_mailbox_settings", description: "Get mailbox settings for a user (OOO, timezone, language)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },

  // Users — Write
  { name: "create_user", description: "Create a new user in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM, displayName: { type: "string" }, userPrincipalName: { type: "string", description: "UPN e.g. john@contoso.com" }, mailNickname: { type: "string", description: "Alias before @ (auto-derived from UPN if omitted)" }, password: { type: "string", description: "Initial password" }, forceChangePasswordNextSignIn: { type: "boolean", description: "Require password change on first login (default true)" }, accountEnabled: { type: "boolean", description: "Enable account (default true)" }, jobTitle: { type: "string" }, department: { type: "string" }, usageLocation: { type: "string", description: "ISO 3166-1 alpha-2 country code e.g. US (required for license assignment)" } }, required: ["displayName", "userPrincipalName", "password"] } },
  { name: "update_user", description: "Update a user's profile, job title, department, or account state", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" }, displayName: { type: "string" }, jobTitle: { type: "string" }, department: { type: "string" }, mobilePhone: { type: "string" }, officeLocation: { type: "string" }, accountEnabled: { type: "boolean" }, usageLocation: { type: "string" }, manager: { type: "string", description: "Manager user ID or UPN" } }, required: ["userId"] } },
  { name: "delete_user", description: "Delete a user (moves to deleted users, recoverable for 30 days)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "reset_user_password", description: "Reset a user's password", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" }, newPassword: { type: "string" }, forceChangePasswordNextSignIn: { type: "boolean", description: "Default true" } }, required: ["userId", "newPassword"] } },
  { name: "revoke_user_sessions", description: "Revoke all sign-in sessions for a user (force re-authentication)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "update_user_mailbox_settings", description: "Update mailbox settings — OOO message, timezone, language", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" }, automaticRepliesEnabled: { type: "boolean" }, internalReplyMessage: { type: "string" }, externalReplyMessage: { type: "string" }, timezone: { type: "string", description: "IANA timezone e.g. America/Chicago" } }, required: ["userId"] } },
  { name: "assign_license", description: "Assign an M365 license to a user", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" }, skuId: { type: "string", description: "License SKU ID (GUID) from list_subscribed_skus" } }, required: ["userId", "skuId"] } },
  { name: "remove_license", description: "Remove an M365 license from a user", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" }, skuId: { type: "string", description: "License SKU ID to remove" } }, required: ["userId", "skuId"] } },

  // Groups
  { name: "list_groups", description: "List groups in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number" }, filter: { type: "string", description: "OData filter e.g. groupTypes/any(c:c eq 'Unified') for M365 groups" } } } },
  { name: "get_group", description: "Get a group by ID", inputSchema: { type: "object", properties: { ...TENANT_PARAM, groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "list_group_members", description: "List members of a group", inputSchema: { type: "object", properties: { ...TENANT_PARAM, groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "create_group", description: "Create a new group (security or M365)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, displayName: { type: "string" }, description: { type: "string" }, mailNickname: { type: "string" }, groupType: { type: "string", description: "security or m365 (default security)", enum: ["security", "m365"] }, mailEnabled: { type: "boolean" } }, required: ["displayName", "mailNickname"] } },
  { name: "add_group_member", description: "Add a user to a group", inputSchema: { type: "object", properties: { ...TENANT_PARAM, groupId: { type: "string" }, userId: { type: "string" } }, required: ["groupId", "userId"] } },
  { name: "remove_group_member", description: "Remove a user from a group", inputSchema: { type: "object", properties: { ...TENANT_PARAM, groupId: { type: "string" }, userId: { type: "string" } }, required: ["groupId", "userId"] } },
  { name: "delete_group", description: "Delete a group", inputSchema: { type: "object", properties: { ...TENANT_PARAM, groupId: { type: "string" } }, required: ["groupId"] } },

  // Licenses
  { name: "list_subscribed_skus", description: "List all M365 license SKUs in a tenant — shows available licenses, consumed counts, and SKU IDs needed for assignment", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },

  // Devices / Intune
  { name: "list_managed_devices", description: "List Intune-managed devices in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number" }, filter: { type: "string", description: "OData filter e.g. operatingSystem eq 'Windows'" } } } },
  { name: "get_managed_device", description: "Get details for a specific Intune-managed device", inputSchema: { type: "object", properties: { ...TENANT_PARAM, deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "wipe_managed_device", description: "Wipe an Intune-managed device (factory reset)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "retire_managed_device", description: "Retire (unenroll) an Intune-managed device", inputSchema: { type: "object", properties: { ...TENANT_PARAM, deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "sync_managed_device", description: "Force a managed device to check in with Intune for policy sync", inputSchema: { type: "object", properties: { ...TENANT_PARAM, deviceId: { type: "string" } }, required: ["deviceId"] } },
  { name: "list_device_compliance_policies", description: "List Intune device compliance policies", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },
  { name: "list_device_configuration_profiles", description: "List Intune device configuration profiles", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },

  // Conditional Access
  { name: "list_conditional_access_policies", description: "List all Conditional Access policies in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },
  { name: "get_conditional_access_policy", description: "Get details of a specific Conditional Access policy", inputSchema: { type: "object", properties: { ...TENANT_PARAM, policyId: { type: "string" } }, required: ["policyId"] } },

  // Security / Identity Protection
  { name: "list_risky_users", description: "List users flagged as risky by Identity Protection", inputSchema: { type: "object", properties: { ...TENANT_PARAM, filter: { type: "string", description: "e.g. riskLevel eq 'high'" } } } },
  { name: "list_risk_detections", description: "List Identity Protection risk detections", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number" } } } },
  { name: "confirm_user_compromised", description: "Confirm a user is compromised (blocks sign-in and marks risky)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },
  { name: "dismiss_user_risk", description: "Dismiss the risk state for a user", inputSchema: { type: "object", properties: { ...TENANT_PARAM, userId: { type: "string" } }, required: ["userId"] } },

  // Audit / Sign-in Logs
  { name: "list_sign_in_logs", description: "List Azure AD sign-in logs (up to 30 days)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number", description: "Max results (default 50)" }, filter: { type: "string", description: "OData filter e.g. userPrincipalName eq 'user@domain.com'" } } } },
  { name: "list_audit_logs", description: "List Azure AD audit log events (admin actions, policy changes)", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number", description: "Max results (default 50)" }, filter: { type: "string", description: "OData filter e.g. activityDisplayName eq 'Add user'" } } } },

  // Service Health
  { name: "list_service_health", description: "Get Microsoft 365 service health status for a tenant (Exchange, Teams, SharePoint, etc.)", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },
  { name: "list_service_messages", description: "List Microsoft 365 service announcements and incident messages", inputSchema: { type: "object", properties: { ...TENANT_PARAM, top: { type: "number", description: "Max results (default 20)" } } } },

  // SharePoint / OneDrive
  { name: "list_sharepoint_sites", description: "List SharePoint sites in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM, search: { type: "string", description: "Search term for site name" } } } },
  { name: "get_sharepoint_site", description: "Get details of a specific SharePoint site by ID or URL", inputSchema: { type: "object", properties: { ...TENANT_PARAM, siteId: { type: "string", description: "Site ID or site URL path e.g. contoso.sharepoint.com:/sites/project" } }, required: ["siteId"] } },
  { name: "list_onedrive_usage", description: "Get OneDrive usage report for users in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM, period: { type: "string", description: "D7, D30, D90, D180 (default D30)", enum: ["D7", "D30", "D90", "D180"] } } } },

  // Directory Roles
  { name: "list_directory_roles", description: "List active directory roles in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },
  { name: "list_role_members", description: "List members of a directory role", inputSchema: { type: "object", properties: { ...TENANT_PARAM, roleId: { type: "string" } }, required: ["roleId"] } },

  // Domains
  { name: "list_domains", description: "List verified domains in a tenant", inputSchema: { type: "object", properties: { ...TENANT_PARAM } } },

  // Raw escape hatch
  { name: "graph_raw_request", description: "Make an arbitrary authenticated Microsoft Graph API request — use for any endpoint not covered by other tools", inputSchema: { type: "object", properties: { ...TENANT_PARAM, method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"], description: "HTTP method (default GET)" }, path: { type: "string", description: "Graph path e.g. /users or /groups/{id}/members" }, body: { description: "Request body for POST/PATCH" }, params: { type: "object", description: "Query string parameters" } }, required: ["path"] } },
];

// ─── Tool runner ──────────────────────────────────────────────────────────────

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  if (name === "list_tenants") {
    const t = getTenants(env);
    return JSON.stringify(Object.entries(t).map(([k, v]) => ({ name: k, tenantId: v })), null, 2);
  }

  const { tenantId, name: tName } = resolveTenant(env, args.tenant as string | undefined);

  switch (name) {
    case "healthcheck": {
      const d = await gGet(env, tenantId, "/organization", { "$select": "displayName,id" });
      return `Connected OK to ${tName} (${tenantId}). Org: ${JSON.stringify((d as any)?.value?.[0]?.displayName)}`;
    }
    case "get_organization": return JSON.stringify(await gGet(env, tenantId, "/organization"), null, 2);

    // Users Read
    case "list_users": {
      const p: Record<string, string> = { "$top": String(args.top ?? 100) };
      if (args.filter) p["$filter"] = args.filter as string;
      if (args.select) p["$select"] = args.select as string;
      if (args.search) { p["$search"] = `"displayName:${args.search}" OR "mail:${args.search}"`; }
      return JSON.stringify(await gGet(env, tenantId, "/users", p), null, 2);
    }
    case "get_user": return JSON.stringify(await gGet(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}`), null, 2);
    case "get_user_member_of": return JSON.stringify(await gGet(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/memberOf`), null, 2);
    case "get_user_licenses": return JSON.stringify(await gGet(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/licenseDetails`), null, 2);
    case "get_user_auth_methods": return JSON.stringify(await gGet(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/authentication/methods`), null, 2);
    case "get_user_manager": return JSON.stringify(await gGet(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/manager`), null, 2);
    case "get_user_mailbox_settings": return JSON.stringify(await gGet(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/mailboxSettings`), null, 2);

    // Users Write
    case "create_user": {
      const upn = args.userPrincipalName as string;
      const body: Record<string, unknown> = {
        displayName: args.displayName,
        userPrincipalName: upn,
        mailNickname: args.mailNickname ?? upn.split("@")[0],
        accountEnabled: args.accountEnabled ?? true,
        passwordProfile: { password: args.password, forceChangePasswordNextSignIn: args.forceChangePasswordNextSignIn ?? true },
      };
      if (args.jobTitle) body.jobTitle = args.jobTitle;
      if (args.department) body.department = args.department;
      if (args.usageLocation) body.usageLocation = args.usageLocation;
      return JSON.stringify(await gPost(env, tenantId, "/users", body), null, 2);
    }
    case "update_user": {
      const { userId, tenant: _t, ...rest } = args;
      const body: Record<string, unknown> = {};
      ["displayName", "jobTitle", "department", "mobilePhone", "officeLocation", "accountEnabled", "usageLocation"].forEach(k => { if (rest[k] !== undefined) body[k] = rest[k]; });
      if (rest.manager) {
        await gPost(env, tenantId, `/users/${encodeURIComponent(userId as string)}/manager/$ref`, { "@odata.id": `https://graph.microsoft.com/v1.0/users/${rest.manager}` });
      }
      if (Object.keys(body).length) await gPatch(env, tenantId, `/users/${encodeURIComponent(userId as string)}`, body);
      return JSON.stringify({ success: true, updated: Object.keys(body) }, null, 2);
    }
    case "delete_user": return JSON.stringify(await gDelete(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}`), null, 2);
    case "reset_user_password": return JSON.stringify(await gPatch(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}`, { passwordProfile: { password: args.newPassword, forceChangePasswordNextSignIn: args.forceChangePasswordNextSignIn ?? true } }), null, 2);
    case "revoke_user_sessions": return JSON.stringify(await gPost(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/revokeSignInSessions`), null, 2);
    case "update_user_mailbox_settings": {
      const body: Record<string, unknown> = {};
      if (args.automaticRepliesEnabled !== undefined) body.automaticRepliesSetting = { status: args.automaticRepliesEnabled ? "enabled" : "disabled", internalReplyMessage: args.internalReplyMessage ?? "", externalReplyMessage: args.externalReplyMessage ?? "" };
      if (args.timezone) body.timeZone = args.timezone;
      return JSON.stringify(await gPatch(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/mailboxSettings`, body), null, 2);
    }
    case "assign_license": return JSON.stringify(await gPost(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/assignLicense`, { addLicenses: [{ skuId: args.skuId }], removeLicenses: [] }), null, 2);
    case "remove_license": return JSON.stringify(await gPost(env, tenantId, `/users/${encodeURIComponent(args.userId as string)}/assignLicense`, { addLicenses: [], removeLicenses: [args.skuId] }), null, 2);

    // Groups
    case "list_groups": { const p: Record<string, string> = { "$top": String(args.top ?? 100) }; if (args.filter) p["$filter"] = args.filter as string; return JSON.stringify(await gGet(env, tenantId, "/groups", p), null, 2); }
    case "get_group": return JSON.stringify(await gGet(env, tenantId, `/groups/${args.groupId}`), null, 2);
    case "list_group_members": return JSON.stringify(await gGet(env, tenantId, `/groups/${args.groupId}/members`), null, 2);
    case "create_group": {
      const isM365 = args.groupType === "m365";
      return JSON.stringify(await gPost(env, tenantId, "/groups", {
        displayName: args.displayName,
        description: args.description ?? "",
        mailNickname: args.mailNickname,
        mailEnabled: isM365 ? (args.mailEnabled ?? true) : false,
        securityEnabled: !isM365,
        groupTypes: isM365 ? ["Unified"] : [],
      }), null, 2);
    }
    case "add_group_member": return JSON.stringify(await gPost(env, tenantId, `/groups/${args.groupId}/members/$ref`, { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${args.userId}` }), null, 2);
    case "remove_group_member": return JSON.stringify(await gDelete(env, tenantId, `/groups/${args.groupId}/members/${args.userId}/$ref`), null, 2);
    case "delete_group": return JSON.stringify(await gDelete(env, tenantId, `/groups/${args.groupId}`), null, 2);

    // Licenses
    case "list_subscribed_skus": return JSON.stringify(await gGet(env, tenantId, "/subscribedSkus"), null, 2);

    // Intune
    case "list_managed_devices": { const p: Record<string, string> = { "$top": String(args.top ?? 100) }; if (args.filter) p["$filter"] = args.filter as string; return JSON.stringify(await gGet(env, tenantId, "/deviceManagement/managedDevices", p), null, 2); }
    case "get_managed_device": return JSON.stringify(await gGet(env, tenantId, `/deviceManagement/managedDevices/${args.deviceId}`), null, 2);
    case "wipe_managed_device": return JSON.stringify(await gPost(env, tenantId, `/deviceManagement/managedDevices/${args.deviceId}/wipe`, {}), null, 2);
    case "retire_managed_device": return JSON.stringify(await gPost(env, tenantId, `/deviceManagement/managedDevices/${args.deviceId}/retire`), null, 2);
    case "sync_managed_device": return JSON.stringify(await gPost(env, tenantId, `/deviceManagement/managedDevices/${args.deviceId}/syncDevice`), null, 2);
    case "list_device_compliance_policies": return JSON.stringify(await gGet(env, tenantId, "/deviceManagement/deviceCompliancePolicies"), null, 2);
    case "list_device_configuration_profiles": return JSON.stringify(await gGet(env, tenantId, "/deviceManagement/deviceConfigurations"), null, 2);

    // Conditional Access
    case "list_conditional_access_policies": return JSON.stringify(await gGet(env, tenantId, "/identity/conditionalAccess/policies"), null, 2);
    case "get_conditional_access_policy": return JSON.stringify(await gGet(env, tenantId, `/identity/conditionalAccess/policies/${args.policyId}`), null, 2);

    // Security
    case "list_risky_users": { const p: Record<string, string> = {}; if (args.filter) p["$filter"] = args.filter as string; return JSON.stringify(await gGet(env, tenantId, "/identityProtection/riskyUsers", p), null, 2); }
    case "list_risk_detections": return JSON.stringify(await gGet(env, tenantId, "/identityProtection/riskDetections", { "$top": String(args.top ?? 50) }), null, 2);
    case "confirm_user_compromised": return JSON.stringify(await gPost(env, tenantId, "/identityProtection/riskyUsers/confirmCompromised", { userIds: [args.userId] }), null, 2);
    case "dismiss_user_risk": return JSON.stringify(await gPost(env, tenantId, "/identityProtection/riskyUsers/dismiss", { userIds: [args.userId] }), null, 2);

    // Logs
    case "list_sign_in_logs": { const p: Record<string, string> = { "$top": String(args.top ?? 50) }; if (args.filter) p["$filter"] = args.filter as string; return JSON.stringify(await gGet(env, tenantId, "/auditLogs/signIns", p), null, 2); }
    case "list_audit_logs": { const p: Record<string, string> = { "$top": String(args.top ?? 50) }; if (args.filter) p["$filter"] = args.filter as string; return JSON.stringify(await gGet(env, tenantId, "/auditLogs/directoryAudits", p), null, 2); }

    // Service Health
    case "list_service_health": return JSON.stringify(await gGet(env, tenantId, "/admin/serviceAnnouncement/healthOverviews"), null, 2);
    case "list_service_messages": return JSON.stringify(await gGet(env, tenantId, "/admin/serviceAnnouncement/messages", { "$top": String(args.top ?? 20) }), null, 2);

    // SharePoint
    case "list_sharepoint_sites": { const p: Record<string, string> = {}; if (args.search) p["search"] = args.search as string; return JSON.stringify(await gGet(env, tenantId, "/sites", p), null, 2); }
    case "get_sharepoint_site": return JSON.stringify(await gGet(env, tenantId, `/sites/${args.siteId}`), null, 2);
    case "list_onedrive_usage": return JSON.stringify(await gGet(env, tenantId, `/reports/getOneDriveUsageAccountDetail(period='${args.period ?? "D30"}')`), null, 2);

    // Directory Roles
    case "list_directory_roles": return JSON.stringify(await gGet(env, tenantId, "/directoryRoles"), null, 2);
    case "list_role_members": return JSON.stringify(await gGet(env, tenantId, `/directoryRoles/${args.roleId}/members`), null, 2);

    // Domains
    case "list_domains": return JSON.stringify(await gGet(env, tenantId, "/domains"), null, 2);

    // Raw
    case "graph_raw_request": {
      const m = (args.method as string | undefined) ?? "GET";
      const p = args.params ? Object.fromEntries(Object.entries(args.params as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined;
      if (m === "GET") return JSON.stringify(await gGet(env, tenantId, args.path as string, p), null, 2);
      if (m === "DELETE") return JSON.stringify(await gDelete(env, tenantId, args.path as string), null, 2);
      if (m === "POST") return JSON.stringify(await gPost(env, tenantId, args.path as string, args.body), null, 2);
      if (m === "PATCH") return JSON.stringify(await gPatch(env, tenantId, args.path as string, args.body ?? {}), null, 2);
      throw new Error(`Unsupported method: ${m}`);
    }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });

    if (url.pathname === "/status") {
      try { return new Response(JSON.stringify(await buildStatus(env)), { headers: JSON_HEADERS }); }
      catch (err) { return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS }); }
    }

    // Consent URL generator — send to client Global Admin to grant access
    if (url.pathname.startsWith("/consent/")) {
      const clientName = url.pathname.replace("/consent/", "");
      const tenants = getTenants(env);
      const tenantId = tenants[clientName.toLowerCase()];
      if (!tenantId) return new Response(`Tenant "${clientName}" not found in M365_TENANTS`, { status: 404, headers: CORS });
      const consentUrl = `https://login.microsoftonline.com/${tenantId}/adminconsent?client_id=${env.M365_CLIENT_ID}&redirect_uri=${encodeURIComponent(url.origin + "/consent-complete")}`;
      return new Response(JSON.stringify({ tenant: clientName, tenantId, consentUrl, instructions: `Have the Global Admin of ${clientName} visit the consentUrl to grant access` }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/consent-complete") {
      return new Response(`<html><body style="font-family:sans-serif;padding:40px;max-width:500px"><h2>✅ Access Granted</h2><p>Admin consent has been granted. This tenant is now accessible via the Altec M365 MCP.</p><p>You can close this tab.</p></body></html>`, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      let rawBody: string;
      try { rawBody = await request.text(); } catch (err) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Could not read body: ${(err as Error).message}` } }), { status: 400, headers: JSON_HEADERS }); }
      if (!rawBody?.trim()) return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Empty request body" } }), { status: 400, headers: JSON_HEADERS });
      let body: unknown;
      try { body = JSON.parse(rawBody); } catch (err) { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Invalid JSON: ${(err as Error).message} (received: ${rawBody.substring(0, 120)})` } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg;
        if (id === undefined) continue;
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Microsoft 365 Multi-Tenant MCP", version: "1.0.0" } } });
          else if (method === "tools/list") responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          else if (method === "tools/call") { const text = await runTool(params?.name as string, (params?.arguments ?? {}) as Record<string, unknown>, env); responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }); }
          else if (method === "ping") responses.push({ jsonrpc: "2.0", id, result: {} });
          else responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        } catch (err) { responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }); }
      }
      const out = responses.length === 0 ? null : responses.length === 1 ? responses[0] : responses;
      if (out === null) return new Response(null, { status: 204, headers: CORS });
      return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
    }

    return new Response("M365 Multi-Tenant MCP — POST /mcp | GET /status | GET /consent/{tenantName}", { status: 200, headers: CORS });
  },
};
