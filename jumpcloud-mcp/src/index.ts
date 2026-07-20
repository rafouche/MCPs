export interface Env {
  JUMPCLOUD_CLIENT_ID: string;
  JUMPCLOUD_CLIENT_SECRET: string;
  JUMPCLOUD_ORG_ID?: string;
}

const V1 = "https://console.jumpcloud.com/api";
const V2 = "https://console.jumpcloud.com/api/v2";
const TOKEN_URL = "https://admin-oauth.id.jumpcloud.com/oauth2/token";

// ─── OAuth2 token cache ───────────────────────────────────────────────────────

let cachedToken: { token: string; expires: number } | null = null;

async function getToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  if (!env.JUMPCLOUD_CLIENT_ID || !env.JUMPCLOUD_CLIENT_SECRET) {
    throw new Error("JUMPCLOUD_CLIENT_ID and JUMPCLOUD_CLIENT_SECRET secrets are required");
  }
  const creds = btoa(`${env.JUMPCLOUD_CLIENT_ID}:${env.JUMPCLOUD_CLIENT_SECRET}`);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "scope=api&grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`JumpCloud OAuth2 token failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in * 1000) };
  return data.access_token;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function jcHeaders(env: Env): Promise<Record<string, string>> {
  const token = await getToken(env);
  const h: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (env.JUMPCLOUD_ORG_ID) h["x-org-id"] = env.JUMPCLOUD_ORG_ID;
  return h;
}

async function jcGet(env: Env, base: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${base}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const res = await fetch(url.toString(), { headers: await jcHeaders(env) });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}
async function jcPost(env: Env, base: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: await jcHeaders(env), body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  const text = await res.text(); return text ? JSON.parse(text) : { success: true };
}
async function jcPut(env: Env, base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method: "PUT", headers: await jcHeaders(env), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PUT ${path} failed (${res.status}): ${await res.text()}`);
  const text = await res.text(); return text ? JSON.parse(text) : { success: true };
}
async function jcPatch(env: Env, base: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method: "PATCH", headers: await jcHeaders(env), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`PATCH ${path} failed (${res.status}): ${await res.text()}`);
  const text = await res.text(); return text ? JSON.parse(text) : { success: true };
}
async function jcDelete(env: Env, base: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method: "DELETE", headers: await jcHeaders(env) });
  if (!res.ok) throw new Error(`DELETE ${path} failed (${res.status}): ${await res.text()}`);
  return { success: true };
}

// ─── Status builder ───────────────────────────────────────────────────────────

async function buildStatus(env: Env): Promise<unknown> {
  const [users, systems] = await Promise.allSettled([
    jcGet(env, V1, "/systemusers", { limit: "1" }),
    jcGet(env, V1, "/systems", { limit: "1" }),
  ]);
  return {
    updated: new Date().toISOString(),
    instance: "console.jumpcloud.com",
    totalUsers: users.status === "fulfilled" ? (users.value as any)?.totalCount ?? "unknown" : "error",
    totalSystems: systems.status === "fulfilled" ? (systems.value as any)?.totalCount ?? "unknown" : "error",
  };
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to JumpCloud and verify Service Account credentials", inputSchema: { type: "object", properties: {} } },
  { name: "list_users", description: "List JumpCloud directory users with optional search filter", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" }, search: { type: "string", description: "Filter by username/email" }, sort: { type: "string" } } } },
  { name: "get_user", description: "Get full details for a JumpCloud user by ID", inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "list_user_system_bindings", description: "List systems a user is bound to", inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "create_user", description: "Create a new JumpCloud user", inputSchema: { type: "object", properties: { username: { type: "string" }, email: { type: "string" }, firstname: { type: "string" }, lastname: { type: "string" }, password: { type: "string" }, activated: { type: "boolean" }, attributes: { type: "array", items: { type: "object" } } }, required: ["username", "email"] } },
  { name: "update_user", description: "Update a JumpCloud user", inputSchema: { type: "object", properties: { userId: { type: "string" }, firstname: { type: "string" }, lastname: { type: "string" }, email: { type: "string" }, activated: { type: "boolean" }, suspended: { type: "boolean" }, attributes: { type: "array", items: { type: "object" } } }, required: ["userId"] } },
  { name: "delete_user", description: "Delete a JumpCloud user by ID", inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "unlock_user", description: "Unlock a locked-out JumpCloud user account", inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "reset_mfa", description: "Reset MFA enrollment for a JumpCloud user", inputSchema: { type: "object", properties: { userId: { type: "string" }, exclusion_until: { type: "string", description: "ISO 8601 datetime for MFA grace period" } }, required: ["userId"] } },
  { name: "suspend_user", description: "Suspend a JumpCloud user (disables login without deleting)", inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "activate_user", description: "Activate or reactivate a suspended JumpCloud user", inputSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] } },
  { name: "list_systems", description: "List JumpCloud-managed systems (devices with agent installed)", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" }, search: { type: "string" } } } },
  { name: "get_system", description: "Get full details for a JumpCloud-managed system by ID", inputSchema: { type: "object", properties: { systemId: { type: "string" } }, required: ["systemId"] } },
  { name: "get_system_user_associations", description: "Get users bound to a specific system", inputSchema: { type: "object", properties: { systemId: { type: "string" } }, required: ["systemId"] } },
  { name: "delete_system", description: "Delete a system from JumpCloud management", inputSchema: { type: "object", properties: { systemId: { type: "string" } }, required: ["systemId"] } },
  { name: "bind_user_to_system", description: "Bind a user to a system (provisions local account on device)", inputSchema: { type: "object", properties: { systemId: { type: "string" }, userId: { type: "string" }, sudo: { type: "boolean" } }, required: ["systemId", "userId"] } },
  { name: "unbind_user_from_system", description: "Unbind a user from a system", inputSchema: { type: "object", properties: { systemId: { type: "string" }, userId: { type: "string" } }, required: ["systemId", "userId"] } },
  { name: "list_user_groups", description: "List JumpCloud user groups", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "get_user_group", description: "Get a JumpCloud user group by ID", inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "list_user_group_members", description: "List members of a user group", inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "create_user_group", description: "Create a new JumpCloud user group", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name"] } },
  { name: "update_user_group", description: "Update a JumpCloud user group", inputSchema: { type: "object", properties: { groupId: { type: "string" }, name: { type: "string" }, description: { type: "string" } }, required: ["groupId"] } },
  { name: "delete_user_group", description: "Delete a JumpCloud user group", inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "add_user_to_group", description: "Add a user to a user group", inputSchema: { type: "object", properties: { groupId: { type: "string" }, userId: { type: "string" } }, required: ["groupId", "userId"] } },
  { name: "remove_user_from_group", description: "Remove a user from a user group", inputSchema: { type: "object", properties: { groupId: { type: "string" }, userId: { type: "string" } }, required: ["groupId", "userId"] } },
  { name: "list_system_groups", description: "List JumpCloud system (device) groups", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "list_system_group_members", description: "List members of a system group", inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "create_system_group", description: "Create a new JumpCloud system group", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "delete_system_group", description: "Delete a JumpCloud system group", inputSchema: { type: "object", properties: { groupId: { type: "string" } }, required: ["groupId"] } },
  { name: "add_system_to_group", description: "Add a system to a system group", inputSchema: { type: "object", properties: { groupId: { type: "string" }, systemId: { type: "string" } }, required: ["groupId", "systemId"] } },
  { name: "remove_system_from_group", description: "Remove a system from a system group", inputSchema: { type: "object", properties: { groupId: { type: "string" }, systemId: { type: "string" } }, required: ["groupId", "systemId"] } },
  { name: "list_applications", description: "List JumpCloud SSO applications", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "get_application", description: "Get full config for a SSO application", inputSchema: { type: "object", properties: { applicationId: { type: "string" } }, required: ["applicationId"] } },
  { name: "get_application_user_associations", description: "Get users assigned to a SSO application", inputSchema: { type: "object", properties: { applicationId: { type: "string" } }, required: ["applicationId"] } },
  { name: "bind_user_to_application", description: "Grant a user access to a SSO application", inputSchema: { type: "object", properties: { applicationId: { type: "string" }, userId: { type: "string" } }, required: ["applicationId", "userId"] } },
  { name: "unbind_user_from_application", description: "Remove a user's access to a SSO application", inputSchema: { type: "object", properties: { applicationId: { type: "string" }, userId: { type: "string" } }, required: ["applicationId", "userId"] } },
  { name: "search_directory_insights", description: "Search JumpCloud Directory Insights audit log — sign-ins, admin actions, directory changes", inputSchema: { type: "object", properties: { startTime: { type: "string", description: "ISO 8601 start e.g. 2026-05-01T00:00:00Z" }, endTime: { type: "string" }, service: { type: "array", items: { type: "string" }, description: "sso, directory, systems, ldap, radius, mdm, commands" }, limit: { type: "number" } }, required: ["startTime", "endTime"] } },
  { name: "list_policies", description: "List JumpCloud MDM/configuration policies", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "get_policy", description: "Get a JumpCloud policy by ID", inputSchema: { type: "object", properties: { policyId: { type: "string" } }, required: ["policyId"] } },
  { name: "list_commands", description: "List JumpCloud commands (scripts for managed systems)", inputSchema: { type: "object", properties: { limit: { type: "number" }, skip: { type: "number" } } } },
  { name: "run_command", description: "Trigger a JumpCloud command to run on its associated systems", inputSchema: { type: "object", properties: { commandId: { type: "string" } }, required: ["commandId"] } },
  { name: "jc_raw_request", description: "Make an arbitrary authenticated request to the JumpCloud API", inputSchema: { type: "object", properties: { apiVersion: { type: "string", enum: ["v1", "v2"] }, method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, path: { type: "string" }, query: { type: "object" }, body: {} }, required: ["apiVersion", "path"] } },
];

// ─── Tool runner ──────────────────────────────────────────────────────────────

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": { const d = await jcGet(env, V1, "/systemusers", { limit: "1" }); return `Connected OK to console.jumpcloud.com via Service Account. ${JSON.stringify(d).substring(0, 100)}`; }
    case "list_users": { const p: Record<string,string> = { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }; if (args.search) p["filter"] = `email:$search:${args.search}`; if (args.sort) p["sort"] = args.sort as string; return JSON.stringify(await jcGet(env, V1, "/systemusers", p), null, 2); }
    case "get_user": return JSON.stringify(await jcGet(env, V1, `/systemusers/${args.userId}`), null, 2);
    case "list_user_system_bindings": return JSON.stringify(await jcGet(env, V2, `/users/${args.userId}/associations`, { targets: "system" }), null, 2);
    case "create_user": { const b: Record<string,unknown> = { username: args.username, email: args.email }; if (args.firstname) b.firstname = args.firstname; if (args.lastname) b.lastname = args.lastname; if (args.password) b.password = args.password; if (args.activated !== undefined) b.activated = args.activated; if (args.attributes) b.attributes = args.attributes; return JSON.stringify(await jcPost(env, V1, "/systemusers", b), null, 2); }
    case "update_user": { const b: Record<string,unknown> = {}; ["firstname","lastname","email","activated","suspended","attributes"].forEach(k => { if (args[k] !== undefined) b[k] = args[k]; }); return JSON.stringify(await jcPut(env, V1, `/systemusers/${args.userId}`, b), null, 2); }
    case "delete_user": return JSON.stringify(await jcDelete(env, V1, `/systemusers/${args.userId}`), null, 2);
    case "unlock_user": return JSON.stringify(await jcPost(env, V1, `/systemusers/${args.userId}/unlock`), null, 2);
    case "reset_mfa": { const b: Record<string,unknown> = {}; if (args.exclusion_until) b.exclusion_until = args.exclusion_until; return JSON.stringify(await jcPost(env, V1, `/systemusers/${args.userId}/resetmfa`, b), null, 2); }
    case "suspend_user": return JSON.stringify(await jcPut(env, V1, `/systemusers/${args.userId}`, { suspended: true }), null, 2);
    case "activate_user": return JSON.stringify(await jcPut(env, V1, `/systemusers/${args.userId}`, { activated: true, suspended: false }), null, 2);
    case "list_systems": { const p: Record<string,string> = { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }; if (args.search) p["search[searchTerm]"] = args.search as string; return JSON.stringify(await jcGet(env, V1, "/systems", p), null, 2); }
    case "get_system": return JSON.stringify(await jcGet(env, V1, `/systems/${args.systemId}`), null, 2);
    case "get_system_user_associations": return JSON.stringify(await jcGet(env, V2, `/systems/${args.systemId}/associations`, { targets: "user" }), null, 2);
    case "delete_system": return JSON.stringify(await jcDelete(env, V1, `/systems/${args.systemId}`), null, 2);
    case "bind_user_to_system": return JSON.stringify(await jcPost(env, V2, `/systems/${args.systemId}/associations`, { op: "add", type: "user", id: args.userId, attributes: { sudo: { enabled: args.sudo ?? false, withoutPassword: false } } }), null, 2);
    case "unbind_user_from_system": return JSON.stringify(await jcPost(env, V2, `/systems/${args.systemId}/associations`, { op: "remove", type: "user", id: args.userId }), null, 2);
    case "list_user_groups": return JSON.stringify(await jcGet(env, V2, "/usergroups", { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }), null, 2);
    case "get_user_group": return JSON.stringify(await jcGet(env, V2, `/usergroups/${args.groupId}`), null, 2);
    case "list_user_group_members": return JSON.stringify(await jcGet(env, V2, `/usergroups/${args.groupId}/members`), null, 2);
    case "create_user_group": return JSON.stringify(await jcPost(env, V2, "/usergroups", { name: args.name, description: args.description ?? "" }), null, 2);
    case "update_user_group": { const b: Record<string,unknown> = {}; if (args.name) b.name = args.name; if (args.description !== undefined) b.description = args.description; return JSON.stringify(await jcPatch(env, V2, `/usergroups/${args.groupId}`, b), null, 2); }
    case "delete_user_group": return JSON.stringify(await jcDelete(env, V2, `/usergroups/${args.groupId}`), null, 2);
    case "add_user_to_group": return JSON.stringify(await jcPost(env, V2, `/usergroups/${args.groupId}/members`, { op: "add", type: "user", id: args.userId }), null, 2);
    case "remove_user_from_group": return JSON.stringify(await jcPost(env, V2, `/usergroups/${args.groupId}/members`, { op: "remove", type: "user", id: args.userId }), null, 2);
    case "list_system_groups": return JSON.stringify(await jcGet(env, V2, "/systemgroups", { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }), null, 2);
    case "list_system_group_members": return JSON.stringify(await jcGet(env, V2, `/systemgroups/${args.groupId}/members`), null, 2);
    case "create_system_group": return JSON.stringify(await jcPost(env, V2, "/systemgroups", { name: args.name }), null, 2);
    case "delete_system_group": return JSON.stringify(await jcDelete(env, V2, `/systemgroups/${args.groupId}`), null, 2);
    case "add_system_to_group": return JSON.stringify(await jcPost(env, V2, `/systemgroups/${args.groupId}/members`, { op: "add", type: "system", id: args.systemId }), null, 2);
    case "remove_system_from_group": return JSON.stringify(await jcPost(env, V2, `/systemgroups/${args.groupId}/members`, { op: "remove", type: "system", id: args.systemId }), null, 2);
    case "list_applications": return JSON.stringify(await jcGet(env, V2, "/applications", { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }), null, 2);
    case "get_application": return JSON.stringify(await jcGet(env, V2, `/applications/${args.applicationId}`), null, 2);
    case "get_application_user_associations": return JSON.stringify(await jcGet(env, V2, `/applications/${args.applicationId}/associations`, { targets: "user" }), null, 2);
    case "bind_user_to_application": return JSON.stringify(await jcPost(env, V2, `/applications/${args.applicationId}/associations`, { op: "add", type: "user", id: args.userId }), null, 2);
    case "unbind_user_from_application": return JSON.stringify(await jcPost(env, V2, `/applications/${args.applicationId}/associations`, { op: "remove", type: "user", id: args.userId }), null, 2);
    case "search_directory_insights": { const b: Record<string,unknown> = { start_time: args.startTime, end_time: args.endTime, limit: args.limit ?? 100 }; if (args.service) b.service = args.service; return JSON.stringify(await jcPost(env, V1, "/insights/directory/events", b), null, 2); }
    case "list_policies": return JSON.stringify(await jcGet(env, V2, "/policies", { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }), null, 2);
    case "get_policy": return JSON.stringify(await jcGet(env, V2, `/policies/${args.policyId}`), null, 2);
    case "list_commands": return JSON.stringify(await jcGet(env, V1, "/commands", { limit: String(args.limit ?? 100), skip: String(args.skip ?? 0) }), null, 2);
    case "run_command": return JSON.stringify(await jcPost(env, V1, `/commands/${args.commandId}/trigger`), null, 2);
    case "jc_raw_request": {
      const base = args.apiVersion === "v1" ? V1 : V2;
      const p = args.query ? Object.fromEntries(Object.entries(args.query as Record<string,unknown>).map(([k,v]) => [k, String(v)])) : undefined;
      const m = (args.method as string | undefined) ?? "GET";
      if (m === "GET") return JSON.stringify(await jcGet(env, base, args.path as string, p), null, 2);
      if (m === "DELETE") return JSON.stringify(await jcDelete(env, base, args.path as string), null, 2);
      if (m === "POST") return JSON.stringify(await jcPost(env, base, args.path as string, args.body), null, 2);
      if (m === "PUT") return JSON.stringify(await jcPut(env, base, args.path as string, args.body ?? {}), null, 2);
      if (m === "PATCH") return JSON.stringify(await jcPatch(env, base, args.path as string, args.body ?? {}), null, 2);
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "JumpCloud MCP Server", version: "2.0.0" } } });
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
    return new Response("JumpCloud MCP Server — POST /mcp | GET /status | GET /health", { status: 200, headers: CORS });
  },
};
