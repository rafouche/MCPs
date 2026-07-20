export interface Env {
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_ADMIN_EMAIL: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id: string;
}

async function getGoogleToken(env: Env, subject: string, scopes: string[]): Promise<string> {
  const sa: ServiceAccountKey = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    sub: subject,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  // Build JWT manually using Web Crypto API (available in Workers)
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const payload = btoa(JSON.stringify(claim)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signingInput = `${header}.${payload}`;

  // Import the RSA private key
  const pemKey = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\n/g, "");
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", keyData.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, encoder.encode(signingInput));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = `${signingInput}.${sigB64}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!tokenRes.ok) throw new Error(`Google token failed (${tokenRes.status}): ${await tokenRes.text()}`);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.group",
  "https://www.googleapis.com/auth/admin.directory.group.member",
  "https://www.googleapis.com/auth/admin.directory.device.chromeos",
  "https://www.googleapis.com/auth/admin.directory.device.mobile",
  "https://www.googleapis.com/auth/admin.directory.orgunit",
];

const REPORTS_SCOPES = [
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
  "https://www.googleapis.com/auth/admin.reports.usage.readonly",
];

async function gGet(env: Env, baseUrl: string, path: string, params?: Record<string, string>, scopes?: string[]): Promise<unknown> {
  const adminEmail = env.GOOGLE_ADMIN_EMAIL;
  const token = await getGoogleToken(env, adminEmail, scopes ?? DIRECTORY_SCOPES);
  const url = new URL(`${baseUrl}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function gPost(env: Env, baseUrl: string, path: string, body: unknown, scopes?: string[]): Promise<unknown> {
  const token = await getGoogleToken(env, env.GOOGLE_ADMIN_EMAIL, scopes ?? DIRECTORY_SCOPES);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function gPut(env: Env, baseUrl: string, path: string, body: unknown, scopes?: string[]): Promise<unknown> {
  const token = await getGoogleToken(env, env.GOOGLE_ADMIN_EMAIL, scopes ?? DIRECTORY_SCOPES);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const DIR = "https://admin.googleapis.com/admin/directory/v1";
const RPT = "https://admin.googleapis.com/admin/reports/v1";

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to Google Workspace Admin SDK and verify service account credentials", inputSchema: { type: "object", properties: { domain: { type: "string", description: "Domain to test e.g. altecusa.com (defaults to admin account domain)" } } } },

  // Users
  { name: "list_users", description: "List users in a Google Workspace domain", inputSchema: { type: "object", properties: { domain: { type: "string", description: "Domain e.g. clientdomain.com" }, maxResults: { type: "number", description: "Max results (default 100)" }, query: { type: "string", description: "Search query e.g. name:John givenName:Smith" }, orderBy: { type: "string", description: "Order by: email, familyName, givenName" } }, required: ["domain"] } },
  { name: "get_user", description: "Get full details of a single Google Workspace user", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "User email address or unique ID" } }, required: ["userKey"] } },
  { name: "create_user", description: "Create a new user in a Google Workspace domain", inputSchema: { type: "object", properties: { primaryEmail: { type: "string", description: "Full email e.g. jsmith@clientdomain.com" }, givenName: { type: "string" }, familyName: { type: "string" }, password: { type: "string", description: "Initial password" }, changePasswordAtNextLogin: { type: "boolean", description: "Force password change on first login (default true)" }, orgUnitPath: { type: "string", description: "OU path e.g. /Sales" } }, required: ["primaryEmail", "givenName", "familyName", "password"] } },
  { name: "update_user", description: "Update a Google Workspace user (name, OU, suspension, password)", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "User email or ID" }, suspended: { type: "boolean", description: "Suspend or unsuspend the user" }, orgUnitPath: { type: "string" }, givenName: { type: "string" }, familyName: { type: "string" }, password: { type: "string" }, changePasswordAtNextLogin: { type: "boolean" } }, required: ["userKey"] } },
  { name: "delete_user", description: "Delete a Google Workspace user (moves to trash for 5 days)", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "User email or ID" } }, required: ["userKey"] } },
  { name: "list_user_aliases", description: "List email aliases for a user", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "User email or ID" } }, required: ["userKey"] } },

  // Groups
  { name: "list_groups", description: "List groups in a Google Workspace domain", inputSchema: { type: "object", properties: { domain: { type: "string", description: "Domain e.g. clientdomain.com" }, maxResults: { type: "number", description: "Max results (default 100)" }, query: { type: "string", description: "Search query" } }, required: ["domain"] } },
  { name: "get_group", description: "Get details of a single Google Workspace group", inputSchema: { type: "object", properties: { groupKey: { type: "string", description: "Group email or ID" } }, required: ["groupKey"] } },
  { name: "create_group", description: "Create a new Google Workspace group", inputSchema: { type: "object", properties: { email: { type: "string", description: "Group email address" }, name: { type: "string", description: "Group display name" }, description: { type: "string" } }, required: ["email", "name"] } },
  { name: "list_group_members", description: "List members of a Google Workspace group", inputSchema: { type: "object", properties: { groupKey: { type: "string", description: "Group email or ID" }, maxResults: { type: "number", description: "Max results (default 200)" } }, required: ["groupKey"] } },
  { name: "add_group_member", description: "Add a user to a Google Workspace group", inputSchema: { type: "object", properties: { groupKey: { type: "string", description: "Group email or ID" }, email: { type: "string", description: "User email to add" }, role: { type: "string", description: "MEMBER, MANAGER, or OWNER (default MEMBER)" } }, required: ["groupKey", "email"] } },

  // Org Units
  { name: "list_org_units", description: "List organizational units in a Google Workspace domain", inputSchema: { type: "object", properties: { customerId: { type: "string", description: "Customer ID or 'my_customer' for the admin's domain" }, orgUnitPath: { type: "string", description: "Parent OU path (default: / for all)" } }, required: ["customerId"] } },

  // Devices
  { name: "list_chromeos_devices", description: "List ChromeOS devices enrolled in a domain", inputSchema: { type: "object", properties: { customerId: { type: "string", description: "Customer ID or 'my_customer'" }, maxResults: { type: "number", description: "Max results (default 100)" }, query: { type: "string", description: "Search e.g. status:active" }, orderBy: { type: "string", description: "annotatedUser, serialNumber, status" } }, required: ["customerId"] } },
  { name: "list_mobile_devices", description: "List mobile devices managed in a domain", inputSchema: { type: "object", properties: { customerId: { type: "string", description: "Customer ID or 'my_customer'" }, maxResults: { type: "number", description: "Max results (default 100)" }, query: { type: "string", description: "Search by email, serial, model" } }, required: ["customerId"] } },

  // Reports / Audit Logs
  { name: "get_login_activity", description: "Get login activity audit log for a domain", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "Filter by user email or 'all'" }, maxResults: { type: "number", description: "Max results (default 50)" }, startTime: { type: "string", description: "Start time RFC3339 e.g. 2026-05-01T00:00:00Z" }, endTime: { type: "string", description: "End time RFC3339" } }, required: ["userKey"] } },
  { name: "get_admin_activity", description: "Get admin activity audit log — who changed what in Admin Console", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "Filter by admin email or 'all'" }, maxResults: { type: "number", description: "Max results (default 50)" }, startTime: { type: "string", description: "Start time RFC3339" } }, required: ["userKey"] } },
  { name: "get_drive_activity", description: "Get Google Drive audit log for a user or domain", inputSchema: { type: "object", properties: { userKey: { type: "string", description: "User email or 'all'" }, maxResults: { type: "number", description: "Max results (default 50)" }, startTime: { type: "string", description: "Start time RFC3339" } }, required: ["userKey"] } },
  { name: "get_user_usage_report", description: "Get usage statistics for users in a domain (storage, last login, app usage)", inputSchema: { type: "object", properties: { date: { type: "string", description: "Report date YYYY-MM-DD (must be at least 3 days ago)" }, userKey: { type: "string", description: "User email or 'all'" }, filters: { type: "string", description: "Filter e.g. accounts:is_disabled==true" } }, required: ["date"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {

    case "healthcheck": {
      const domain = (args.domain as string) ?? env.GOOGLE_ADMIN_EMAIL.split("@")[1];
      const data = await gGet(env, DIR, `/users`, { domain, maxResults: "1" });
      return `Connected OK to Google Workspace Admin SDK. Domain: ${domain}. Response: ${JSON.stringify(data).substring(0, 150)}`;
    }

    // Users
    case "list_users": {
      const p: Record<string, string> = { domain: args.domain as string, maxResults: String(args.maxResults ?? 100) };
      if (args.query) p.query = args.query as string;
      if (args.orderBy) p.orderBy = args.orderBy as string;
      return JSON.stringify(await gGet(env, DIR, "/users", p), null, 2);
    }
    case "get_user": return JSON.stringify(await gGet(env, DIR, `/users/${encodeURIComponent(args.userKey as string)}`), null, 2);
    case "create_user": return JSON.stringify(await gPost(env, DIR, "/users", {
      primaryEmail: args.primaryEmail,
      name: { givenName: args.givenName, familyName: args.familyName },
      password: args.password,
      changePasswordAtNextLogin: args.changePasswordAtNextLogin ?? true,
      orgUnitPath: args.orgUnitPath ?? "/",
    }), null, 2);
    case "update_user": {
      const body: Record<string, unknown> = {};
      if (args.suspended !== undefined) body.suspended = args.suspended;
      if (args.orgUnitPath) body.orgUnitPath = args.orgUnitPath;
      if (args.givenName || args.familyName) body.name = { givenName: args.givenName, familyName: args.familyName };
      if (args.password) body.password = args.password;
      if (args.changePasswordAtNextLogin !== undefined) body.changePasswordAtNextLogin = args.changePasswordAtNextLogin;
      return JSON.stringify(await gPut(env, DIR, `/users/${encodeURIComponent(args.userKey as string)}`, body), null, 2);
    }
    case "delete_user": {
      const token = await getGoogleToken(env, env.GOOGLE_ADMIN_EMAIL, DIRECTORY_SCOPES);
      const res = await fetch(`${DIR}/users/${encodeURIComponent(args.userKey as string)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` }
      });
      return res.ok ? `User ${args.userKey} deleted successfully` : `Delete failed (${res.status}): ${await res.text()}`;
    }
    case "list_user_aliases": return JSON.stringify(await gGet(env, DIR, `/users/${encodeURIComponent(args.userKey as string)}/aliases`), null, 2);

    // Groups
    case "list_groups": {
      const p: Record<string, string> = { domain: args.domain as string, maxResults: String(args.maxResults ?? 100) };
      if (args.query) p.query = args.query as string;
      return JSON.stringify(await gGet(env, DIR, "/groups", p), null, 2);
    }
    case "get_group": return JSON.stringify(await gGet(env, DIR, `/groups/${encodeURIComponent(args.groupKey as string)}`), null, 2);
    case "create_group": return JSON.stringify(await gPost(env, DIR, "/groups", { email: args.email, name: args.name, description: args.description ?? "" }), null, 2);
    case "list_group_members": {
      const p: Record<string, string> = { maxResults: String(args.maxResults ?? 200) };
      return JSON.stringify(await gGet(env, DIR, `/groups/${encodeURIComponent(args.groupKey as string)}/members`, p), null, 2);
    }
    case "add_group_member": return JSON.stringify(await gPost(env, DIR, `/groups/${encodeURIComponent(args.groupKey as string)}/members`, { email: args.email, role: args.role ?? "MEMBER" }), null, 2);

    // Org Units
    case "list_org_units": {
      const p: Record<string, string> = { orgUnitPath: (args.orgUnitPath as string) ?? "/" };
      return JSON.stringify(await gGet(env, DIR, `/customer/${args.customerId}/orgunits`, p), null, 2);
    }

    // Devices
    case "list_chromeos_devices": {
      const p: Record<string, string> = { maxResults: String(args.maxResults ?? 100) };
      if (args.query) p.query = args.query as string;
      if (args.orderBy) p.orderBy = args.orderBy as string;
      return JSON.stringify(await gGet(env, DIR, `/customer/${args.customerId}/devices/chromeos`, p), null, 2);
    }
    case "list_mobile_devices": {
      const p: Record<string, string> = { maxResults: String(args.maxResults ?? 100) };
      if (args.query) p.query = args.query as string;
      return JSON.stringify(await gGet(env, DIR, `/customer/${args.customerId}/devices/mobile`, p), null, 2);
    }

    // Reports
    case "get_login_activity": {
      const p: Record<string, string> = { maxResults: String(args.maxResults ?? 50) };
      if (args.startTime) p.startTime = args.startTime as string;
      if (args.endTime) p.endTime = args.endTime as string;
      return JSON.stringify(await gGet(env, RPT, `/activity/users/${encodeURIComponent(args.userKey as string)}/applications/login`, p, REPORTS_SCOPES), null, 2);
    }
    case "get_admin_activity": {
      const p: Record<string, string> = { maxResults: String(args.maxResults ?? 50) };
      if (args.startTime) p.startTime = args.startTime as string;
      return JSON.stringify(await gGet(env, RPT, `/activity/users/${encodeURIComponent(args.userKey as string)}/applications/admin`, p, REPORTS_SCOPES), null, 2);
    }
    case "get_drive_activity": {
      const p: Record<string, string> = { maxResults: String(args.maxResults ?? 50) };
      if (args.startTime) p.startTime = args.startTime as string;
      return JSON.stringify(await gGet(env, RPT, `/activity/users/${encodeURIComponent(args.userKey as string)}/applications/drive`, p, REPORTS_SCOPES), null, 2);
    }
    case "get_user_usage_report": {
      const p: Record<string, string> = {};
      if (args.filters) p.filters = args.filters as string;
      return JSON.stringify(await gGet(env, RPT, `/usage/users/${encodeURIComponent((args.userKey as string) ?? "all")}/${args.date}`, p, REPORTS_SCOPES), null, 2);
    }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", admin: env.GOOGLE_ADMIN_EMAIL }), { headers: JSON_HEADERS });
    if (url.pathname === "/mcp" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg;
        if (id === undefined) continue;
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Google Workspace MCP Server", version: "1.0.0" } } });
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
    return new Response("Google Workspace MCP Server - POST /mcp", { status: 200, headers: CORS });
  },
};
