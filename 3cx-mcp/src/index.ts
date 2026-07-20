export interface Env {
  TCX_SERVERS: string;
}

interface ServerConfig {
  url: string;
  clientId: string;
  clientSecret: string;
}

const tokenCache = new Map<string, { token: string; expires: number }>();

function getServers(env: Env): Record<string, ServerConfig> {
  try {
    return JSON.parse(env.TCX_SERVERS);
  } catch {
    throw new Error("TCX_SERVERS secret is not valid JSON. Check the format.");
  }
}

function resolveServer(env: Env, serverName?: string): { config: ServerConfig; name: string } {
  const servers = getServers(env);
  const keys = Object.keys(servers);
  if (!keys.length) throw new Error("No servers configured in TCX_SERVERS.");
  const name = serverName ?? keys[0];
  const config = servers[name.toLowerCase()];
  if (!config) throw new Error(`Server "${name}" not found. Available: ${keys.join(", ")}`);
  return { config, name };
}

async function getToken(config: ServerConfig): Promise<string> {
  const cacheKey = config.url;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires > Date.now() + 60000) return cached.token;

  const res = await fetch(`${config.url}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "client_credentials",
    }).toString(),
  });
  if (!res.ok) throw new Error(`3CX auth failed for ${config.url} (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, { token: data.access_token, expires: Date.now() + (data.expires_in * 1000) });
  return data.access_token;
}

async function tcxGet(config: ServerConfig, path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken(config);
  const url = new URL(`${config.url}/xapi/v1${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function tcxPost(config: ServerConfig, path: string, body: unknown): Promise<unknown> {
  const token = await getToken(config);
  const res = await fetch(`${config.url}/xapi/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function tcxPatch(config: ServerConfig, path: string, body: unknown): Promise<unknown> {
  const token = await getToken(config);
  const res = await fetch(`${config.url}/xapi/v1${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

const SERVER_PARAM = { server: { type: "string", description: "Client name key e.g. altec, goldmechanical (omit to use first configured server)" } };

const TOOLS = [
  { name: "list_servers", description: "List all configured 3CX servers available in this MCP", inputSchema: { type: "object", properties: {} } },
  { name: "healthcheck", description: "Test connectivity to a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "list_extensions", description: "List all extensions/users on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM, top: { type: "number", description: "Max results (default 100)" }, filter: { type: "string", description: "OData filter e.g. Enabled eq true" } } } },
  { name: "get_extension", description: "Get full details of a single extension by DN", inputSchema: { type: "object", properties: { ...SERVER_PARAM, dn: { type: "string", description: "Extension number e.g. 100" } }, required: ["dn"] } },
  { name: "create_extension", description: "Create a new extension/user", inputSchema: { type: "object", properties: { ...SERVER_PARAM, Number: { type: "string" }, FirstName: { type: "string" }, LastName: { type: "string" }, EmailAddress: { type: "string" }, Department: { type: "string" }, Mobile: { type: "string" } }, required: ["Number", "FirstName", "LastName", "EmailAddress"] } },
  { name: "update_extension", description: "Update an extension (name, email, mobile, department, enable/disable)", inputSchema: { type: "object", properties: { ...SERVER_PARAM, dn: { type: "string" }, FirstName: { type: "string" }, LastName: { type: "string" }, EmailAddress: { type: "string" }, Mobile: { type: "string" }, Enabled: { type: "boolean" }, Department: { type: "string" } }, required: ["dn"] } },
  { name: "list_active_calls", description: "List all currently active calls on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "get_call_log", description: "Get call history log for a date range", inputSchema: { type: "object", properties: { ...SERVER_PARAM, from: { type: "string", description: "Start ISO datetime e.g. 2026-05-01T00:00:00Z" }, to: { type: "string", description: "End ISO datetime" }, top: { type: "number", description: "Max records (default 100)" }, filter: { type: "string", description: "OData filter e.g. CallType eq 'Inbound'" } }, required: ["from", "to"] } },
  { name: "list_queues", description: "List all call queues on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "get_queue", description: "Get details and agents for a specific queue", inputSchema: { type: "object", properties: { ...SERVER_PARAM, dn: { type: "string", description: "Queue extension number" } }, required: ["dn"] } },
  { name: "get_queue_stats", description: "Get performance statistics for a queue over a date range", inputSchema: { type: "object", properties: { ...SERVER_PARAM, queueDn: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["queueDn", "from", "to"] } },
  { name: "get_abandoned_calls", description: "Get abandoned/missed calls report for a queue", inputSchema: { type: "object", properties: { ...SERVER_PARAM, queueDn: { type: "string" }, from: { type: "string" }, to: { type: "string" }, top: { type: "number" } }, required: ["queueDn", "from", "to"] } },
  { name: "list_ring_groups", description: "List all ring groups on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "list_ivr", description: "List all IVR/digital receptionists on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "list_departments", description: "List all departments/groups on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "list_trunks", description: "List all SIP trunks on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "get_system_info", description: "Get 3CX system version, license, and status", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "list_phones", description: "List all registered IP phones/devices", inputSchema: { type: "object", properties: { ...SERVER_PARAM, top: { type: "number" } } } },
  { name: "list_voicemails", description: "List voicemail messages for an extension", inputSchema: { type: "object", properties: { ...SERVER_PARAM, dn: { type: "string", description: "Extension number" } }, required: ["dn"] } },
  { name: "list_blacklist", description: "List all blacklisted numbers on a 3CX server", inputSchema: { type: "object", properties: { ...SERVER_PARAM } } },
  { name: "add_to_blacklist", description: "Add a phone number to the blacklist", inputSchema: { type: "object", properties: { ...SERVER_PARAM, number: { type: "string" }, description: { type: "string" } }, required: ["number"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  if (name === "list_servers") {
    const servers = getServers(env);
    return JSON.stringify(Object.entries(servers).map(([key, cfg]) => ({ name: key, url: cfg.url })), null, 2);
  }

  const { config, name: serverName } = resolveServer(env, args.server as string | undefined);

  switch (name) {
    case "healthcheck": {
      const data = await tcxGet(config, "/Defs?$select=Id");
      return `Connected OK to ${serverName} (${config.url}). Response: ${JSON.stringify(data).substring(0, 100)}`;
    }
    case "list_extensions": {
      const p: Record<string, string> = { "$top": String(args.top ?? 100) };
      if (args.filter) p["$filter"] = args.filter as string;
      return JSON.stringify(await tcxGet(config, "/Extensions", p), null, 2);
    }
    case "get_extension": return JSON.stringify(await tcxGet(config, `/Extensions('${args.dn}')`), null, 2);
    case "create_extension": return JSON.stringify(await tcxPost(config, "/Extensions", { Number: args.Number, FirstName: args.FirstName, LastName: args.LastName, EmailAddress: args.EmailAddress, Department: args.Department ?? "", Mobile: args.Mobile ?? "" }), null, 2);
    case "update_extension": {
      const body: Record<string, unknown> = {};
      if (args.FirstName !== undefined) body.FirstName = args.FirstName;
      if (args.LastName !== undefined) body.LastName = args.LastName;
      if (args.EmailAddress !== undefined) body.EmailAddress = args.EmailAddress;
      if (args.Mobile !== undefined) body.Mobile = args.Mobile;
      if (args.Enabled !== undefined) body.Enabled = args.Enabled;
      if (args.Department !== undefined) body.Department = args.Department;
      return JSON.stringify(await tcxPatch(config, `/Extensions('${args.dn}')`, body), null, 2);
    }
    case "list_active_calls": return JSON.stringify(await tcxGet(config, "/ActiveCalls"), null, 2);
    case "get_call_log": {
      const p: Record<string, string> = { "$top": String(args.top ?? 100), "from": args.from as string, "to": args.to as string };
      if (args.filter) p["$filter"] = args.filter as string;
      return JSON.stringify(await tcxGet(config, "/ReportCallLogData", p), null, 2);
    }
    case "list_queues": return JSON.stringify(await tcxGet(config, "/Queues"), null, 2);
    case "get_queue": return JSON.stringify(await tcxGet(config, `/Queues('${args.dn}')`), null, 2);
    case "get_queue_stats": return JSON.stringify(await tcxGet(config, "/ReportQueuePerformanceOverview", { from: args.from as string, to: args.to as string, queuedns: args.queueDn as string }), null, 2);
    case "get_abandoned_calls": return JSON.stringify(await tcxGet(config, "/ReportAbandonedQueueCalls", { from: args.from as string, to: args.to as string, queuedns: args.queueDn as string, "$top": String(args.top ?? 100) }), null, 2);
    case "list_ring_groups": return JSON.stringify(await tcxGet(config, "/RingGroups"), null, 2);
    case "list_ivr": return JSON.stringify(await tcxGet(config, "/Ivrs"), null, 2);
    case "list_departments": return JSON.stringify(await tcxGet(config, "/Groups"), null, 2);
    case "list_trunks": return JSON.stringify(await tcxGet(config, "/Trunks"), null, 2);
    case "get_system_info": return JSON.stringify(await tcxGet(config, "/SystemStatus"), null, 2);
    case "list_phones": return JSON.stringify(await tcxGet(config, "/Phones", { "$top": String(args.top ?? 100) }), null, 2);
    case "list_voicemails": return JSON.stringify(await tcxGet(config, `/VoicemailMessages?$filter=OwnerId eq '${args.dn}'`), null, 2);
    case "list_blacklist": return JSON.stringify(await tcxGet(config, "/Blacklist"), null, 2);
    case "add_to_blacklist": return JSON.stringify(await tcxPost(config, "/Blacklist", { Number: args.number, Description: args.description ?? "" }), null, 2);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", servers: Object.keys(JSON.parse(env.TCX_SERVERS)) }), { headers: JSON_HEADERS });
    if (url.pathname === "/mcp" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg;
        if (id === undefined) continue;
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "3CX MCP Server", version: "2.0.0" } } });
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
    return new Response("3CX MCP Server v2 - POST /mcp", { status: 200, headers: CORS });
  },
};
