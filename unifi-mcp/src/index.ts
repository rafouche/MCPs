/**
 * unifi-mcp
 *
 * Same pattern as your other 6 Workers: TOOLS array, runTool switch,
 * stateless /mcp JSON-RPC handler, plus a /status route for the wallboard.
 *
 * Uses UniFi's Site Manager API (cloud, api.ui.com) rather than connecting
 * directly to each client's local controller — right fit for an MSP with
 * many sites, since it doesn't need VPN/direct network access per client.
 *
 * FIXED: buildNetworkStatus previously called /v1/hosts to get host names,
 * then looped /v1/devices per host with a hostIds filter — but /v1/hosts
 * doesn't have a top-level "name" field (it's buried at reportedState.name),
 * so every host's orgName fell through to the "Host {id}" fallback, and
 * something in that chain was failing silently, producing zero usable tiles.
 *
 * Confirmed against a live response: /v1/devices with NO filter already
 * returns everything grouped by host in one call, with a clean top-level
 * hostName and a devices[] array where each device has a plain
 * status: "online"/"offline" field — much simpler than the original
 * per-host-loop design, and no /v1/hosts call needed at all for this route.
 *
 * SECRETS (wrangler secret put):
 *   UNIFI_API_KEY   — from unifi.ui.com -> Settings -> API
 */

export interface Env {
  UNIFI_API_KEY: string;
}

const UNIFI_BASE = "https://api.ui.com";

async function unifiGet(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${UNIFI_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { "X-API-KEY": env.UNIFI_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to the UniFi Site Manager API and verify the API key", inputSchema: { type: "object", properties: {}, required: [] } },

  // Hosts / Sites
  { name: "list_hosts", description: "List all UniFi hosts (consoles/sites) accessible with this API key", inputSchema: { type: "object", properties: {} } },
  { name: "get_host", description: "Get details of a single UniFi host by ID", inputSchema: { type: "object", properties: { host_id: { type: "string", description: "Host/console ID from list_hosts" } }, required: ["host_id"] } },
  { name: "list_sites", description: "List sites across all hosts", inputSchema: { type: "object", properties: {} } },

  // Devices
  { name: "list_devices", description: "List UniFi devices (APs, switches, gateways) across hosts, optionally filtered to one host", inputSchema: { type: "object", properties: { host_id: { type: "string", description: "Optional: filter to one host" } } } },
  { name: "get_device", description: "Get details of a single UniFi device", inputSchema: { type: "object", properties: { host_id: { type: "string" }, device_id: { type: "string" } }, required: ["host_id", "device_id"] } },

  // ISP / connectivity metrics
  { name: "get_isp_metrics", description: "Get ISP uptime/latency metrics for a host's WAN connection(s)", inputSchema: { type: "object", properties: { host_id: { type: "string" } }, required: ["host_id"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": { const data = await unifiGet(env, "/v1/hosts"); return `Connected OK to ${UNIFI_BASE} - ${JSON.stringify(data).substring(0, 150)}`; }

    case "list_hosts": return JSON.stringify(await unifiGet(env, "/v1/hosts"), null, 2);
    case "get_host": return JSON.stringify(await unifiGet(env, `/v1/hosts/${args.host_id}`), null, 2);
    case "list_sites": return JSON.stringify(await unifiGet(env, "/v1/sites"), null, 2);

    case "list_devices": { const p: Record<string, string> = {}; if (args.host_id) p.hostIds = String(args.host_id); return JSON.stringify(await unifiGet(env, "/v1/devices", p), null, 2); }
    case "get_device": return JSON.stringify(await unifiGet(env, `/v1/hosts/${args.host_id}/devices/${args.device_id}`), null, 2);

    case "get_isp_metrics": return JSON.stringify(await unifiGet(env, `/v1/hosts/${args.host_id}/isp-metrics`), null, 2);

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — device online/offline counts per host,
// for the Network zone alongside Ninja, Meraki, and Peplink.
//
// CONFIRMED against a live payload (previous version was unverified
// guessing): GET /v1/devices with no params returns
//   { data: [ { hostId, hostName, devices: [ { name, status, productLine,
//   ... } ], updatedAt } ], httpStatusCode, traceId }
// productLine is "network" for switches/APs/gateways, "protect" for
// cameras — filtered to "network" here to keep this route focused on
// what the other network-zone sources report (Meraki/Peplink don't
// currently include cameras either, for consistency). Hosts with zero
// network-class devices (e.g. camera-only Protect sites) are dropped
// rather than showing an empty tile.
// ============================================================

async function buildNetworkStatus(env: Env) {
  const resp = (await unifiGet(env, "/v1/devices")) as any;
  const hostGroups: any[] = resp.data || [];

  const networks = hostGroups
    .map((h) => {
      const devices = (h.devices || []).filter((d: any) => d.productLine === "network");
      const offline = devices.filter((d: any) => d.status === "offline");
      return {
        orgName: h.hostName || `Host ${h.hostId}`,
        totalDevices: devices.length,
        offlineCount: offline.length,
        offlineDevices: offline.map((d: any) => ({ name: d.name || d.mac, status: "offline" })),
      };
    })
    .filter((n) => n.totalDevices > 0);

  return { updated: new Date().toISOString(), networks };
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
    if (url.pathname === "/mcp" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg;
        if (id === undefined) continue;
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "UniFi MCP Server", version: "1.0.0" } } });
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
    return new Response("UniFi MCP Server - POST /mcp, GET /status, GET /health", { status: 200, headers: CORS });
  },
};
