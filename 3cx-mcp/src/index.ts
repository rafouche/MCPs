/**
 * 3CX MCP - every client's 3CX v20 PBX through one connector.
 *
 * CLIENT LIST = HUDU. The clients this Worker can reach are the Hudu assets
 * in the "Api secrets" layout (HUDU_SECRETS_LAYOUT) whose name contains
 * "3CX", e.g. "Altec 3CX API - https://altec.mo.3cx.us/". Each holds the
 * PBX's XAPI credential: a "Client ID" field and a "Client Secret" field;
 * the PBX URL is the https:// address in the asset name (or a URL/FQDN
 * field). Adding a client = creating that asset in Hudu - no deploy, no
 * Cloudflare secret. The list is cached for 5 minutes per isolate
 * (list_clients with refresh: true reloads it). Secrets never leave the
 * Worker: no tool returns them. The 3CX side: Admin > Integrations > API >
 * Add, tick XAPI access, role System Owner/Admin (needs an Enterprise
 * licence); the Client ID is the DN it shows, the secret is shown once.
 *
 * EVERY API = THE CATALOG. src/catalog.json is generated from 3CX's own
 * OpenAPI spec (spec/swagger.yaml, `npm run catalog`): 600+ operations and
 * every entity/enum schema. tcx_find_endpoints / tcx_describe_endpoint /
 * tcx_describe_schema browse it; tcx_call runs any operation by its
 * operationId on any client, writing the OData URL (typed key and function
 * parameter literals, parameter aliases for complex values) from the spec
 * instead of leaving it to the caller. tcx_api_get / tcx_api_request take a
 * raw /xapi/v1 path for anything else. A PBX on a different build than the
 * catalog's may lack an operation (404) - list_clients with check: true
 * shows each PBX's version beside the catalog's.
 *
 * ONE TOKEN PER PBX. 3CX allows one active access token per API client (see
 * 3cx/xapi-tutorial: "the PBX only allows one active access token at a
 * time") - the same trap as Peplink (CLAUDE.md, 2026-10-01): isolates that
 * mint their own tokens invalidate each other. Tokens live in KV
 * (TCX_TOKENS), shared by every isolate; a 401 retries and only mints a new
 * token if KV still holds the rejected one.
 *
 * Fails closed like hudu-mcp: no MCP_AUTH_TOKEN = 503 on everything but
 * /health, since this Worker holds write access to every client's phone
 * system. Password/PIN/secret-named fields in responses are redacted.
 *
 * SECRETS: HUDU_API_KEY (a Hudu API key that can read the Api secrets
 * layout), MCP_AUTH_TOKEN. VARS (wrangler.jsonc): HUDU_BASE_URL,
 * HUDU_SECRETS_LAYOUT.
 */
import catalogJson from "./catalog.json";

export interface Env {
  MCP_AUTH_TOKEN?: string;
  HUDU_API_KEY?: string;
  HUDU_BASE_URL: string;
  HUDU_SECRETS_LAYOUT?: string;
  TCX_TOKENS: KVNamespace;
}

// ---------- catalog ----------

type ParamSpec = [string, string] | [string, string, number];
interface Op {
  id: string; m: string; p: string; s: string; tag: string;
  k?: string; pp?: ParamSpec[]; q?: string; xq?: [string, string][];
  b?: string | Record<string, string>; r?: string;
}
interface Catalog {
  version: string;
  ops: Op[];
  schemas: Record<string, { base?: string; props: Record<string, string> }>;
  enums: Record<string, string[]>;
}
const CATALOG = catalogJson as unknown as Catalog;
const OPS_BY_ID = new Map(CATALOG.ops.map((o) => [o.id.toLowerCase(), o]));
const QUERY_NAMES: Record<string, string> = { t: "$top", k: "$skip", s: "$search", f: "$filter", c: "$count", o: "$orderby", l: "$select", e: "$expand" };

function schemaName(name: string): string {
  return name.startsWith("Pbx.") ? name : `Pbx.${name}`;
}

function schemaProps(name: string): Record<string, string> | null {
  let s: Catalog["schemas"][string] | undefined = CATALOG.schemas[schemaName(name)];
  if (!s) return null;
  // Base types first, so a derived type's own property wins.
  const chain: Record<string, string>[] = [];
  for (; s; s = s.base ? CATALOG.schemas[s.base] : undefined) chain.unshift(s.props);
  return Object.assign({}, ...chain);
}

function findOp(ref: string): Op {
  const direct = OPS_BY_ID.get(ref.trim().toLowerCase());
  if (direct) return direct;
  // "GET /Users" style
  const m = ref.trim().match(/^(GET|POST|PATCH|PUT|DELETE)\s+(\S+)$/i);
  if (m) {
    const hit = CATALOG.ops.find((o) => o.m === m[1].toUpperCase() && o.p.toLowerCase() === m[2].toLowerCase());
    if (hit) return hit;
  }
  const near = CATALOG.ops.filter((o) => o.id.toLowerCase().includes(ref.trim().toLowerCase())).slice(0, 10).map((o) => o.id);
  throw new Error(`Unknown operation "${ref}".${near.length ? ` Close matches: ${near.join(", ")}.` : ""} Use tcx_find_endpoints to search.`);
}

function opLine(o: Op): string {
  const params = o.pp?.length ? `(${o.pp.map((p) => `${p[0]}: ${p[1]}${p[2] ? "?" : ""}`).join(", ")})` : "";
  const q = o.q ? ` [${[...o.q].map((c) => QUERY_NAMES[c]).join(" ")}]` : "";
  const body = o.b ? ` body: ${typeof o.b === "string" ? o.b : `{${Object.entries(o.b).map(([k, t]) => `${k}: ${t}`).join(", ")}}`}` : "";
  return `${o.id}${params} -> ${o.m} ${o.p.replace(/\(.*\)$/, "(...)")}${q}${body}${o.r ? ` => ${o.r}` : ""}`;
}

// ---------- clients (from Hudu) ----------

interface Client {
  key: string;
  name: string;
  company: string;
  url: string;
  clientId: string;
  secret: string;
  huduAssetId: number;
  huduUrl: string;
  problem?: string;
}

let clientCache: { at: number; clients: Client[] } | null = null;
let clientRequest: Promise<Client[]> | null = null;
const CLIENT_TTL_MS = 5 * 60 * 1000;

async function huduGet(env: Env, path: string, params: Record<string, string | number> = {}): Promise<any> {
  const base = (env.HUDU_BASE_URL || "").replace(/\/+$/, "");
  const url = new URL(`${base}/api/v1${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), { headers: { "x-api-key": env.HUDU_API_KEY ?? "", Accept: "application/json" } });
  if (!res.ok) throw new Error(`Hudu GET ${path} failed (${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function fieldValue(asset: any, re: RegExp): string {
  const f = (asset.fields ?? []).find((x: any) => re.test(String(x.label ?? "")));
  const v = f?.value;
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function toClient(asset: any): Client {
  const name: string = asset.name ?? "";
  const urlInName = name.match(/https?:\/\/[^\s/]+/i)?.[0];
  const urlField = fieldValue(asset, /^(url|website|fqdn|host|pbx url|server)$/i);
  let url = (urlInName || urlField || "").replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (url) url = url.replace(/^(https?:\/\/[^/]+).*$/i, "$1");
  // "Altec 3CX API - https://..." -> "Altec"; fall back to the company.
  const label = name.split(/\s+3cx\b/i)[0].replace(/\s*[-|:]\s*$/, "").trim() || asset.company_name || name;
  const c: Client = {
    key: slug(label),
    name: label,
    company: asset.company_name ?? "",
    url,
    clientId: fieldValue(asset, /client\s*id/i),
    secret: fieldValue(asset, /client\s*secret|^secret$|api\s*key/i),
    huduAssetId: asset.id,
    huduUrl: asset.url ?? "",
  };
  const missing = [!c.url && "PBX URL (put it in the asset name or a URL field)", !c.clientId && "Client ID field", !c.secret && "Client Secret field"].filter(Boolean);
  if (missing.length) c.problem = `Hudu asset is missing: ${missing.join(", ")}`;
  return c;
}

async function loadClients(env: Env, refresh = false): Promise<Client[]> {
  if (!env.HUDU_API_KEY) throw new Error("HUDU_API_KEY secret is not set on this Worker - it reads the client list from Hudu.");
  if (!refresh && clientCache && Date.now() - clientCache.at < CLIENT_TTL_MS) return clientCache.clients;
  if (clientRequest) return clientRequest;
  clientRequest = (async () => {
    const wanted = (env.HUDU_SECRETS_LAYOUT || "Api secrets").toLowerCase();
    // /asset_layouts is paged (25 a page) - the Api secrets layout (id 32)
    // was not on page 1 (2026-10-05). Ask by name first, then page.
    const isWanted = (l: any) => String(l.name).toLowerCase() === wanted;
    let layout = ((await huduGet(env, "/asset_layouts", { name: env.HUDU_SECRETS_LAYOUT || "Api secrets" })).asset_layouts ?? []).find(isWanted);
    for (let page = 1; !layout && page <= 10; page++) {
      const batch: any[] = (await huduGet(env, "/asset_layouts", { page })).asset_layouts ?? [];
      layout = batch.find(isWanted);
      if (batch.length < 25) break;
    }
    if (!layout) throw new Error(`Hudu has no asset layout named "${env.HUDU_SECRETS_LAYOUT || "Api secrets"}" (HUDU_SECRETS_LAYOUT).`);
    const assets: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch: any[] = (await huduGet(env, "/assets", { asset_layout_id: layout.id, page, page_size: 100 })).assets ?? [];
      assets.push(...batch);
      if (batch.length < 100) break;
    }
    const clients = assets
      // "<Client> 3CX API - <url>", or 3CX as the Service Name - not every
      // asset mentioning 3CX ("3CX MCP -> Hudu API Key" is this Worker's own key).
      .filter((a) => !a.archived && (/3cx\s+api/i.test(a.name ?? "") || /^3cx\b/i.test(fieldValue(a, /service\s*name/i))))
      .map(toClient)
      .sort((a, b) => a.name.localeCompare(b.name));
    // Unique keys: a second "Altec" becomes "altec-2".
    const seen = new Map<string, number>();
    for (const c of clients) {
      const n = (seen.get(c.key) ?? 0) + 1;
      seen.set(c.key, n);
      if (n > 1) c.key = `${c.key}-${n}`;
    }
    clientCache = { at: Date.now(), clients };
    return clients;
  })();
  try {
    return await clientRequest;
  } finally {
    clientRequest = null;
  }
}

async function resolveClient(env: Env, ref: unknown): Promise<Client> {
  const clients = await loadClients(env);
  if (!clients.length) throw new Error(`No 3CX clients found in Hudu: add an "${env.HUDU_SECRETS_LAYOUT || "Api secrets"}" asset named "<Client> 3CX API - https://<pbx>" with Client ID and Client Secret fields.`);
  const available = () => clients.map((c) => c.key).join(", ");
  let hit: Client | undefined;
  if (ref === undefined || ref === null || ref === "") {
    if (clients.length !== 1) throw new Error(`"client" is required. Available clients: ${available()}`);
    hit = clients[0];
  } else {
    const r = String(ref).trim().toLowerCase();
    const host = (c: Client) => c.url.replace(/^https?:\/\//i, "").toLowerCase();
    hit = clients.find((c) => c.key === r || c.name.toLowerCase() === r || c.company.toLowerCase() === r || host(c) === r || c.url.toLowerCase() === r.replace(/\/+$/, ""));
    if (!hit) {
      const partial = clients.filter((c) => [c.key, c.name.toLowerCase(), c.company.toLowerCase(), host(c)].some((s) => s.includes(r)));
      if (partial.length === 1) hit = partial[0];
      else if (partial.length > 1) throw new Error(`"${ref}" matches several clients: ${partial.map((c) => c.key).join(", ")}`);
      else throw new Error(`No 3CX client "${ref}". Available clients: ${available()}`);
    }
  }
  if (hit.problem) throw new Error(`Client "${hit.key}" can't be used: ${hit.problem} (${hit.huduUrl})`);
  return hit;
}

// ---------- 3CX auth (one token per PBX, shared through KV) ----------

const memTokens = new Map<string, { token: string; expires: number }>();
const tokenRequests = new Map<string, Promise<string>>();

async function getToken(env: Env, c: Client, force = false, rejected?: string): Promise<string> {
  const cacheKey = `token:${c.clientId}@${c.url}`;
  const mem = memTokens.get(cacheKey);
  if (!force && mem && mem.expires > Date.now() + 60000) return mem.token;
  const inFlight = tokenRequests.get(cacheKey);
  if (inFlight) return inFlight;
  const req = (async () => {
    const shared = await env.TCX_TOKENS.get<{ token: string; expires: number }>(cacheKey, { type: "json" });
    if (shared && shared.token !== rejected && shared.expires > Date.now() + 60000) {
      memTokens.set(cacheKey, shared);
      return shared.token;
    }
    const res = await fetch(`${c.url}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, grant_type: "client_credentials" }).toString(),
    });
    if (!res.ok) throw new Error(`3CX auth failed for ${c.key} (${c.url}) (${res.status}): ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    const entry = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
    memTokens.set(cacheKey, entry);
    await env.TCX_TOKENS.put(cacheKey, JSON.stringify(entry), { expirationTtl: Math.max(60, data.expires_in - 120) });
    return data.access_token;
  })();
  tokenRequests.set(cacheKey, req);
  try {
    return await req;
  } finally {
    tokenRequests.delete(cacheKey);
  }
}

function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    const val = Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${encodeURIComponent(k).replace(/^%24/, "$").replace(/^%40/, "@")}=${encodeURIComponent(val)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

async function tcx(env: Env, c: Client, method: string, path: string, query?: Record<string, unknown>, body?: unknown): Promise<unknown> {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.includes("..")) throw new Error("path may not contain '..'");
  const url = `${c.url}/xapi/v1${path}${buildQuery(query)}`;
  let rejected: string | undefined;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(env, c, attempt > 0, rejected);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && attempt < 2) {
      const key = `token:${c.clientId}@${c.url}`;
      if (memTokens.get(key)?.token === token) memTokens.delete(key);
      rejected = token;
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} on ${c.key} failed (${res.status}): ${(await res.text()).slice(0, 2000)}`);
    if (res.status === 204) return { success: true, status: 204 };
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      const text = await res.text();
      return text ? JSON.parse(text) : { success: true, status: res.status };
    }
    if (/^text\/|xml|csv/.test(type)) return { status: res.status, content_type: type, text: await res.text() };
    const size = (await res.arrayBuffer()).byteLength;
    return { status: res.status, content_type: type, bytes: size, note: "Binary response (file download) - not returned through MCP." };
  }
}

// ---------- OData literals for tcx_call ----------

function literal(name: string, type: string, nullable: boolean, value: unknown, aliases: Record<string, string>): string {
  if (value === undefined || value === null) {
    // 3CX validates every function parameter as required, nullable or not:
    // null for an optional string 400s ("The queueDns field is required"),
    // an empty string is what the admin console sends (live, 2026-10-05).
    if (nullable && type === "string" && value === undefined) return "''";
    if (nullable || value === null) return "null";
    throw new Error(`missing parameter ${name} (${type})`);
  }
  if (type.endsWith("[]") || type === "object" || (CATALOG.schemas[type] && !CATALOG.enums[type])) {
    aliases[`@${name}`] = typeof value === "string" ? value : JSON.stringify(value);
    return `@${name}`;
  }
  switch (type) {
    case "int":
    case "num": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
      return String(n);
    }
    case "bool":
      return value === true || value === "true" ? "true" : "false";
    case "date-time": {
      const d = new Date(String(value));
      if (isNaN(d.getTime())) throw new Error(`${name} must be an ISO date-time, e.g. 2026-10-01T00:00:00Z`);
      return d.toISOString();
    }
    case "date":
    case "uuid":
      return encodeURIComponent(String(value));
  }
  if (CATALOG.enums[type]) {
    const v = String(value);
    const match = CATALOG.enums[type].find((e) => e.toLowerCase() === v.toLowerCase());
    if (!match) throw new Error(`${name} must be one of ${CATALOG.enums[type].join(", ")}`);
    return `${type}'${match}'`;
  }
  return `'${encodeURIComponent(String(value).replace(/'/g, "''"))}'`;
}

function buildOpPath(op: Op, params: Record<string, unknown>, aliases: Record<string, string>): string {
  let path = op.p;
  for (const [name, type, nullable] of op.pp ?? []) {
    const lit = literal(name, type, !!nullable, params[name], aliases);
    path = path.split(`{${name}}`).join(lit);
  }
  return path;
}

function normalizeQuery(q: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!q || typeof q !== "object") return out;
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    const key = k.startsWith("$") || k.startsWith("@") || !["top", "skip", "search", "filter", "count", "orderby", "select", "expand"].includes(k.toLowerCase()) ? k : `$${k.toLowerCase()}`;
    out[key] = v;
  }
  return out;
}

// ---------- output ----------

const REDACT = /(password|secret|apikey|api_key|privatekey|private_key|^vmpin$|^pin$|accesstoken|refreshtoken|clientsecret)$/i;

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = REDACT.test(k) && typeof val === "string" && val ? "[redacted]" : redact(val);
    }
    return out;
  }
  return v;
}

const MAX_CHARS = 60000;
function out(v: unknown): string {
  const text = typeof v === "string" ? v : JSON.stringify(redact(v), null, 1);
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n...[truncated at ${MAX_CHARS} of ${text.length} chars - narrow it with $top/$skip, $select or $filter]`;
}

// ---------- tools ----------

const CLIENT = { client: { type: "string", description: "Which client's PBX: its key from list_clients (e.g. 'altec'), name, company or PBX host. Optional only when exactly one client exists." } };
const ODATA = {
  filter: { type: "string", description: "OData $filter, e.g. \"Number eq '100'\" or \"contains(LastName,'smith')\"" },
  select: { type: "string", description: "OData $select, comma-separated properties (see tcx_describe_schema)" },
  orderby: { type: "string", description: "OData $orderby, e.g. 'Number asc'" },
  top: { type: "number", description: "Max rows (default 100)" },
  skip: { type: "number", description: "Rows to skip (paging)" },
};
const RANGE = {
  from: { type: "string", description: "Start, ISO date-time e.g. 2026-10-01T00:00:00Z" },
  to: { type: "string", description: "End, ISO date-time" },
};

const TOOLS = [
  { name: "list_clients", description: "List every client 3CX PBX this connector can reach (read from Hudu 'Api secrets' assets named '<Client> 3CX API - <url>'). Shows key, name, company, PBX URL and any setup problem; never shows secrets. check: true also signs in to each PBX and reports its version and status beside the API catalog's version.", inputSchema: { type: "object", properties: { check: { type: "boolean", description: "Connect to each PBX and report version/status (slower)" }, refresh: { type: "boolean", description: "Reload the list from Hudu now instead of the 5-minute cache" } } } },
  { name: "tcx_find_endpoints", description: `Search the full 3CX XAPI catalog (${CATALOG.ops.length} operations from 3CX's own OpenAPI spec, PBX build ${CATALOG.version}) by keyword - e.g. 'queue agents', 'reboot phone', 'call log', 'forwarding profile', 'backup', 'trunk registration'. With no query, lists the API areas (tags) and how many operations each has. Each hit shows the operationId to pass to tcx_call, its parameters, OData query options, body and result type.`, inputSchema: { type: "object", properties: { query: { type: "string", description: "Words that must all appear in the operation id, path, area or summary" }, method: { type: "string", description: "Only GET / POST / PATCH / PUT / DELETE" }, area: { type: "string", description: "Only this area (tag), e.g. Users, Queues, Trunks" }, limit: { type: "number", description: "Max hits (default 40)" } } } },
  { name: "tcx_describe_endpoint", description: "Full detail of one XAPI operation: path template, typed parameters (with allowed enum values), OData query options, request body fields and result type, plus a ready tcx_call example.", inputSchema: { type: "object", properties: { operation: { type: "string", description: "operationId (e.g. GetCallLogData) or 'METHOD /path'" } }, required: ["operation"] } },
  { name: "tcx_describe_schema", description: "Properties and types of a 3CX entity/complex type (e.g. User, Queue, CallHistoryView, ForwardingProfile), or the values of an enum - use it to build $select/$filter or a PATCH body.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Schema name, with or without the 'Pbx.' prefix" } }, required: ["name"] } },
  { name: "tcx_call", description: "Run ANY 3CX XAPI operation on a client's PBX by its operationId (find it with tcx_find_endpoints). The Worker builds the OData URL from the spec: path/key/function parameters go in params (typed literals are written for you; an omitted optional text parameter is sent as '' - 3CX rejects null - and report time-of-day filters such as callTimeFilterFrom take '0:00:0' for none), OData options in query, and the JSON body in body (for actions, the action's parameters may be given in params instead). GET operations only read; POST/PATCH/PUT/DELETE CHANGE THE PBX - confirm with the user first. Collections default to $top=100.", inputSchema: { type: "object", properties: { ...CLIENT, operation: { type: "string", description: "operationId, e.g. ListUser, GetUser, UpdateUser, GetCallLogData, MakeCall" }, params: { type: "object", description: "Path/key/function parameters by name, e.g. {\"Id\": 12} or {\"periodFrom\": \"2026-10-01T00:00:00Z\", ...}", additionalProperties: true }, query: { type: "object", description: "OData options, e.g. {\"$filter\": \"Number eq '100'\", \"$select\": \"Id,Number\", \"$expand\": \"Groups\", \"$top\": 20}", additionalProperties: true }, body: { description: "JSON request body for POST/PATCH/PUT (PATCH sends only the fields given)" } }, required: ["operation"] } },
  { name: "tcx_api_get", description: "Read-only escape hatch: GET any raw XAPI path on a client's PBX, relative to /xapi/v1 - e.g. '/Users', \"/Users(12)/ForwardingProfiles\", '/SystemStatus/Pbx.SystemHealthStatus()'. OData options go in query. Response truncated at 60K chars.", inputSchema: { type: "object", properties: { ...CLIENT, path: { type: "string", description: "Path starting with '/', relative to /xapi/v1 (no '?' - use query)" }, query: { type: "object", description: "Query options, e.g. {\"$filter\": \"...\", \"$top\": 50}", additionalProperties: true } }, required: ["path"] } },
  { name: "tcx_api_request", description: "Write escape hatch: POST/PATCH/PUT/DELETE any raw XAPI path on a client's PBX (relative to /xapi/v1). CHANGES THE PBX - confirm with the user first. Prefer tcx_call, which builds the URL and body shape from the spec.", inputSchema: { type: "object", properties: { ...CLIENT, method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] }, path: { type: "string" }, query: { type: "object", additionalProperties: true }, body: { description: "JSON body" } }, required: ["method", "path"] } },

  { name: "get_system_status", description: "A client's PBX status: version, FQDN, licence/activation, extensions and calls in use, trunk/disk/memory figures.", inputSchema: { type: "object", properties: { ...CLIENT } } },
  { name: "list_users", description: "List a client's users/extensions (Id, Number, name, email, mobile, enabled, registered, current status profile by default).", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA, search: { type: "string", description: "Free-text $search" } } } },
  { name: "get_user", description: "Full record of one user/extension, by extension number or Id, with its groups and forwarding profiles. Passwords and PINs are redacted.", inputSchema: { type: "object", properties: { ...CLIENT, number: { type: "string", description: "Extension number, e.g. 100" }, id: { type: "number", description: "User Id (instead of number)" } } } },
  { name: "list_queues", description: "List a client's call queues with their agents.", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA } } },
  { name: "list_ring_groups", description: "List a client's ring groups with their members.", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA } } },
  { name: "list_receptionists", description: "List a client's digital receptionists (IVRs).", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA } } },
  { name: "list_groups", description: "List a client's groups/departments.", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA } } },
  { name: "list_trunks", description: "List a client's SIP trunks (provider, numbers, direction, registration).", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA } } },
  { name: "list_active_calls", description: "Calls in progress right now on a client's PBX.", inputSchema: { type: "object", properties: { ...CLIENT } } },
  { name: "get_call_log", description: "A client's call log report (the admin console's Call Log: source, destination, direction, status, answered, durations) for a date range, newest first.", inputSchema: { type: "object", properties: { ...CLIENT, ...RANGE, calls_type: { type: "number", description: "0 all (default), 1 answered, 2 unanswered" }, filter: ODATA.filter, top: ODATA.top, skip: ODATA.skip }, required: ["from", "to"] } },
  { name: "list_event_logs", description: "A client's PBX event log (errors, warnings, info), newest first.", inputSchema: { type: "object", properties: { ...CLIENT, ...ODATA } } },
];

function listQuery(args: Record<string, unknown>, defaults: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...defaults,
    ...(args.filter ? { $filter: args.filter } : {}),
    ...(args.select ? { $select: args.select } : {}),
    ...(args.orderby ? { $orderby: args.orderby } : {}),
    ...(args.search ? { $search: args.search } : {}),
    $top: args.top ?? defaults.$top ?? 100,
    ...(args.skip ? { $skip: args.skip } : {}),
  };
}


async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "list_clients": {
      const clients = await loadClients(env, !!args.refresh);
      const rows = clients.map((c) => ({ key: c.key, name: c.name, company: c.company, url: c.url, client_id: c.clientId || null, ready: !c.problem, ...(c.problem ? { problem: c.problem } : {}), hudu: c.huduUrl }));
      if (args.check) {
        await Promise.all(rows.map(async (r, i) => {
          const c = clients[i];
          if (c.problem) return;
          try {
            const s = (await tcx(env, c, "GET", "/SystemStatus", { $select: "Version,FQDN,Activated,ExtensionsRegistered,ExtensionsTotal,CallsActive,TrunksRegistered,TrunksTotal" })) as Record<string, unknown>;
            Object.assign(r, { connected: true, version: s.Version, fqdn: s.FQDN, activated: s.Activated, extensions: `${s.ExtensionsRegistered}/${s.ExtensionsTotal} registered`, trunks: `${s.TrunksRegistered}/${s.TrunksTotal} registered`, active_calls: s.CallsActive });
          } catch (e) {
            Object.assign(r, { connected: false, error: (e as Error).message.slice(0, 300) });
          }
        }));
      }
      return out({ catalog_version: CATALOG.version, count: rows.length, clients: rows });
    }

    case "tcx_find_endpoints": {
      const method = args.method ? String(args.method).toUpperCase() : undefined;
      const area = args.area ? String(args.area).toLowerCase() : undefined;
      const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      let ops = CATALOG.ops.filter((o) => (!method || o.m === method) && (!area || o.tag.toLowerCase() === area));
      if (!words.length && !area) {
        const counts: Record<string, number> = {};
        for (const o of ops) counts[o.tag] = (counts[o.tag] ?? 0) + 1;
        return out({ catalog_version: CATALOG.version, operations: ops.length, areas: Object.entries(counts).sort().map(([t, n]) => `${t} (${n})`).join(", "), hint: "Search with query (e.g. 'queue agents') or area (e.g. 'Users')." });
      }
      // Match against the operation id split into words too ("GetCallLogData" -> "get call log data").
      ops = ops.filter((o) => {
        const hay = `${o.id} ${o.id.replace(/([a-z])([A-Z])/g, "$1 $2")} ${o.m} ${o.p} ${o.tag} ${o.s}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const limit = Number(args.limit ?? 40);
      return out({ matches: ops.length, shown: Math.min(limit, ops.length), operations: ops.slice(0, limit).map(opLine) });
    }

    case "tcx_describe_endpoint": {
      const op = findOp(String(args.operation ?? ""));
      const params = (op.pp ?? []).map(([n, t, nullable]) => ({ name: n, type: t, required: !nullable, ...(CATALOG.enums[t] ? { values: CATALOG.enums[t] } : {}) }));
      const body = typeof op.b === "string" ? { schema: op.b, fields: schemaProps(op.b) ?? undefined } : op.b;
      const exParams = Object.fromEntries((op.pp ?? []).filter((p) => !p[2]).map(([n, t]) => [n, t === "date-time" ? "2026-10-01T00:00:00Z" : t === "int" ? 0 : t === "bool" ? false : CATALOG.enums[t]?.[0] ?? ""]));
      return out({
        operation: op.id, method: op.m, path: op.p, area: op.tag, summary: op.s, kind: op.k ?? "entity",
        writes: op.m !== "GET",
        parameters: params,
        query_options: op.q ? [...op.q].map((c) => QUERY_NAMES[c]) : [],
        ...(op.xq ? { other_query: op.xq } : {}),
        ...(body ? { body } : {}),
        result: op.r,
        example: { tool: "tcx_call", arguments: { client: "<key>", operation: op.id, ...(op.pp?.length ? { params: exParams } : {}), ...(op.q?.includes("t") ? { query: { $top: 20 } } : {}) } },
      });
    }

    case "tcx_describe_schema": {
      const raw = String(args.name ?? "");
      const full = schemaName(raw);
      if (CATALOG.enums[full]) return out({ enum: full, values: CATALOG.enums[full] });
      const props = schemaProps(raw);
      if (!props) {
        const r = raw.toLowerCase().replace(/^pbx\./, "");
        const near = [...Object.keys(CATALOG.schemas), ...Object.keys(CATALOG.enums)].filter((n) => n.toLowerCase().includes(r)).slice(0, 20);
        throw new Error(`No schema "${raw}".${near.length ? ` Close matches: ${near.join(", ")}` : ""}`);
      }
      const enumsUsed: Record<string, string[]> = {};
      for (const t of Object.values(props)) { const b = t.replace(/\[\]$/, ""); if (CATALOG.enums[b]) enumsUsed[b] = CATALOG.enums[b]; }
      return out({ schema: full, properties: props, enums: enumsUsed });
    }

    case "tcx_call": {
      const op = findOp(String(args.operation ?? ""));
      const c = await resolveClient(env, args.client);
      const params = (args.params ?? {}) as Record<string, unknown>;
      const aliases: Record<string, string> = {};
      const path = buildOpPath(op, params, aliases);
      const query = { ...normalizeQuery(args.query), ...aliases };
      if (op.m === "GET" && op.q?.includes("t") && query.$top === undefined) query.$top = 100;
      let body = args.body;
      if (body === undefined && op.b && typeof op.b === "object") {
        const fromParams = Object.fromEntries(Object.keys(op.b).filter((k) => params[k] !== undefined).map((k) => [k, params[k]]));
        if (Object.keys(fromParams).length) body = fromParams;
      }
      if (body === undefined && ["POST", "PUT", "PATCH"].includes(op.m) && op.b) body = {};
      return out(await tcx(env, c, op.m, path, query, body));
    }

    case "tcx_api_get": {
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("?")) throw new Error("path must start with '/' and contain no '?' (put options in query)");
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", path, normalizeQuery(args.query)));
    }

    case "tcx_api_request": {
      const method = String(args.method ?? "").toUpperCase();
      if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) throw new Error("method must be POST, PATCH, PUT or DELETE (use tcx_api_get to read)");
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("?")) throw new Error("path must start with '/' and contain no '?' (put options in query)");
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, method, path, normalizeQuery(args.query), args.body));
    }

    case "get_system_status": {
      const c = await resolveClient(env, args.client);
      return out({ client: c.key, ...((await tcx(env, c, "GET", "/SystemStatus")) as object) });
    }

    case "list_users": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/Users", listQuery(args, { $select: "Id,Number,FirstName,LastName,EmailAddress,Mobile,Enabled,IsRegistered,CurrentProfileName", $orderby: "Number" })));
    }

    case "get_user": {
      const c = await resolveClient(env, args.client);
      const expand = "Groups,ForwardingProfiles";
      if (args.id !== undefined) return out(await tcx(env, c, "GET", `/Users(${Number(args.id)})`, { $expand: expand }));
      if (!args.number) throw new Error("give number or id");
      const res = (await tcx(env, c, "GET", "/Users", { $filter: `Number eq '${String(args.number).replace(/'/g, "''")}'`, $expand: expand })) as { value?: unknown[] };
      if (!res.value?.length) throw new Error(`No user with extension ${args.number} on ${c.key}`);
      return out(res.value[0]);
    }

    case "list_queues": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/Queues", listQuery(args, { $expand: "Agents", $orderby: "Number" })));
    }
    case "list_ring_groups": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/RingGroups", listQuery(args, { $expand: "Members", $orderby: "Number" })));
    }
    case "list_receptionists": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/Receptionists", listQuery(args, { $orderby: "Number" })));
    }
    case "list_groups": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/Groups", listQuery(args, { $orderby: "Name" })));
    }
    case "list_trunks": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/Trunks", listQuery(args, { $orderby: "Number" })));
    }
    case "list_active_calls": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/ActiveCalls"));
    }

    case "get_call_log": {
      const c = await resolveClient(env, args.client);
      const op = OPS_BY_ID.get("getcalllogdata")!;
      const aliases: Record<string, string> = {};
      const path = buildOpPath(op, {
        periodFrom: args.from, periodTo: args.to,
        sourceType: 0, sourceFilter: "", destinationType: 0, destinationFilter: "",
        // The admin console's own defaults; null/'' for the time filters is
        // rejected or returns nothing (live, 2026-10-05).
        callsType: args.calls_type ?? 0, callTimeFilterType: 0, callTimeFilterFrom: "0:00:0", callTimeFilterTo: "0:00:0",
        hidePcalls: true,
      }, aliases);
      const q: Record<string, unknown> = { $top: args.top ?? 100, $orderby: "StartTime desc", ...aliases };
      if (args.filter) q.$filter = args.filter;
      if (args.skip) q.$skip = args.skip;
      return out(await tcx(env, c, "GET", path, q));
    }

    case "list_event_logs": {
      const c = await resolveClient(env, args.client);
      return out(await tcx(env, c, "GET", "/EventLogs", listQuery(args, { $orderby: "TimeGenerated desc" })));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- HTTP ----------

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
    // /health is open (GET/HEAD) and says nothing about clients. Everything
    // else needs "Authorization: Bearer <MCP_AUTH_TOKEN>", and unlike most
    // Workers here this one FAILS CLOSED (like hudu-mcp): with the secret
    // unset nothing but /health answers, because the tools can change every
    // client's phone system.
    const isHealth = (request.method === "GET" || request.method === "HEAD") && url.pathname === "/health";
    if (isHealth) {
      return new Response(JSON.stringify({ status: "ok", catalog_version: CATALOG.version, operations: CATALOG.ops.length, configured: !!(env.MCP_AUTH_TOKEN && env.HUDU_API_KEY) }), { headers: JSON_HEADERS });
    }
    if (!env.MCP_AUTH_TOKEN || !env.HUDU_API_KEY) {
      return new Response(JSON.stringify({ error: "threecx-mcp is not configured: set the MCP_AUTH_TOKEN and HUDU_API_KEY secrets." }), { status: 503, headers: JSON_HEADERS });
    }
    const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "3CX MCP Server", version: "3.0.0" } } });
          else if (method === "tools/list") responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          else if (method === "tools/call") { const text = await runTool(params?.name as string, (params?.arguments ?? {}) as Record<string, unknown>, env); responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }); }
          else if (method === "ping") responses.push({ jsonrpc: "2.0", id, result: {} });
          else responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        } catch (err) { responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }); }
      }
      const outBody = responses.length === 0 ? null : responses.length === 1 ? responses[0] : responses;
      if (outBody === null) return new Response(null, { status: 204, headers: CORS });
      return new Response(JSON.stringify(outBody), { headers: JSON_HEADERS });
    }
    return new Response("3CX MCP Server v3 - POST /mcp", { status: 200, headers: CORS });
  },
};
