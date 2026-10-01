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

// Just the KV methods used here - this project has no @cloudflare/workers-types.
interface KVNamespace {
  get<T>(key: string, options: { type: "json" }): Promise<T | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  MCP_AUTH_TOKEN?: string; // optional inbound bearer token - see the check at the top of fetch()
  PEPLINK_CLIENT_ID: string;
  PEPLINK_CLIENT_SECRET: string;
  PEPLINK_TOKENS: KVNamespace; // shared OAuth token, see getToken()
}

const IC2_BASE = "https://api.ic.peplink.com";

// InControl2 appears to keep only the newest client_credentials token per
// client: when another isolate of this Worker (or another caller of the
// same API client) fetches a token, the one cached here starts failing
// with 401 invalid_accessor while still inside its stated lifetime.
// Confirmed live 2026-10-01: back-to-back /status calls alternated between
// full data, data with one org silently missing (its fetch 401'd and the
// per-org catch skipped it), and a whole-request 401 - the wallboard polls
// /status and /licenses at the same moment, they land in different
// isolates, and each isolate's fresh token killed the other's.
//
// So the token lives in KV (PEPLINK_TOKENS), shared by every isolate: one
// mints it, the rest reuse it. A 401 retries (up to three tries) and only
// mints a new token if KV still holds the rejected one - if another
// isolate already replaced it, that newer token is used instead. Concurrent
// callers in one isolate share a single in-flight token request. The
// Cache API was tried first and isn't enough (it's a no-op on workers.dev).
let cachedToken: { token: string; expires: number } | null = null;
let tokenRequest: Promise<string> | null = null;
const TOKEN_KV_KEY = "ic2_token";

async function getToken(env: Env, force = false, rejected?: string): Promise<string> {
  if (!force && cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
    // Another isolate may already hold a newer token than the one just rejected.
    const shared = await env.PEPLINK_TOKENS.get<{ token: string; expires: number }>(TOKEN_KV_KEY, { type: "json" });
    if (shared && shared.token !== rejected && shared.expires > Date.now() + 60000) {
      cachedToken = shared;
      return shared.token;
    }
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
    await env.PEPLINK_TOKENS.put(TOKEN_KV_KEY, JSON.stringify(cachedToken), { expirationTtl: Math.max(60, data.expires_in - 120) });
    return data.access_token;
  })();
  try {
    return await tokenRequest;
  } finally {
    tokenRequest = null;
  }
}

async function ic2Get(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  let rejected: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(env, attempt > 0, rejected);
    const url = new URL(`${IC2_BASE}${path}`);
    url.searchParams.set("access_token", token);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (res.status === 401 && attempt < 2) {
      if (cachedToken?.token === token) cachedToken = null;
      rejected = token;
      continue;
    }
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }
}

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to Peplink InControl2 and verify OAuth credentials", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "peplink_api_get", description: "Read-only escape hatch: GET any Peplink InControl2 REST path for data no dedicated tool covers - e.g. '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/interfaces', '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/bandwidth', '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/event_log', '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/client_list', '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/cellular_status', '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/wan_status', '/rest/o/{orgId}/g/{groupId}/d/{deviceId}/pepvpn'. GET only. Optional query params as an object. Response truncated at 60K chars.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Path starting with '/rest/'" }, params: { type: "object", description: "Optional query-string parameters", additionalProperties: true } }, required: ["path"] } },

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
    case "peplink_api_get": {
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("..") || path.includes("?")) throw new Error("peplink_api_get: path must start with '/', contain no '..' and no '?' (pass query params via params).");
      const params = (args.params && typeof args.params === "object") ? Object.fromEntries(Object.entries(args.params as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined;
      if (!path.startsWith("/rest/")) throw new Error("peplink_api_get: path must start with '/rest/'.");
      const text = JSON.stringify(await ic2Get(env, path, params), null, 2);
      return text.length > 60000 ? text.slice(0, 60000) + "\n... [truncated]" : text;
    }
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
// Wallboard /status and /licenses — device health and expiring
// warranty/subscription/Prime dates, for the Network and Business zones.
//
// ONE call per org: GET /rest/o/{org}/d returns every device in the org,
// each tagged with group_id/group_name (confirmed live 2026-10-01). The
// previous version fetched devices group by group, which for "ASG Direct
// Clients" - one org holding a group per client, 47 groups - meant ~50
// calls per poll; that org kept failing partway and its per-org catch
// silently dropped it from the wallboard entirely.
//
// An org with devices in more than one group is a container of clients
// (ASG Direct Clients), so it becomes one tile per group, named after the
// group - same idea as unifi-mcp splitting a shared console by site. An
// org with a single group is one client and keeps the org name as before
// (SBC, Dade County 911, Justice Jewelers). Decided from the data each
// poll; no org name is hardcoded.
//
// Expiry field names (expiry_date, sub_expiry_date, prime_expiry_date)
// come from the published InControl2 device schema; expiry_date is
// confirmed live on the org-level device list.
// ============================================================

async function listOrgDevices(env: Env): Promise<Array<{ org: any; devices: any[]; multiGroup: boolean }>> {
  const orgs = (await ic2Get(env, "/rest/o")) as any;
  const orgList: any[] = orgs.data || orgs || [];
  const perOrg = await Promise.all(orgList.map(async (org) => {
    try {
      const resp = (await ic2Get(env, `/rest/o/${org.id}/d`)) as any;
      const devices: any[] = resp.data || resp || [];
      const multiGroup = new Set(devices.map((d) => d.group_id)).size > 1;
      return { org, devices, multiGroup };
    } catch {
      return null; // skip an org that errors rather than failing the whole response
    }
  }));
  return perOrg.filter((o): o is NonNullable<typeof o> => o !== null);
}

function tileName(org: any, device: any, multiGroup: boolean): string {
  return (multiGroup && device.group_name) || org.name || `Org ${org.id}`;
}

async function buildNetworkStatus(env: Env) {
  const tiles = new Map<string, { orgName: string; totalDevices: number; offlineCount: number; offlineDevices: Array<{ name: string; status: string }> }>();
  for (const { org, devices, multiGroup } of await listOrgDevices(env)) {
    for (const d of devices) {
      const name = tileName(org, d, multiGroup);
      if (!tiles.has(name)) tiles.set(name, { orgName: name, totalDevices: 0, offlineCount: 0, offlineDevices: [] });
      const t = tiles.get(name)!;
      t.totalDevices++;
      if (d.online === false || d.status === "offline") {
        t.offlineCount++;
        t.offlineDevices.push({ name: d.name || d.sn, status: "offline" });
      }
    }
  }
  return { updated: new Date().toISOString(), networks: [...tiles.values()] };
}

async function buildLicenseStatus(env: Env) {
  const now = Date.now();
  const in60Days = now + 60 * 24 * 3600 * 1000;
  const upcomingRenewals: Array<{ company: string; product: string; renewalDate: string; source: string }> = [];
  for (const { org, devices, multiGroup } of await listOrgDevices(env)) {
    for (const d of devices) {
      const checks: Array<[string, string | undefined]> = [
        ["Warranty", d.expiry_date],
        ["InControl2 Subscription", d.sub_expiry_date],
        ["Prime", d.prime_expiry_date],
      ];
      for (const [label, dateStr] of checks) {
        if (!dateStr) continue;
        const t = new Date(dateStr).getTime();
        if (t >= now && t < in60Days) { // exclude already-lapsed dates — assumed cancelled/not renewing
          upcomingRenewals.push({
            company: tileName(org, d, multiGroup),
            product: `${d.name || d.sn || "Device"} — ${label}`,
            renewalDate: new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            source: "Peplink",
          });
        }
      }
    }
  }
  return { updated: new Date().toISOString(), upcomingRenewals };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

// Constant-time string compare for the inbound bearer check below (no
// early exit on the first differing byte); a length mismatch is fine to
// short-circuit on.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // Inbound auth (opt-in): once the MCP_AUTH_TOKEN secret is set on this
    // Worker, every route except OPTIONS and /health must carry
    // "Authorization: Bearer <that token>" - the same header the MCP client
    // registrations already send. Unset = unchanged behavior, so this code
    // deploys safely ahead of the secret. Real finding: every Worker in this
    // repo answered tools/list - and therefore every write tool - to a bare,
    // credential-less request on its public workers.dev URL, while the client
    // side had been sending a Bearer token all along that nothing ever
    // checked.
    // Read-only wallboard routes stay open (Roger, 2026-09-25, "option 1"):
    // GET/HEAD on /health, /status and /licenses, which the wallboard
    // (rafouche/Dashboard, a static page) polls without a token. Every tool
    // and pipeline route needs the token once MCP_AUTH_TOKEN is set.
    const publicRead = (request.method === "GET" || request.method === "HEAD") && ["/health", "/status", "/licenses"].includes(url.pathname);
    if (env.MCP_AUTH_TOKEN && !publicRead) {
      const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
      }
    }
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
