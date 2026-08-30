/**
 * cipp-mcp
 *
 * Wraps CIPP's own API (client_credentials grant against Entra, then
 * bearer-token REST calls to CIPP's /api/<Endpoint> routes) as an MCP
 * tool server. Several tools below (add_user, disable_user/enable_user,
 * reset_user_password, set_user_license, add/remove_group_member,
 * set_mailbox_ooo, convert_mailbox, revoke_user_sessions) POST to
 * write endpoints — this worker does not enforce read-only itself.
 * Whether those calls actually succeed is decided entirely by the
 * CIPP-API client's assigned role in CIPP (CIPP > Integrations >
 * CIPP-API): a client on the `readonly` base role, or a custom role
 * without ReadWrite on the relevant categories (Identity/Users, Groups,
 * Exchange/Mailboxes, Sessions), gets 403s on every write call above
 * even though this code sends them correctly. To enable writes, edit
 * that API client in CIPP and assign it `editor` (or a custom role with
 * ReadWrite on just those categories) instead of `readonly`, then
 * Actions > Save Azure Configuration. See docs.cipp.app's "CIPP-API &
 * MCP" and "Setting Up SSO and Getting Access to CIPP" (Custom Roles)
 * pages.
 *
 * Full API coverage: alongside the named tools above, cipp_api_get/cipp_api_post
 * are a generic passthrough to ANY CIPP endpoint by name (message trace, quarantine,
 * GDAP, transport rules, etc.) — added so this worker doesn't need a hand-written
 * tool per CIPP endpoint to have full read/write coverage, mirroring why CIPP's own
 * native MCP moved from listing 70+ tools directly to a search/exec pattern (see
 * docs.cipp.app "CIPP-API & MCP" > Scoping Copilot Tool Imports). Endpoint names are
 * documented at docs.cipp.app/api-documentation.
 *
 * CIPP-NG note: CIPP's July-2026 "next generation" hosted infra move
 * changes the instance URL (to CIPPXXXX.azurewebsites.net or a
 * re-mapped custom domain) and re-issues the API client's Tenant ID /
 * Token URL / API URL shown on the CIPP-API page. After migrating a
 * tenant via management.cipp.app, re-check those values and re-copy the
 * Application secret (Actions > Reset Application Secret rotates it) —
 * a stale CIPP_URL or secret from the pre-migration instance fails
 * every tool call, not just writes.
 *
 * SECRETS (wrangler secret put):
 *   CIPP_URL            base URL of the CIPP instance (API URL from the CIPP-API page, no trailing /api)
 *   CIPP_CLIENT_ID       Application (client) ID of the CIPP-API client
 *   CIPP_CLIENT_SECRET   that client's Application secret
 *   CIPP_TENANT_ID       Tenant ID shown on the CIPP-API page
 */

export interface Env {
  CIPP_URL: string;
  CIPP_CLIENT_ID: string;
  CIPP_CLIENT_SECRET: string;
  CIPP_TENANT_ID: string;
}

async function getToken(env: Env): Promise<string> {
  const scope = `api://${env.CIPP_CLIENT_ID}/.default`;
  const res = await fetch(`https://login.microsoftonline.com/${env.CIPP_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.CIPP_CLIENT_ID,
      client_secret: env.CIPP_CLIENT_SECRET,
      scope,
      grant_type: "client_credentials",
    }).toString(),
  });
  if (!res.ok) throw new Error(`CIPP auth failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function cippGet(env: Env, endpoint: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken(env);
  const url = new URL(`${env.CIPP_URL}/api/${endpoint}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${endpoint} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function cippPost(env: Env, endpoint: string, body: unknown): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.CIPP_URL}/api/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${endpoint} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to CIPP and verify credentials", inputSchema: { type: "object", properties: {}, required: [] } },

  // Tenants
  { name: "list_tenants", description: "List all M365 tenants managed by CIPP", inputSchema: { type: "object", properties: {} } },

  // Users
  { name: "list_users", description: "List users in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string", description: "Tenant domain e.g. client.onmicrosoft.com" } }, required: ["tenantFilter"] } },
  { name: "get_user", description: "Get details of a specific user in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string", description: "Tenant domain" }, userId: { type: "string", description: "User ID or UPN" } }, required: ["tenantFilter", "userId"] } },
  { name: "add_user", description: "Create a new user in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, DisplayName: { type: "string" }, UserName: { type: "string", description: "Username without domain" }, Domain: { type: "string", description: "User domain e.g. client.com" }, FirstName: { type: "string" }, LastName: { type: "string" }, AutoPassword: { type: "boolean", description: "Auto-generate password (default true)" }, MustChangePass: { type: "boolean" } }, required: ["tenantFilter", "DisplayName", "UserName", "Domain"] } },
  { name: "disable_user", description: "Disable a user account in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, ID: { type: "string", description: "User ID or UPN" } }, required: ["tenantFilter", "ID"] } },
  { name: "enable_user", description: "Enable a user account in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, ID: { type: "string", description: "User ID or UPN" } }, required: ["tenantFilter", "ID"] } },
  { name: "reset_user_password", description: "Reset a user password in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, ID: { type: "string", description: "User ID or UPN" }, AutoPassword: { type: "boolean" }, NewPassword: { type: "string", description: "New password (used if AutoPassword is false)" }, MustChangePass: { type: "boolean" } }, required: ["tenantFilter", "ID"] } },
  { name: "list_user_devices", description: "List devices registered to a specific user", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, userId: { type: "string" } }, required: ["tenantFilter", "userId"] } },

  // Licenses
  { name: "list_licenses", description: "List all M365 license SKUs and usage counts for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string", description: "Tenant domain" } }, required: ["tenantFilter"] } },
  { name: "list_user_licenses", description: "List licenses assigned to users in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "set_user_license", description: "Assign or remove licenses on a user", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, UserId: { type: "string" }, AddLicenses: { type: "array", items: { type: "string" }, description: "License SKU IDs to add" }, RemoveLicenses: { type: "array", items: { type: "string" }, description: "License SKU IDs to remove" } }, required: ["tenantFilter", "UserId"] } },

  // Groups
  { name: "list_groups", description: "List all groups in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_group_members", description: "List members of a specific group", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, GroupId: { type: "string", description: "Group ID" } }, required: ["tenantFilter", "GroupId"] } },
  { name: "add_group_member", description: "Add a user to a group", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, GroupId: { type: "string" }, UserId: { type: "string" } }, required: ["tenantFilter", "GroupId", "UserId"] } },
  { name: "remove_group_member", description: "Remove a user from a group", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, GroupId: { type: "string" }, UserId: { type: "string" } }, required: ["tenantFilter", "GroupId", "UserId"] } },

  // Mailboxes
  { name: "list_mailboxes", description: "List all mailboxes in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_mailbox_permissions", description: "List mailbox permissions (full access, send-as) for a tenant or specific mailbox", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, userId: { type: "string", description: "Optional: filter to specific mailbox UPN or ID" } }, required: ["tenantFilter"] } },
  { name: "set_mailbox_ooo", description: "Set Out of Office / auto-reply for a mailbox", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, userId: { type: "string" }, AutoReplyState: { type: "string", description: "Enabled, Disabled, or Scheduled" }, InternalMessage: { type: "string" }, ExternalMessage: { type: "string" } }, required: ["tenantFilter", "userId", "AutoReplyState"] } },
  { name: "convert_mailbox", description: "Convert a mailbox between types (e.g. regular to shared)", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, userId: { type: "string" }, MailboxType: { type: "string", description: "Shared or Regular" } }, required: ["tenantFilter", "userId", "MailboxType"] } },

  // MFA / Security
  { name: "list_mfa_users", description: "List MFA status for all users in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_conditional_access", description: "List Conditional Access policies for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_defender_status", description: "Get Microsoft Defender status across devices in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_secure_score", description: "Get Microsoft Secure Score for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "revoke_user_sessions", description: "Revoke all active sessions for a user (force re-login)", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" }, ID: { type: "string", description: "User ID or UPN" } }, required: ["tenantFilter", "ID"] } },

  // Devices / Intune
  { name: "list_intune_devices", description: "List Intune-managed devices for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_autopilot_devices", description: "List Autopilot-registered devices for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_intune_policies", description: "List Intune configuration profiles/policies for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },

  // SharePoint / OneDrive
  { name: "list_sharepoint_sites", description: "List SharePoint sites in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },
  { name: "list_onedrive_usage", description: "List OneDrive usage stats per user in a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },

  // Alerts & Logs
  { name: "list_alerts", description: "List active CIPP alerts queue", inputSchema: { type: "object", properties: {} } },
  { name: "list_logs", description: "List CIPP activity/audit logs", inputSchema: { type: "object", properties: { tenantFilter: { type: "string", description: "Optional: filter by tenant" } } } },

  // Standards
  { name: "list_standards", description: "List applied CIPP standards for a tenant", inputSchema: { type: "object", properties: { tenantFilter: { type: "string" } }, required: ["tenantFilter"] } },

  // Generic passthrough — every other CIPP API endpoint (message trace, quarantine,
  // conditional access templates, GDAP, transport rules, etc.) that doesn't have a
  // named tool above. Endpoint names match CIPP's own API docs (docs.cipp.app/api-documentation)
  // and its PowerShell module cmdlet names 1:1 (e.g. ListMessageTrace, ExecGDAPTrace).
  { name: "cipp_api_get", description: "Call any CIPP read (GET) API endpoint by name, for functionality with no dedicated tool above — e.g. ListMessageTrace, ListMailQuarantine, ListConditionalAccessPolicies, ListExchangeConnectors. Look up exact endpoint names and query params at docs.cipp.app/api-documentation or CIPP's own endpoint reference.", inputSchema: { type: "object", properties: { endpoint: { type: "string", description: "CIPP API endpoint name, e.g. ListMessageTrace" }, params: { type: "object", description: "Query string parameters as key/value pairs, e.g. { tenantFilter: 'client.com' }", additionalProperties: { type: "string" } } }, required: ["endpoint"] } },
  { name: "cipp_api_post", description: "Call any CIPP write (POST) API endpoint by name, for functionality with no dedicated tool above — e.g. ExecMailTest, ExecGDAPTrace, ExecTransportRule. Look up exact endpoint names and body shape at docs.cipp.app/api-documentation or CIPP's own endpoint reference.", inputSchema: { type: "object", properties: { endpoint: { type: "string", description: "CIPP API endpoint name, e.g. ExecGDAPTrace" }, body: { type: "object", description: "JSON request body for the endpoint" } }, required: ["endpoint"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  const t = args.tenantFilter as string | undefined;
  switch (name) {
    case "healthcheck": { const data = await cippGet(env, "ListTenants"); return `Connected OK to ${env.CIPP_URL} - ${JSON.stringify(data).substring(0, 120)}`; }

    // Tenants
    case "list_tenants": return JSON.stringify(await cippGet(env, "ListTenants"), null, 2);

    // Users
    case "list_users": return JSON.stringify(await cippGet(env, "ListUsers", { tenantFilter: t! }), null, 2);
    case "get_user": return JSON.stringify(await cippGet(env, "ListUsers", { tenantFilter: t!, userId: args.userId as string }), null, 2);
    case "add_user": return JSON.stringify(await cippPost(env, "AddUser", { tenantFilter: t, DisplayName: args.DisplayName, UserName: args.UserName, Domain: args.Domain, FirstName: args.FirstName ?? "", LastName: args.LastName ?? "", AutoPassword: args.AutoPassword ?? true, MustChangePass: args.MustChangePass ?? true }), null, 2);
    case "disable_user": return JSON.stringify(await cippPost(env, "ExecDisableUser", { tenantFilter: t, ID: args.ID, Enable: false }), null, 2);
    case "enable_user": return JSON.stringify(await cippPost(env, "ExecDisableUser", { tenantFilter: t, ID: args.ID, Enable: true }), null, 2);
    case "reset_user_password": return JSON.stringify(await cippPost(env, "ExecResetPass", { tenantFilter: t, ID: args.ID, AutoPassword: args.AutoPassword ?? true, NewPassword: args.NewPassword ?? "", MustChangePass: args.MustChangePass ?? true }), null, 2);
    case "list_user_devices": return JSON.stringify(await cippGet(env, "ListUserDevices", { tenantFilter: t!, userId: args.userId as string }), null, 2);

    // Licenses
    case "list_licenses": return JSON.stringify(await cippGet(env, "ListLicenses", { tenantFilter: t! }), null, 2);
    case "list_user_licenses": return JSON.stringify(await cippGet(env, "ListUserLicenses", { tenantFilter: t! }), null, 2);
    case "set_user_license": return JSON.stringify(await cippPost(env, "ExecLicense", { tenantFilter: t, UserId: args.UserId, AddLicenses: args.AddLicenses ?? [], RemoveLicenses: args.RemoveLicenses ?? [] }), null, 2);

    // Groups
    case "list_groups": return JSON.stringify(await cippGet(env, "ListGroups", { tenantFilter: t! }), null, 2);
    case "list_group_members": return JSON.stringify(await cippGet(env, "ListGroupMembers", { tenantFilter: t!, GroupId: args.GroupId as string }), null, 2);
    case "add_group_member": return JSON.stringify(await cippPost(env, "EditGroup", { tenantFilter: t, GroupId: args.GroupId, UserId: args.UserId, Action: "AddMember" }), null, 2);
    case "remove_group_member": return JSON.stringify(await cippPost(env, "EditGroup", { tenantFilter: t, GroupId: args.GroupId, UserId: args.UserId, Action: "RemoveMember" }), null, 2);

    // Mailboxes
    case "list_mailboxes": return JSON.stringify(await cippGet(env, "ListMailboxes", { tenantFilter: t! }), null, 2);
    case "list_mailbox_permissions": { const p: Record<string, string> = { tenantFilter: t! }; if (args.userId) p.userId = args.userId as string; return JSON.stringify(await cippGet(env, "ListMailboxPermissions", p), null, 2); }
    case "set_mailbox_ooo": return JSON.stringify(await cippPost(env, "ExecSetOoO", { tenantFilter: t, userId: args.userId, AutoReplyState: args.AutoReplyState, InternalMessage: args.InternalMessage ?? "", ExternalMessage: args.ExternalMessage ?? "" }), null, 2);
    case "convert_mailbox": return JSON.stringify(await cippPost(env, "ExecConvertMailbox", { tenantFilter: t, userId: args.userId, MailboxType: args.MailboxType }), null, 2);

    // MFA / Security
    case "list_mfa_users": return JSON.stringify(await cippGet(env, "ListMFAUsers", { tenantFilter: t! }), null, 2);
    case "list_conditional_access": return JSON.stringify(await cippGet(env, "ListConditionalAccessPolicies", { tenantFilter: t! }), null, 2);
    case "list_defender_status": return JSON.stringify(await cippGet(env, "ListDefenderState", { tenantFilter: t! }), null, 2);
    case "list_secure_score": return JSON.stringify(await cippGet(env, "ListSecureScore", { tenantFilter: t! }), null, 2);
    case "revoke_user_sessions": return JSON.stringify(await cippPost(env, "ExecRevokeSessions", { tenantFilter: t, ID: args.ID }), null, 2);

    // Devices / Intune
    case "list_intune_devices": return JSON.stringify(await cippGet(env, "ListIntuneDevices", { tenantFilter: t! }), null, 2);
    case "list_autopilot_devices": return JSON.stringify(await cippGet(env, "ListAutopilotDevices", { tenantFilter: t! }), null, 2);
    case "list_intune_policies": return JSON.stringify(await cippGet(env, "ListIntuneTemplates", { tenantFilter: t! }), null, 2);

    // SharePoint / OneDrive
    case "list_sharepoint_sites": return JSON.stringify(await cippGet(env, "ListSites", { tenantFilter: t! }), null, 2);
    case "list_onedrive_usage": return JSON.stringify(await cippGet(env, "ListOneDriveUsage", { tenantFilter: t! }), null, 2);

    // Alerts & Logs
    case "list_alerts": return JSON.stringify(await cippGet(env, "ListAlertsQueue"), null, 2);
    case "list_logs": { const p: Record<string, string> = {}; if (t) p.tenantFilter = t; return JSON.stringify(await cippGet(env, "ListLogs", p), null, 2); }

    // Standards
    case "list_standards": return JSON.stringify(await cippGet(env, "ListStandardsRun", { tenantFilter: t! }), null, 2);

    // Generic passthrough
    case "cipp_api_get": return JSON.stringify(await cippGet(env, args.endpoint as string, args.params as Record<string, string> | undefined), null, 2);
    case "cipp_api_post": return JSON.stringify(await cippPost(env, args.endpoint as string, args.body ?? {}), null, 2);

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — aggregates M365 security posture
// (Secure Score + MFA coverage) across every CIPP-managed tenant,
// for the wallboard's Security zone alongside Huntress incidents.
//
// TODO: CIPP's ListSecureScore / ListMFAUsers response shapes vary by
// CIPP version — the field-name fallbacks below are best-effort. Hit
// /status once deployed, check the real shape, and tighten the field
// names if avgSecureScore/avgMfaPercent come back null unexpectedly.
// ============================================================

interface TenantSecuritySummary {
  tenant: string;
  securePercent: number | null;
  mfaPercent: number | null;
  totalUsers: number;
  error?: boolean;
}

async function buildSecurityStatus(env: Env) {
  const tenants = (await cippGet(env, "ListTenants")) as any[];

  const perTenant: TenantSecuritySummary[] = await Promise.all(
    tenants.map(async (tenant): Promise<TenantSecuritySummary> => {
      const tenantFilter = tenant.defaultDomainName || tenant.customerId || tenant.tenantId;
      const label = tenant.displayName || tenant.defaultDomainName || tenantFilter;
      try {
        const [scoreData, mfaData] = await Promise.all([
          cippGet(env, "ListSecureScore", { tenantFilter }),
          cippGet(env, "ListMFAUsers", { tenantFilter }),
        ]);

        const scoreArr = Array.isArray(scoreData) ? scoreData : [scoreData];
        const scoreRecord: any = scoreArr[0] || {};
        const currentScore = Number(scoreRecord.currentScore ?? scoreRecord.CurrentScore ?? 0);
        const maxScore = Number(scoreRecord.maxScore ?? scoreRecord.MaxScore ?? 0);
        const securePercent = maxScore > 0 ? Math.round((currentScore / maxScore) * 100) : null;

        const mfaArr: any[] = Array.isArray(mfaData) ? mfaData : [];
        const totalUsers = mfaArr.length;
        const coveredUsers = mfaArr.filter(
          (u) => u.PerUser === "Enforced" || u.PerUser === "Enabled" || u.MFARegistered === true || u.CoveredByMFA === true
        ).length;
        const mfaPercent = totalUsers > 0 ? Math.round((coveredUsers / totalUsers) * 100) : null;

        return { tenant: label, securePercent, mfaPercent, totalUsers };
      } catch {
        return { tenant: label, securePercent: null, mfaPercent: null, totalUsers: 0, error: true };
      }
    })
  );

  const withScore = perTenant.filter((p) => p.securePercent !== null);
  const avgSecureScore = withScore.length
    ? Math.round(withScore.reduce((s, p) => s + (p.securePercent as number), 0) / withScore.length)
    : null;

  const withMfa = perTenant.filter((p) => p.mfaPercent !== null);
  const avgMfaPercent = withMfa.length
    ? Math.round(withMfa.reduce((s, p) => s + (p.mfaPercent as number), 0) / withMfa.length)
    : null;

  const lowScoreTenants = perTenant
    .filter((p) => p.securePercent !== null && p.securePercent < 50)
    .map((p) => ({ tenant: p.tenant, securePercent: p.securePercent }));

  const lowMfaTenants = perTenant
    .filter((p) => p.mfaPercent !== null && p.mfaPercent < 80)
    .map((p) => ({ tenant: p.tenant, mfaPercent: p.mfaPercent }));

  return {
    updated: new Date().toISOString(),
    tenantCount: tenants.length,
    avgSecureScore,
    avgMfaPercent,
    lowScoreTenants,
    lowMfaTenants,
  };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", instance: env.CIPP_URL }), { headers: JSON_HEADERS });
    if (url.pathname === "/status") {
      try {
        const status = await buildSecurityStatus(env);
        return new Response(JSON.stringify(status), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg;
        if (id === undefined) continue;
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "CIPP MCP Server", version: "0.1.0" } } });
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
    return new Response("CIPP MCP Server - POST /mcp, GET /status, GET /health", { status: 200, headers: CORS });
  },
};
