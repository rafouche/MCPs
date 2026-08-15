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
 *
 * CLIENT DEVICES (list_network_sites / list_network_devices / list_clients):
 * these go through UniFi's Cloud Connector, which proxies a request to the
 * console's own local Network Integration API — this works for self-hosted
 * controllers too (e.g. unifi.altecusa.com), not just cloud-hosted consoles,
 * as long as the console is linked to this UI.com account (already true,
 * since list_hosts/list_devices work) and running Network app FW >= 5.0.3.
 * No VPN or separate local credentials needed — same UNIFI_API_KEY, proxied
 * via /v1/connector/consoles/{hostId}/proxy/network/integration{localPath}.
 *
 * Confirmed via UniFi's own OpenAPI schema: client records only carry
 * "uplinkDeviceId" (which device/AP/switch they're connected to) on the
 * WIRED/WIRELESS subtypes — it's not in the base client schema shown on the
 * docs page, and isn't a server-side filterable field, so list_clients
 * resolves it to a friendly device name and filters by device_id itself.
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

// Proxies to a console's local Network Integration API via the Cloud Connector.
// device_offline / DeviceTimeout from api.ui.com almost always means this
// host_id is stale (e.g. left over from a controller migrated to UniFi OS,
// which gets a brand-new host identity rather than updating in place) rather
// than a real outage — so the hint below is worth surfacing every time,
// not just diagnosing it by hand each time someone hits this.
async function connectorGet(env: Env, hostId: string, path: string, params?: Record<string, string>): Promise<unknown> {
  try {
    return await unifiGet(env, `/v1/connector/consoles/${hostId}/proxy/network/integration${path}`, params);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("device_offline") || msg.includes("DeviceTimeout")) {
      throw new Error(
        `${msg} — HINT: host_id "${hostId}" may be stale, not actually offline. This commonly happens after a console is migrated to UniFi OS ` +
        `(e.g. a self-hosted install upgraded to UniFi OS Server) — that creates a BRAND NEW host_id rather than updating the old one, and the old ` +
        `host_id stays in list_hosts permanently reporting state:"disconnected". Call list_hosts and look for a DIFFERENT entry with ` +
        `state:"connected" that represents the same console before assuming this is a real outage.`
      );
    }
    throw err;
  }
}

// Auto-paginates a connector-proxied list endpoint (default page size 25 is too
// small for real accounts — some consoles have 80+ sites) up to maxItems total.
async function connectorGetAllPages(env: Env, hostId: string, path: string, maxItems: number): Promise<any[]> {
  const items: any[] = [];
  let offset = 0;
  while (items.length < maxItems) {
    const pageLimit = Math.min(200, maxItems - items.length);
    const page = (await connectorGet(env, hostId, path, { offset: String(offset), limit: String(pageLimit) })) as any;
    const batch = page.data || [];
    items.push(...batch);
    offset += batch.length;
    if (batch.length < pageLimit || offset >= (page.totalCount ?? offset)) break;
  }
  return items;
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

  // Local Network Integration API (via Cloud Connector) — client devices
  { name: "list_network_sites", description: "List local Network-application sites on a specific UniFi console/host. Works for self-hosted controllers too (proxied through the Cloud Connector). Needed to get the site_id used by list_network_devices and list_clients — MSP/multi-site consoles can have many sites (auto-paginated, default up to 500), single-site consoles just have one named 'Default'.", inputSchema: { type: "object", properties: { host_id: { type: "string", description: "Host/console ID from list_hosts" }, search: { type: "string", description: "Optional: only return sites whose name contains this text (case-insensitive)" }, limit: { type: "number", description: "Max sites to return, default 500" } }, required: ["host_id"] } },
  { name: "list_network_devices", description: "List adopted UniFi devices (APs, switches, gateways) on one site via the local Network Integration API. Richer per-device detail than list_devices (ports, radios, uplink topology), and used internally by list_clients to resolve device names.", inputSchema: { type: "object", properties: { host_id: { type: "string" }, site_id: { type: "string", description: "Site ID from list_network_sites" }, limit: { type: "number", description: "Max devices to return, default 200" } }, required: ["host_id", "site_id"] } },
  { name: "list_clients", description: "List client devices (computers, phones, IoT, etc.) connected to a UniFi network, each resolved with the name of the specific AP/switch/gateway it's connected to. Optionally filter to only the clients connected to one device.", inputSchema: { type: "object", properties: { host_id: { type: "string" }, site_id: { type: "string", description: "Site ID from list_network_sites" }, device_id: { type: "string", description: "Optional: only return clients connected to this device (AP/switch/gateway) ID" }, limit: { type: "number", description: "Max clients to return, default 200" } }, required: ["host_id", "site_id"] } },
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

    case "list_network_sites": {
      const sites = await connectorGetAllPages(env, args.host_id as string, "/v1/sites", Number(args.limit ?? 500));
      const search = (args.search as string | undefined)?.toLowerCase();
      const filtered = search ? sites.filter((s: any) => (s.name || "").toLowerCase().includes(search)) : sites;
      return JSON.stringify({ count: filtered.length, totalOnConsole: sites.length, sites: filtered }, null, 2);
    }

    case "list_network_devices": {
      const devices = await connectorGetAllPages(env, args.host_id as string, `/v1/sites/${args.site_id}/devices`, Number(args.limit ?? 200));
      return JSON.stringify({ count: devices.length, devices }, null, 2);
    }

    case "list_clients": {
      const hostId = args.host_id as string;
      const siteId = args.site_id as string;
      const limit = Number(args.limit ?? 200);

      const devices = await connectorGetAllPages(env, hostId, `/v1/sites/${siteId}/devices`, 500);
      const deviceNameById = new Map(devices.map((d: any) => [d.id, d.name || d.model || d.id]));

      const clients = await connectorGetAllPages(env, hostId, `/v1/sites/${siteId}/clients`, limit);

      const enriched = clients.map((c: any) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        macAddress: c.macAddress,
        ipAddress: c.ipAddress,
        connectedAt: c.connectedAt,
        uplinkDeviceId: c.uplinkDeviceId ?? null,
        uplinkDeviceName: c.uplinkDeviceId ? deviceNameById.get(c.uplinkDeviceId) ?? c.uplinkDeviceId : null,
        access: c.access,
      }));

      const filtered = args.device_id ? enriched.filter((c) => c.uplinkDeviceId === args.device_id) : enriched;
      return JSON.stringify({ count: filtered.length, clients: filtered }, null, 2);
    }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — device online/offline counts per tile,
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
//
// One tile per HOST is wrong for a shared, self-hosted console that
// manages many clients' sites (confirmed live: one such console has 87
// sites bundled under a single hostName) — every client on it would get
// merged into one tile under the console's own name. Consoles Altec
// directly owns/administers expose the local Network Integration API
// (list_network_sites/list_network_devices, same as the MCP tools above)
// and can be split per-site instead; consoles Altec only has cloud-adopted
// access to 403 on that call ("user is not the owner of this host") and
// are single-tenant anyway, so their one cloud-level tile already
// represents one real client. Which host is the shared one is discovered
// dynamically from its site count each poll — nothing about a specific
// host name or ID is hardcoded, so a console rename (or a client's
// single-site console growing/shrinking) never needs a code change here.
//
// A host with MORE than ~40 sites is left as a single combined tile
// rather than split, and NOT retried into splitting — confirmed live that
// Cloudflare's per-invocation subrequest cap makes an 87-site fan-out fail
// partway through consistently (a hard ceiling, not fixable by tuning
// concurrency/retries), and a partial split would silently drop whichever
// sites lost the race, which is worse than the original merge-everything
// bug. Splitting a host that large for real needs a cached/incremental
// refresh spread across multiple polls (e.g. via KV), not a one-shot fetch
// — flagged as a known gap, not implemented here.
// ============================================================

// Bounded-concurrency map — firing 80+ proxied per-site requests at one
// console in a single Promise.all risks tripping the Cloud Connector's own
// throttling (confirmed live: an unbounded fan-out here made every site
// fetch fail, silently collapsing the split below). A handful at a time
// is gentler on the console and still far faster than doing them serially.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function buildHostTiles(env: Env, h: any): Promise<Array<{ orgName: string; totalDevices: number; offlineCount: number; offlineDevices: unknown[] }>> {
  const devices = (h.devices || []).filter((d: any) => d.productLine === "network");
  if (devices.length === 0) return [];

  let sites: any[] = [];
  try {
    sites = await connectorGetAllPages(env, h.hostId, "/v1/sites", 500);
  } catch {
    // Not owned (403) or otherwise unreachable via the local Integration
    // API — fall through to the single cloud-level host tile below.
  }

  // A host with many sites (confirmed live: one console has 87) can't have
  // all of them fetched in a single Worker invocation — Cloudflare caps
  // subrequests per invocation (confirmed live: this host's fan-out started
  // failing with "Too many subrequests" partway through, consistently,
  // regardless of concurrency or retries — a hard ceiling, not something
  // tunable away). A partial split would silently DROP whichever sites lost
  // the race — worse than the original bug, since a missing client tile
  // reads as "nothing to report" instead of "merged into the wrong tile".
  // So the split is only trusted when every site resolves cleanly; anything
  // less falls back to the honest single combined tile below. Hosts with a
  // sensible number of sites split fine; a host too large to fit the
  // subrequest budget needs a cached/incremental refresh across polls
  // instead of a one-shot fetch — not implemented here yet.
  if (sites.length > 1 && sites.length <= 40) {
    let anyFailed = false;
    const perSite = await mapWithConcurrency(sites, 4, async (s: any) => {
      try {
        const siteDevices = await connectorGetAllPages(env, h.hostId, `/v1/sites/${s.id}/devices`, 200);
        if (siteDevices.length === 0) return null;
        const offline = siteDevices.filter((d: any) => d.state === "OFFLINE");
        return {
          orgName: s.name || `Site ${s.id}`,
          totalDevices: siteDevices.length,
          offlineCount: offline.length,
          offlineDevices: offline.map((d: any) => ({ name: d.name || d.macAddress, status: "offline" })),
        };
      } catch {
        anyFailed = true;
        return null;
      }
    });
    if (!anyFailed) {
      const tiles = perSite.filter((t): t is NonNullable<typeof t> => t !== null);
      if (tiles.length > 0) return tiles;
    }
  }

  const offline = devices.filter((d: any) => d.status === "offline");
  return [{
    orgName: h.hostName || `Host ${h.hostId}`,
    totalDevices: devices.length,
    offlineCount: offline.length,
    offlineDevices: offline.map((d: any) => ({ name: d.name || d.mac, status: "offline" })),
  }];
}

async function buildNetworkStatus(env: Env) {
  const resp = (await unifiGet(env, "/v1/devices")) as any;
  const hostGroups: any[] = resp.data || [];

  const tiles = await Promise.all(hostGroups.map((h) => buildHostTiles(env, h)));

  return { updated: new Date().toISOString(), networks: tiles.flat() };
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
