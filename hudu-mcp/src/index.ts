/**
 * hudu-mcp - Hudu documentation over Hudu's REST API, authenticated with an
 * API key instead of Hudu's own OAuth-only MCP endpoint.
 *
 * Why this exists (2026-09-24): the HelpDeskAgent server's "HUDU" MCP
 * registration pointed at Hudu's hosted MCP (/mcp), which accepts only an
 * OAuth access token; the sign-in expired and resolver runs reported Hudu
 * "unauthenticated". An API key works for the REST API but not for that
 * endpoint, so this Worker serves the same tools over REST.
 *
 * Drop-in: tool names and arguments match Hudu's hosted MCP server, so the
 * resolver allowlist (mcp__HUDU__*) and resolver-prompt.md need no change -
 * register this Worker under the same name, HUDU.
 *
 * Differences from the hosted server, stated in each tool's description:
 * - article_semantic_search_tool is keyword-ranked (REST has no semantic
 *   index): full-phrase search plus per-word searches, ranked by hits.
 * - Paging: Hudu's REST API returns no totals, so `pagination` reports
 *   page, per_page, returned and has_more instead of total_pages.
 * - activity_logs_show_tool is not available over REST.
 *
 * Secrets are never returned: password-type asset fields are nulled, any
 * `password`/`otp_secret`-style key is redacted, and hudu_api_get refuses
 * the password endpoints outright. asset_edit_tool refuses assets whose
 * layout has a password field, since a REST update could clear it.
 *
 * SECRETS (wrangler secret put): HUDU_API_KEY, MCP_AUTH_TOKEN.
 * VARS (wrangler.jsonc): HUDU_BASE_URL.
 * Unlike the other Workers, /mcp refuses every request until MCP_AUTH_TOKEN
 * is set: Hudu holds client network and credential documentation.
 */

export interface Env {
  HUDU_API_KEY: string;
  HUDU_BASE_URL: string;
  MCP_AUTH_TOKEN?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
const MAX_TEXT = 60000;

type Args = Record<string, unknown>;

// ─── REST client ──────────────────────────────────────────────────────────────

function base(env: Env): string {
  return (env.HUDU_BASE_URL || "").replace(/\/+$/, "");
}

async function hudu(env: Env, method: string, path: string, params?: Record<string, unknown>, body?: unknown): Promise<any> {
  const url = new URL(`${base(env)}/api/v1${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const init: RequestInit = {
    method,
    headers: { "x-api-key": env.HUDU_API_KEY, Accept: "application/json", "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  // GETs retry on rate limiting and gateway errors; writes never retry.
  const attempts = method === "GET" ? 3 : 1;
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url.toString(), init);
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    lastErr = `${method} ${path} failed (${res.status}): ${(await res.text()).slice(0, 500)}`;
    if (![429, 500, 502, 503, 504].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error(lastErr);
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function perPage(args: Args, def = 25, max = 100): number {
  return Math.min(Math.max(num(args.per_page) ?? def, 1), max);
}

function pageOf(args: Args): number {
  return Math.max(num(args.page) ?? 1, 1);
}

function paged(rows: unknown[], page: number, per: number, extra?: Record<string, unknown>) {
  return { data: rows, pagination: { page, per_page: per, returned: rows.length, has_more: rows.length >= per, ...(extra || {}) } };
}

function out(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n... [truncated]" : text;
}

function fullUrl(env: Env, u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  return u.startsWith("http") ? u : `${base(env)}${u.startsWith("/") ? "" : "/"}${u}`;
}

function pick(obj: any, keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (obj && k in obj) o[k] = obj[k];
  return o;
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

// ─── Secret handling ──────────────────────────────────────────────────────────

let layoutCache: { at: number; layouts: any[] } | null = null;
let listItemCache: { at: number; names: Map<number, string> } | null = null;

// ListSelect values come back as '{"list_ids":[156]}'; output shows names.
async function listItemNames(env: Env): Promise<Map<number, string>> {
  if (listItemCache && Date.now() - listItemCache.at < 10 * 60 * 1000) return listItemCache.names;
  const names = new Map<number, string>();
  for (let page = 1; page <= 10; page++) {
    const d = await hudu(env, "GET", "/lists", { page, page_size: 100 });
    const rows: any[] = Array.isArray(d) ? d : d.lists || [];
    for (const l of rows) for (const i of l.list_items || []) names.set(Number(i.id), String(i.name));
    if (rows.length < 100) break;
  }
  listItemCache = { at: Date.now(), names };
  return names;
}

function listValue(v: unknown, names: Map<number, string>): unknown {
  if (typeof v !== "string" || !v.startsWith('{"list_ids"')) return v;
  try { const ids: number[] = JSON.parse(v).list_ids || []; return ids.map((id) => names.get(Number(id)) ?? `list item ${id}`); } catch { return v; }
}

async function layouts(env: Env): Promise<any[]> {
  if (layoutCache && Date.now() - layoutCache.at < 10 * 60 * 1000) return layoutCache.layouts;
  const all: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const d = await hudu(env, "GET", "/asset_layouts", { page, page_size: 100 });
    const rows = d.asset_layouts || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  layoutCache = { at: Date.now(), layouts: all };
  return all;
}

const SECRET_FIELD_TYPES = new Set(["Password", "ConfidentialText"]);

async function secretLabels(env: Env): Promise<Map<number, Set<string>>> {
  const m = new Map<number, Set<string>>();
  for (const l of await layouts(env)) {
    for (const f of l.fields || []) {
      if (SECRET_FIELD_TYPES.has(f.field_type)) {
        if (!m.has(l.id)) m.set(l.id, new Set());
        m.get(l.id)!.add(String(f.label).toLowerCase());
      }
    }
  }
  return m;
}

const SECRET_KEY = /^(password|passwd|password_confirmation|otp_secret|otp|totp|totp_secret|secret|api_key|private_key)$/i;

// Secrets typed into free text (article bodies, RichText fields) - found in
// testing: an article carrying a site-to-site VPN "Shared Secret: ..." in
// plain text. Hudu's own MCP returns such text as-is; this server replaces
// the value after a secret-looking label, in plain text and HTML alike.
// Diagnostics never need the secret itself, and a resolver that never sees
// it can never paste it into a ticket.
const SECRET_LABEL = "(?:password|passwd|pwd|pass ?phrase|passcode|pin|pre-?shared[ -]?key|psk|shared[ -]?secret|secret|api[ -]?key|access[ -]?key|secret[ -]?key|private[ -]?key|wpa2?[ -]?key|wifi[ -]?key|network[ -]?key|token|otp|totp)";
const SECRET_TEXT = new RegExp("(\\b" + SECRET_LABEL + "\\s*(?:<[^>]*>\\s*)*[:=]\\s*(?:<[^>]*>\\s*)*)([^\\s<]{3,})", "gi");

function redactText(text: string): string {
  return text.replace(SECRET_TEXT, (_m, label: string) => `${label}[redacted]`);
}

// Walks any Hudu response: nulls password-type asset field values (by the
// asset's layout) and redacts secret-named keys wherever they appear.
function redact(value: any, secrets: Map<number, Set<string>>, names: Map<number, string> = new Map()): any {
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, names));
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  const outObj: Record<string, unknown> = {};
  const layoutId = typeof value.asset_layout_id === "number" ? value.asset_layout_id : undefined;
  const secretSet = layoutId !== undefined ? secrets.get(layoutId) : undefined;
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k) && v !== null && typeof v !== "boolean") { outObj[k] = "[redacted]"; continue; }
    if (k === "fields" && Array.isArray(v) && layoutId !== undefined) {
      outObj[k] = v.map((f: any) => {
        if (f && secretSet && secretSet.has(String(f.label).toLowerCase())) return { ...redact(f, secrets, names), value: null, redacted: true };
        const r = redact(f, secrets, names);
        if (r && typeof r === "object" && "value" in r) r.value = listValue(f.value, names);
        return r;
      });
      continue;
    }
    if (k === "passwords" && Array.isArray(v)) { outObj[k] = `[${v.length} password record(s) - not exposed]`; continue; }
    outObj[k] = redact(v, secrets, names);
  }
  return outObj;
}

async function safe(env: Env, value: unknown): Promise<unknown> {
  return redact(value, await secretLabels(env), await listItemNames(env));
}

// ─── Field keys ───────────────────────────────────────────────────────────────

// Hudu's REST custom_fields keys are the field label lowercased with spaces
// replaced by underscores ("IP Address" -> "ip_address").
function fieldKey(labelOrKey: string): string {
  return labelOrKey.trim().toLowerCase().replace(/\s+/g, "_");
}

async function layoutById(env: Env, id: number): Promise<any> {
  const d = await hudu(env, "GET", `/asset_layouts/${id}`);
  return d.asset_layout || d;
}

async function customFieldsPayload(env: Env, layoutId: number, custom: unknown): Promise<Record<string, unknown>[] | undefined> {
  if (!custom || typeof custom !== "object") return undefined;
  const layout = await layoutById(env, layoutId);
  const byKey = new Map<string, any>();
  for (const f of layout.fields || []) byKey.set(fieldKey(String(f.label)), f);
  const obj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(custom as Record<string, unknown>)) {
    const key = fieldKey(k);
    const f = byKey.get(key);
    if (f && SECRET_FIELD_TYPES.has(f.field_type)) throw new Error(`Field "${f.label}" is a password field and cannot be set here.`);
    if (!f) throw new Error(`Layout ${layoutId} ("${layout.name}") has no field "${k}". Fields: ${[...byKey.values()].filter((x) => x.field_type !== "Heading").map((x) => x.label).join(", ")}`);
    obj[key] = v;
  }
  return [obj];
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const PAGE_PROPS = {
  page: { type: "integer", description: "Page number (default 1). Hudu's REST API returns no totals; check pagination.has_more." },
  per_page: { type: "integer", description: "Results per page (default 25, max 100)." },
};

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to the Hudu REST API and verify the API key.", inputSchema: { type: "object", properties: {} } },
  { name: "company_index_tool", description: "List and search Hudu Companies. Paginated (default 25). Use q to find a company by name. Rows are trimmed to id, slug, name, hudu_url; pass include (address, contact, meta, notes) for more.", inputSchema: { type: "object", properties: { q: { type: "string", description: "Search by name/nickname." }, include: { type: "array", items: { type: "string", enum: ["address", "contact", "meta", "notes"] } }, ...PAGE_PROPS } } },
  { name: "company_show_tool", description: "Retrieve a single Hudu Company by ID.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "article_index_tool", description: "List and browse Hudu Knowledge Base Articles by keyword, folder, or company. Paginated (default 25). q searches article names and content. folder_id / global / no_folder are applied to the returned page, so combine them with company_id or q. Rows are trimmed to id, slug, name, company_id, hudu_url; include adds folder, sharing, meta.", inputSchema: { type: "object", properties: { q: { type: "string" }, company_id: { type: "integer" }, folder_id: { type: "integer" }, global: { type: "string", description: "\"true\" for company-less articles only" }, no_folder: { type: "string", description: "\"true\" for articles without a folder only" }, include: { type: "array", items: { type: "string", enum: ["folder", "sharing", "upload", "meta"] } }, ...PAGE_PROPS } } },
  { name: "article_show_tool", description: "Retrieve a single Hudu Knowledge Base Article by ID, with its HTML content.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "article_semantic_search_tool", description: "Search Hudu Knowledge Base Articles over their full content. Keyword-ranked over Hudu's REST search (no semantic index is available with an API key): the whole phrase plus each significant word are searched and results ranked by how many matched. Returns id, name, company_id, a snippet and hudu_url; call article_show_tool for the full article.", inputSchema: { type: "object", properties: { q: { type: "string" }, company_id: { type: "integer" }, limit: { type: "integer", description: "Max articles (default 6, max 20)." } }, required: ["q"] } },
  { name: "article_folder_index_tool", description: "List Hudu Knowledge Base Article Folders. Narrow with company_id or global.", inputSchema: { type: "object", properties: { company_id: { type: "integer" }, global: { type: "boolean" } } } },
  { name: "article_folder_show_tool", description: "Retrieve a single Hudu Knowledge Base Article Folder by ID.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "article_create_tool", description: "Create a Hudu Knowledge Base Article. content must be clean HTML, not Markdown.", inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, company_id: { type: "integer" }, folder_id: { type: "integer" }, draft: { type: "boolean" } }, required: ["name"] } },
  { name: "article_edit_tool", description: "Edit an existing Hudu Knowledge Base Article. Only the arguments passed are changed. content must be clean HTML.", inputSchema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, content: { type: "string" }, draft: { type: "boolean" } }, required: ["id"] } },
  { name: "asset_index_tool", description: "List and search Hudu Assets. Paginated (default 25). Filter with asset_layout_id, company_id, company_q (company name search), q (asset name) or primary_serial. include adds fields, cards, meta; password records are never returned.", inputSchema: { type: "object", properties: { asset_layout_id: { type: "integer" }, company_id: { type: "integer" }, company_q: { type: "string" }, q: { type: "string" }, primary_serial: { type: "string" }, include: { type: "array", items: { type: "string", enum: ["meta", "fields", "cards", "related", "passwords", "runs", "files", "photos", "comments"] } }, include_fields: { type: "boolean" }, ...PAGE_PROPS } } },
  { name: "asset_show_tool", description: "Retrieve a single Hudu Asset by ID with all field values. Password fields are present with value null.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "asset_create_tool", description: "Create a Hudu Asset. Find the layout with asset_layout_index_tool, read its fields with asset_layout_show_tool, then pass custom_fields keyed by field label or key, e.g. {\"Hostname\": \"srv-01\"}. Password fields cannot be set. Verify with asset_show_tool.", inputSchema: { type: "object", properties: { name: { type: "string" }, company_id: { type: "integer" }, asset_layout_id: { type: "integer" }, custom_fields: { type: "object" }, primary_serial: { type: "string" }, primary_mail: { type: "string" }, primary_model: { type: "string" }, primary_manufacturer: { type: "string" }, primary_mac: { type: "array", items: { type: "string" } } }, required: ["name", "company_id", "asset_layout_id"] } },
  { name: "asset_edit_tool", description: "Edit an existing Hudu Asset. custom_fields keyed by field label or key; only the fields passed change. Refused for assets whose layout has a password field - edit those in Hudu. Verify with asset_show_tool.", inputSchema: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, custom_fields: { type: "object" }, primary_serial: { type: "string" }, primary_mail: { type: "string" }, primary_model: { type: "string" }, primary_manufacturer: { type: "string" }, primary_mac: { type: "array", items: { type: "string" } } }, required: ["id"] } },
  { name: "asset_layout_index_tool", description: "List Hudu Asset Layouts (id, name, active). q filters by name (case-insensitive substring).", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "asset_layout_show_tool", description: "Field schema for one Hudu Asset Layout: each field's key, label, field_type, required, options, and for ListSelect fields the list_items names (first 200). Password and Heading fields are omitted.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "process_index_tool", description: "List Hudu Processes (templates, not runs). Paginated. Filter with company_id, asset_id, q (name).", inputSchema: { type: "object", properties: { company_id: { type: ["integer", "null"] }, asset_id: { type: ["integer", "null"] }, q: { type: ["string", "null"] }, page: { type: ["integer", "null"] }, per_page: { type: ["integer", "null"] } } } },
  { name: "process_show_tool", description: "Retrieve a single Hudu Process by ID, including its tasks.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "run_index_tool", description: "List Hudu Process Runs. Paginated. Filter with company_id, asset_id, parent_process_id, q (name).", inputSchema: { type: "object", properties: { company_id: { type: ["integer", "null"] }, asset_id: { type: ["integer", "null"] }, parent_process_id: { type: ["integer", "null"] }, q: { type: ["string", "null"] }, page: { type: ["integer", "null"] }, per_page: { type: ["integer", "null"] } } } },
  { name: "run_show_tool", description: "Retrieve a single Hudu Process Run by ID, including its tasks.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "label_index_tool", description: "List Hudu label assignments: by labelable_type + labelable_id, or by label_type_id.", inputSchema: { type: "object", properties: { label_type_id: { type: "integer" }, labelable_type: { type: "string" }, labelable_id: { type: ["string", "integer"] }, ...PAGE_PROPS } } },
  { name: "label_type_index_tool", description: "List Hudu Label Types. Filter with q, record_type, company_id.", inputSchema: { type: "object", properties: { q: { type: "string" }, record_type: { type: "string" }, company_id: { type: "integer" }, ...PAGE_PROPS } } },
  { name: "activity_logs_index_tool", description: "List Hudu activity logs, newest first. Filter with record_type + record_id, user_id, actions; company_name, ip_address and query filter the returned page.", inputSchema: { type: "object", properties: { record_type: { type: "string" }, record_id: { type: "integer" }, user_id: { type: "string" }, actions: { type: "string" }, company_name: { type: "string" }, ip_address: { type: "string" }, query: { type: "string" }, page: { type: "integer" }, per_page: { type: "integer" } } } },
  { name: "activity_logs_show_tool", description: "Not available over Hudu's REST API - use activity_logs_index_tool with record_type/record_id.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "public_photo_show_tool", description: "Returns the URL of a Hudu public photo referenced as /public_photo/<slug> in article or asset content.", inputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
  { name: "hudu_api_get", description: "Read-only escape hatch: GET any Hudu REST API v1 path for data no tool above covers - e.g. '/networks', '/ip_addresses', '/vlans', '/vlan_zones', '/websites', '/magic_dash', '/relations', '/expirations', '/rack_storages', '/lists/{id}', '/companies/{id}/assets'. Path is relative to /api/v1. Password endpoints are refused and secret values are redacted. Response truncated at 60K chars.", inputSchema: { type: "object", properties: { path: { type: "string" }, params: { type: "object", additionalProperties: true } }, required: ["path"] } },
];

// ─── Tool implementations ─────────────────────────────────────────────────────

function trimCompany(env: Env, c: any, include: string[]) {
  const row: Record<string, unknown> = { id: c.id, slug: c.slug, name: c.name, hudu_url: c.full_url || fullUrl(env, c.url) };
  if (include.includes("address")) Object.assign(row, pick(c, ["address_line_1", "address_line_2", "city", "state", "zip", "country_name"]));
  if (include.includes("contact")) Object.assign(row, pick(c, ["phone_number", "fax_number", "website"]));
  if (include.includes("meta")) Object.assign(row, pick(c, ["nickname", "company_type", "id_number"]));
  if (include.includes("notes")) Object.assign(row, pick(c, ["notes"]));
  return row;
}

function trimArticle(env: Env, a: any, include: string[]) {
  const row: Record<string, unknown> = { id: a.id, slug: a.slug, name: a.name, company_id: a.company_id ?? null, hudu_url: fullUrl(env, a.url) };
  if (include.includes("folder")) row.folder_id = a.folder_id ?? null;
  if (include.includes("sharing")) Object.assign(row, { public_url: a.share_url ?? null, enable_sharing: a.enable_sharing ?? false });
  if (include.includes("meta")) Object.assign(row, pick(a, ["draft", "created_at", "updated_at"]));
  return row;
}

function trimAsset(env: Env, a: any, include: string[]) {
  const row: Record<string, unknown> = { id: a.id, slug: a.slug, name: a.name, company_id: a.company_id, company_name: a.company_name, asset_layout_id: a.asset_layout_id, asset_type: a.asset_type, hudu_url: fullUrl(env, a.url) };
  if (include.includes("fields")) Object.assign(row, pick(a, ["primary_serial", "primary_mail", "primary_model", "primary_manufacturer", "fields"]));
  if (include.includes("cards")) row.cards = a.cards;
  if (include.includes("meta")) Object.assign(row, pick(a, ["created_at", "updated_at", "archived"]));
  if (include.includes("passwords")) row.passwords = "not exposed by this server";
  return row;
}

async function assetById(env: Env, id: number): Promise<any> {
  const d = await hudu(env, "GET", "/assets", { id });
  const a = (d.assets || []).find((x: any) => Number(x.id) === id);
  if (!a) throw new Error(`Asset ${id} not found.`);
  return a;
}

async function procedures(env: Env, args: Args, runs: boolean) {
  const page = pageOf(args), per = perPage(args);
  const params: Record<string, unknown> = { company_id: num(args.company_id), page, page_size: per };
  const d = await hudu(env, "GET", "/procedures", params);
  let rows: any[] = d.procedures || [];
  rows = rows.filter((p) => Boolean(p.run) === runs);
  if (num(args.asset_id) !== undefined) rows = rows.filter((p) => p.asset && Number(p.asset.id ?? p.asset) === num(args.asset_id));
  if (runs && num(args.parent_process_id) !== undefined) rows = rows.filter((p) => Number(p.parent_process_id) === num(args.parent_process_id));
  if (typeof args.q === "string" && args.q) { const q = args.q.toLowerCase(); rows = rows.filter((p) => String(p.name).toLowerCase().includes(q)); }
  const trimmed = rows.map((p) => ({ ...pick(p, ["id", "slug", "name", "description", "company_id", "company_name", "status", "total", "completed", "completion_percentage", "parent_process_id", "updated_at"]), hudu_url: fullUrl(env, p.url) }));
  return paged(trimmed, page, per, { filtered_on_page: true });
}

async function semanticSearch(env: Env, args: Args) {
  const q = String(args.q ?? "").trim();
  if (!q) throw new Error("q is required.");
  const limit = Math.min(Math.max(num(args.limit) ?? 6, 1), 20);
  const companyId = num(args.company_id);
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "have", "what", "when", "where", "which", "about", "into", "does", "how", "can", "not", "are", "was", "our", "your", "their", "there"]);
  const words = [...new Set(q.toLowerCase().split(/[^a-z0-9.\-_]+/).filter((w) => w.length >= 3 && !stop.has(w)))].slice(0, 6);
  const searches = [q, ...words.filter((w) => w !== q.toLowerCase())];
  const hits = new Map<number, { a: any; score: number }>();
  for (let i = 0; i < searches.length; i++) {
    const d = await hudu(env, "GET", "/articles", { search: searches[i], company_id: companyId, page_size: 25 });
    for (const a of d.articles || []) {
      if (a.archived) continue;
      const h = hits.get(a.id) || { a, score: 0 };
      h.score += i === 0 ? 3 : 1;
      if (String(a.name).toLowerCase().includes(searches[i].toLowerCase())) h.score += 1;
      hits.set(a.id, h);
    }
  }
  const ranked = [...hits.values()].sort((x, y) => y.score - x.score).slice(0, limit);
  const terms = [q.toLowerCase(), ...words];
  const data = ranked.map(({ a, score }) => {
    const text = stripHtml(String(a.content ?? ""));
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) { at = lower.indexOf(t); if (at >= 0) break; }
    const start = Math.max(0, at - 120);
    return { id: a.id, name: a.name, company_id: a.company_id ?? null, score, snippet: text.slice(start, start + 320), hudu_url: fullUrl(env, a.url) };
  });
  return { data, note: "keyword-ranked (Hudu REST has no semantic index); searched: " + searches.join(" | ") };
}

const DENY_PATHS = /(^|\/)(asset_passwords|password_folders|passwords|otp)(\/|$)/i;

async function runTool(name: string, args: Args, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": {
      const info = await hudu(env, "GET", "/api_info");
      return `Connected OK to ${base(env)} - Hudu ${info.version ?? "?"}`;
    }
    case "company_index_tool": {
      const page = pageOf(args), per = perPage(args);
      const include = Array.isArray(args.include) ? (args.include as string[]) : [];
      const d = await hudu(env, "GET", "/companies", { search: args.q, page, page_size: per });
      return out(await safe(env, paged((d.companies || []).map((c: any) => trimCompany(env, c, include)), page, per)));
    }
    case "company_show_tool": {
      const d = await hudu(env, "GET", `/companies/${num(args.id)}`);
      return out(await safe(env, d.company || d));
    }
    case "article_index_tool": {
      const page = pageOf(args), per = perPage(args);
      const include = Array.isArray(args.include) ? (args.include as string[]) : [];
      const d = await hudu(env, "GET", "/articles", { search: args.q, company_id: num(args.company_id), page, page_size: per });
      let rows: any[] = d.articles || [];
      const fetched = rows.length;
      if (num(args.folder_id) !== undefined) rows = rows.filter((a) => Number(a.folder_id) === num(args.folder_id));
      if (String(args.global) === "true") rows = rows.filter((a) => a.company_id === null || a.company_id === undefined);
      if (String(args.no_folder) === "true") rows = rows.filter((a) => a.folder_id === null || a.folder_id === undefined);
      return out(await safe(env, { data: rows.map((a) => trimArticle(env, a, include)), pagination: { page, per_page: per, returned: rows.length, has_more: fetched >= per } }));
    }
    case "article_show_tool": {
      const d = await hudu(env, "GET", `/articles/${num(args.id)}`);
      return out(await safe(env, d.article || d));
    }
    case "article_semantic_search_tool":
      return out(await safe(env, await semanticSearch(env, args)));
    case "article_folder_index_tool": {
      const all: any[] = [];
      for (let page = 1; page <= 10; page++) {
        const d = await hudu(env, "GET", "/folders", { company_id: num(args.company_id), page, page_size: 100 });
        const rows = d.folders || [];
        all.push(...rows);
        if (rows.length < 100) break;
      }
      const rows = args.global === true ? all.filter((f) => f.company_id === null || f.company_id === undefined) : all;
      return out({ data: rows.map((f) => pick(f, ["id", "name", "description", "company_id", "parent_folder_id", "folder_type"])) });
    }
    case "article_folder_show_tool": {
      const d = await hudu(env, "GET", `/folders/${num(args.id)}`);
      return out(await safe(env, d.folder || d));
    }
    case "article_create_tool": {
      const article: Record<string, unknown> = { name: args.name };
      for (const k of ["content", "company_id", "folder_id", "draft"]) if (args[k] !== undefined) article[k] = args[k];
      const d = await hudu(env, "POST", "/articles", undefined, { article });
      const a = d.article || d;
      return out({ created: true, ...trimArticle(env, a, ["folder", "meta"]) });
    }
    case "article_edit_tool": {
      const id = num(args.id);
      const article: Record<string, unknown> = {};
      for (const k of ["name", "content", "draft"]) if (args[k] !== undefined) article[k] = args[k];
      if (Object.keys(article).length === 0) throw new Error("Nothing to change: pass name, content or draft.");
      const d = await hudu(env, "PUT", `/articles/${id}`, undefined, { article });
      const a = d.article || d;
      return out({ updated: true, ...trimArticle(env, a, ["folder", "meta"]) });
    }
    case "asset_index_tool": {
      const page = pageOf(args), per = perPage(args);
      let include = Array.isArray(args.include) ? (args.include as string[]) : [];
      if (args.include_fields === true) include = ["meta", "fields", "cards", "passwords"];
      let companyIds: (number | undefined)[] = [num(args.company_id)];
      if (companyIds[0] === undefined && typeof args.company_q === "string" && args.company_q) {
        const c = await hudu(env, "GET", "/companies", { search: args.company_q, page_size: 5 });
        companyIds = (c.companies || []).map((x: any) => Number(x.id));
        if (companyIds.length === 0) return out({ data: [], pagination: { page, per_page: per, returned: 0, has_more: false }, note: `No company matched "${args.company_q}".` });
      }
      const rows: any[] = [];
      for (const cid of companyIds) {
        const d = await hudu(env, "GET", "/assets", { company_id: cid, asset_layout_id: num(args.asset_layout_id), search: args.q, primary_serial: args.primary_serial, page, page_size: per });
        rows.push(...(d.assets || []));
      }
      const trimmed = rows.map((a) => trimAsset(env, a, include));
      return out(await safe(env, paged(trimmed, page, per)));
    }
    case "asset_show_tool": {
      const a = await assetById(env, num(args.id)!);
      return out(await safe(env, a));
    }
    case "asset_create_tool": {
      const layoutId = num(args.asset_layout_id)!, companyId = num(args.company_id)!;
      const asset: Record<string, unknown> = { name: args.name, asset_layout_id: layoutId };
      for (const k of ["primary_serial", "primary_mail", "primary_model", "primary_manufacturer", "primary_mac"]) if (args[k] !== undefined) asset[k] = args[k];
      const cf = await customFieldsPayload(env, layoutId, args.custom_fields);
      if (cf) asset.custom_fields = cf;
      const d = await hudu(env, "POST", `/companies/${companyId}/assets`, undefined, { asset });
      return out(await safe(env, { created: true, asset: d.asset || d }));
    }
    case "asset_edit_tool": {
      const id = num(args.id)!;
      const current = await assetById(env, id);
      const secrets = await secretLabels(env);
      if (secrets.has(Number(current.asset_layout_id))) throw new Error(`Asset ${id} uses a layout with a password field; edit it in Hudu directly so the password is not cleared.`);
      const asset: Record<string, unknown> = { name: args.name ?? current.name, asset_layout_id: current.asset_layout_id };
      for (const k of ["primary_serial", "primary_mail", "primary_model", "primary_manufacturer", "primary_mac"]) if (args[k] !== undefined) asset[k] = args[k];
      // Hudu's update keeps every field that is not sent (tested 2026-09-24),
      // so only the requested fields go out.
      if (args.custom_fields && typeof args.custom_fields === "object") {
        asset.custom_fields = await customFieldsPayload(env, Number(current.asset_layout_id), args.custom_fields);
      }
      const d = await hudu(env, "PUT", `/companies/${current.company_id}/assets/${id}`, undefined, { asset });
      return out(await safe(env, { updated: true, asset: d.asset || d }));
    }
    case "asset_layout_index_tool": {
      const q = typeof args.q === "string" ? args.q.toLowerCase() : "";
      const rows = (await layouts(env)).filter((l) => !q || String(l.name).toLowerCase().includes(q));
      return out({ data: rows.map((l) => ({ id: l.id, name: l.name, active: l.active, field_count: (l.fields || []).length })) });
    }
    case "asset_layout_show_tool": {
      const l = await layoutById(env, num(args.id)!);
      const fields: unknown[] = [];
      for (const f of l.fields || []) {
        if (SECRET_FIELD_TYPES.has(f.field_type) || f.field_type === "Heading" || f.is_destroyed) continue;
        const row: Record<string, unknown> = { key: fieldKey(String(f.label)), label: f.label, field_type: f.field_type, required: f.required ?? false, hint: f.hint || undefined };
        if (f.options) row.options = String(f.options).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        if (f.field_type === "ListSelect" && f.list_id) {
          try { const list = await hudu(env, "GET", `/lists/${f.list_id}`); row.list_items = (list.list_items || []).slice(0, 200).map((i: any) => i.name); row.multiple = Boolean(f.multiple_options); } catch { row.list_items = "unavailable"; }
        }
        fields.push(row);
      }
      return out({ id: l.id, name: l.name, active: l.active, fields });
    }
    case "process_index_tool":
      return out(await safe(env, await procedures(env, args, false)));
    case "run_index_tool":
      return out(await safe(env, await procedures(env, args, true)));
    case "process_show_tool":
    case "run_show_tool": {
      const d = await hudu(env, "GET", `/procedures/${num(args.id)}`);
      return out(await safe(env, d.procedure || d));
    }
    case "label_index_tool": {
      const page = pageOf(args), per = perPage(args);
      const d = await hudu(env, "GET", "/labels", { label_type_id: num(args.label_type_id), labelable_type: args.labelable_type, labelable_id: args.labelable_id, page, page_size: per });
      const rows = Array.isArray(d) ? d : d.labels || [];
      return out(await safe(env, paged(rows, page, per)));
    }
    case "label_type_index_tool": {
      const page = pageOf(args), per = perPage(args);
      const d = await hudu(env, "GET", "/label_types", { search: args.q, record_type: args.record_type, company_id: num(args.company_id), page, page_size: per });
      let rows: any[] = Array.isArray(d) ? d : d.label_types || [];
      if (typeof args.q === "string" && args.q) { const q = args.q.toLowerCase(); rows = rows.filter((r) => String(r.name ?? "").toLowerCase().includes(q)); }
      return out(paged(rows, page, per));
    }
    case "activity_logs_index_tool": {
      const page = pageOf(args);
      const per = [25, 50, 100].includes(Number(args.per_page)) ? Number(args.per_page) : 25;
      const d = await hudu(env, "GET", "/activity_logs", { resource_type: args.record_type, resource_id: num(args.record_id), user_id: args.user_id, action_message: args.actions, page, page_size: per });
      let rows: any[] = Array.isArray(d) ? d : d.activity_logs || [];
      if (typeof args.company_name === "string" && args.company_name) { const c = args.company_name.toLowerCase(); rows = rows.filter((r) => String(r.company_name ?? "").toLowerCase().includes(c)); }
      if (typeof args.ip_address === "string" && args.ip_address) rows = rows.filter((r) => r.ip_address === args.ip_address);
      if (typeof args.query === "string" && args.query) { const q = args.query.toLowerCase(); rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)); }
      const trimmed = rows.map((r) => pick(r, ["id", "created_at", "action", "details", "user_name", "user_email", "record_type", "record_id", "record_name", "company_name", "ip_address", "app_type"]));
      return out(await safe(env, paged(trimmed, page, per, { filtered_on_page: true })));
    }
    case "activity_logs_show_tool":
      throw new Error("activity_logs_show_tool is not available over Hudu's REST API - use activity_logs_index_tool with record_type and record_id.");
    case "public_photo_show_tool": {
      const slug = String(args.slug ?? "");
      if (!/^[A-Za-z0-9_-]+$/.test(slug)) throw new Error("slug must be the <slug> from a /public_photo/<slug> reference.");
      return out({ slug, url: `${base(env)}/public_photo/${slug}`, note: "Image bytes are not returned; open the URL in Hudu." });
    }
    case "hudu_api_get": {
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("..") || path.includes("?")) throw new Error("hudu_api_get: path must start with '/', contain no '..' and no '?' (pass query params via params).");
      if (DENY_PATHS.test(path)) throw new Error("hudu_api_get: password endpoints are not exposed.");
      const params = args.params && typeof args.params === "object" ? (args.params as Record<string, unknown>) : undefined;
      return out(await safe(env, await hudu(env, "GET", path, params)));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

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
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", configured: Boolean(env.HUDU_API_KEY && env.MCP_AUTH_TOKEN) }), { headers: JSON_HEADERS });
    // Fail closed: no inbound token configured means no access at all.
    if (!env.MCP_AUTH_TOKEN || !env.HUDU_API_KEY) {
      return new Response(JSON.stringify({ error: "hudu-mcp is not configured: set the HUDU_API_KEY and MCP_AUTH_TOKEN secrets." }), { status: 503, headers: JSON_HEADERS });
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Hudu MCP Server (REST)", version: "1.0.0" } } });
          else if (method === "tools/list") responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          else if (method === "tools/call") { const text = await runTool(params?.name as string, (params?.arguments ?? {}) as Args, env); responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }); }
          else if (method === "ping") responses.push({ jsonrpc: "2.0", id, result: {} });
          else responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        } catch (err) { responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }); }
      }
      const outBody = responses.length === 0 ? null : responses.length === 1 ? responses[0] : responses;
      if (outBody === null) return new Response(null, { status: 204, headers: CORS });
      return new Response(JSON.stringify(outBody), { headers: JSON_HEADERS });
    }
    return new Response("Hudu MCP Server (REST) - POST /mcp, GET /health", { status: 200, headers: CORS });
  },
};
