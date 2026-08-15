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
// Wallboard status route — device online/offline counts per SITE (one
// tile per real client), for the Network zone alongside Ninja, Meraki,
// and Peplink.
//
// Earlier versions of this route grouped by HOST/console instead of by
// site, using GET /v1/devices (device list, one entry per console) and,
// for one version, an N-requests-per-console fan-out through the local
// Network Integration API to break a shared console's sites out — both
// wrong or impractical. The fix: GET /v1/sites is a DIFFERENT cloud-level
// endpoint (confirmed live) that returns every site across every console
// in ONE call, each with a client-facing name (meta.desc) and device
// counts already computed server-side (statistics.counts.totalDevice /
// offlineDevice) — no per-site fan-out needed at all, and no risk of
// hitting Cloudflare's per-invocation subrequest cap the way the fan-out
// did on a console with 87 sites.
//
// The same site can appear more than once in the response under
// different hostIds (confirmed live, e.g. a site reachable via both an
// old and current console identity after a migration) — deduped by
// siteId, first occurrence wins. Sites with no devices (statistics null,
// or totalDevice 0 — e.g. a decommissioned site) are dropped rather than
// showing an empty tile. This endpoint doesn't return individual device
// names, only counts, so offlineDevices is always empty here (the
// Network zone's UI doesn't currently render per-device names for
// org-level tiles anyway, only the total/offline counts).
//
// meta.desc isn't always a client name: several single-site consoles were
// never given a custom site description and still report the literal
// site default ("Default") — confirmed live across 4 separate consoles.
// Using meta.desc alone there would collapse several different clients
// down to indistinguishable "Default" tiles, a regression from the old
// hostName-based tiles (which WERE client-specific for these single-site
// consoles, just not for the one shared multi-tenant console this route
// was rewritten to handle). So a second bulk call (GET /v1/devices, same
// one this route used pre-rewrite) resolves hostId -> hostName, and a
// generic site desc falls back to that.
// ============================================================

function isGenericSiteName(desc: string | undefined): boolean {
  return !desc || desc.trim().toLowerCase() === "default";
}

async function buildNetworkStatus(env: Env) {
  const [sitesResp, devicesResp] = await Promise.all([
    unifiGet(env, "/v1/sites") as Promise<any>,
    unifiGet(env, "/v1/devices") as Promise<any>,
  ]);
  const allSites: any[] = sitesResp.data || [];
  const hostNameById = new Map<string, string>((devicesResp.data || []).map((h: any) => [h.hostId, h.hostName]));

  const bySiteId = new Map<string, any>();
  for (const s of allSites) {
    if (!bySiteId.has(s.siteId)) bySiteId.set(s.siteId, s);
  }

  const networks = [...bySiteId.values()]
    .filter((s) => s.statistics && s.statistics.counts.totalDevice > 0)
    .map((s) => {
      const siteName = s.meta.desc || s.meta.name;
      const orgName = isGenericSiteName(siteName) ? hostNameById.get(s.hostId) || siteName || `Site ${s.siteId}` : siteName;
      return {
        orgName,
        totalDevices: s.statistics.counts.totalDevice,
        offlineCount: s.statistics.counts.offlineDevice,
        offlineDevices: [] as unknown[],
      };
    });

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
