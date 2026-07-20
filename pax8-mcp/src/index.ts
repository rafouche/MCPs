/**
 * peplink-mcp
 *
 * Same pattern as your other 6 Workers: TOOLS array, runTool switch,
 * stateless /mcp JSON-RPC handler, plus a /status route for the wallboard.
 *
 * Uses Peplink's InControl2 REST API with OAuth2 client_credentials —
 * confirmed against official Peplink docs (token endpoint, grant type,
 * and the /rest/o/... resource pattern). Org/group/device-level endpoint
 * field names beyond what's directly documented are best-effort — same
 * TODO caveat as CIPP/UniFi.
 *
 * SECRETS (wrangler secret put):
 *   PEPLINK_CLIENT_ID
 *   PEPLINK_CLIENT_SECRET
 */

export interface Env {
  PEPLINK_CLIENT_ID: string;
  PEPLINK_CLIENT_SECRET: string;
}

const IC2_BASE = "https://api.ic.peplink.com";

let cachedToken: { token: string; expires: number } | null = null;

async function getToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  const res = await fetch(`${IC2_BASE}/api/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.PEPLINK_CLIENT_ID,
      client_secret: env.PEPLINK_CLIENT_SECRET,
      grant_type: "client_credentials",
    }).toString(),
  });
  if (!res.ok) throw new Error(`InControl2 auth failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function ic2Get(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken(env);
  const url = new URL(`${IC2_BASE}${path}`);
  url.searchParams.set("access_token", token);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to Peplink InControl2 and verify OAuth credentials", inputSchema: { type: "object", properties: {}, required: [] } },

  // Organizations / Groups
  { name: "list_organizations", description: "List InControl2 organizations accessible with these credentials", inputSchema: { type: "object", properties: {} } },
  { name: "list_groups", description: "List device groups within an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID from list_organizations" } }, required: ["org_id"] } },

  // Devices
  { name: "list_devices", description: "List Peplink devices within a group", inputSchema: { type: "object", properties: { org_id: { type: "string" }, group_id: { type: "string" } }, required: ["org_id", "group_id"] } },
  { name: "get_device", description: "Get details and status of a single Peplink device", inputSchema: { type: "object", properties: { org_id: { type: "string" }, group_id: { type: "string" }, device_id: { type: "string" } }, required: ["org_id", "group_id", "device_id"] } },
  { name: "get_device_wan_status", description: "Get WAN connection status for a device (uplink health, failover state)", inputSchema: { type: "object", properties: { org_id: { type: "string" }, group_id: { type: "string" }, device_id: { type: "string" } }, required: ["org_id", "group_id", "device_id"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": { const data = await ic2Get(env, "/rest/o"); return `Connected OK to ${IC2_BASE} - ${JSON.stringify(data).substring(0, 150)}`; }

    case "list_organizations": return JSON.stringify(await ic2Get(env, "/rest/o"), null, 2);
    case "list_groups": return JSON.stringify(await ic2Get(env, `/rest/o/${args.org_id}/g`), null, 2);

    case "list_devices": return JSON.stringify(await ic2Get(env, `/rest/o/${args.org_id}/g/${args.group_id}/d`), null, 2);
    case "get_device": return JSON.stringify(await ic2Get(env, `/rest/o/${args.org_id}/g/${args.group_id}/d/${args.device_id}`), null, 2);
    case "get_device_wan_status": return JSON.stringify(await ic2Get(env, `/rest/o/${args.org_id}/g/${args.group_id}/d/${args.device_id}/status`), null, 2);

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — device online/offline per org, for the
// Network zone alongside Ninja and Meraki.
// TODO: the device-list response's online/offline field name is not
// directly confirmed from docs — verify against a real payload once
// credentials are in hand and adjust the filter below if needed.
// ============================================================

async function buildNetworkStatus(env: Env) {
  const orgs = (await ic2Get(env, "/rest/o")) as any;
  const orgList: any[] = orgs.data || orgs || [];

  const networks = [];
  for (const org of orgList) {
    try {
      const groupsResp = (await ic2Get(env, `/rest/o/${org.id}/g`)) as any;
      const groups: any[] = groupsResp.data || groupsResp || [];

      let totalDevices = 0;
      let offlineDevices: any[] = [];
      for (const group of groups) {
        const devicesResp = (await ic2Get(env, `/rest/o/${org.id}/g/${group.id}/d`)) as any;
        const devices: any[] = devicesResp.data || devicesResp || [];
        totalDevices += devices.length;
        offlineDevices = offlineDevices.concat(
          devices.filter((d) => d.online === false || d.status === "offline").map((d) => ({ name: d.name || d.sn, status: "offline" }))
        );
      }

      networks.push({
        orgName: org.name || `Org ${org.id}`,
        totalDevices,
        offlineCount: offlineDevices.length,
        offlineDevices,
      });
    } catch {
      continue;
    }
  }

  return { updated: new Date().toISOString(), networks };
}

// ============================================================
// Wallboard /licenses route — warranty/subscription/Prime expiry
// per device, for the wallboard's Business zone.
//
// Field names here are directly confirmed from Peplink's official
// IC2 API docs (expiry_date, sub_expiry_date, prime_expiry_date,
// expired) — higher confidence than most of the other TODO-marked
// guesses in this build, since these came straight from their
// published device object schema rather than inference.
// ============================================================

async function buildLicenseStatus(env: Env) {
  const orgs = (await ic2Get(env, "/rest/o")) as any;
  const orgList: any[] = orgs.data || orgs || [];
  const in60Days = Date.now() + 60 * 24 * 3600 * 1000;

  const upcomingRenewals = [];
  for (const org of orgList) {
    try {
      const groupsResp = (await ic2Get(env, `/rest/o/${org.id}/g`)) as any;
      const groups: any[] = groupsResp.data || groupsResp || [];

      for (const group of groups) {
        const devicesResp = (await ic2Get(env, `/rest/o/${org.id}/g/${group.id}/d`)) as any;
        const devices: any[] = devicesResp.data || devicesResp || [];

        for (const d of devices) {
          const checks: Array<[string, string | undefined]> = [
            ["Warranty", d.expiry_date],
            ["InControl2 Subscription", d.sub_expiry_date],
            ["Prime", d.prime_expiry_date],
          ];
          for (const [label, dateStr] of checks) {
            if (dateStr && new Date(dateStr).getTime() < in60Days) {
              upcomingRenewals.push({
                company: org.name || `Org ${org.id}`,
                product: `${d.name || d.sn || "Device"} — ${label}`,
                renewalDate: new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                source: "Peplink",
              });
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  return { updated: new Date().toISOString(), upcomingRenewals };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
    if (url.pathname === "/status") {
      try {
        const status = await buildNetworkStatus(env);
        return new Response(JSON.stringify(status), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
    }
    if (url.pathname === "/licenses") {
      try {
        const status = await buildLicenseStatus(env);
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Peplink InControl2 MCP Server", version: "1.0.0" } } });
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
    return new Response("Peplink InControl2 MCP Server - POST /mcp, GET /status, GET /licenses, GET /health", { status: 200, headers: CORS });
  },
};
