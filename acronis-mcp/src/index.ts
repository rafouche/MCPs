/**
 * acronis-mcp - Acronis Cyber Protect Cloud over the Acronis Cyber Platform
 * REST API, for Allie (HelpDeskAgent) and Claude. Read-only: nothing here
 * dismisses alerts, runs or edits plans, deletes backups or touches agents.
 *
 * AUTH: one API client created in the Acronis Management Portal (Settings >
 * API clients) at the partner tenant. It inherits the rights of the person who
 * created it and sees that tenant's customers. Token: POST
 * {dc}/api/2/idp/token, Basic auth client_id:client_secret,
 * grant_type=client_credentials; lives 2 hours (`expires_on`), renewed early.
 * Cached per isolate, and in KV when the optional ACRONIS_TOKENS namespace is
 * bound (not bound yet: whether Acronis allows several live tokens per client
 * is not documented, unlike Peplink/3CX which allow only one).
 *
 * SECRETS: ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET, MCP_AUTH_TOKEN.
 * VAR:     ACRONIS_BASE_URL - the datacenter URL shown with the API client,
 *          e.g. https://us5-cloud.acronis.com (no /api).
 * Fails closed like hudu-mcp: 503 until all four are set.
 *
 * APIs used, all under {dc}/api. Scoping checked against Altec's live account
 * on 2026-11-16 (see "Scope" below): a customer's machines, agents and backup
 * tasks belong to UNITS under the customer (e.g. "BackupUser@fncpas.com").
 *   /2/...                             Account Management (clients, tenants, usages)
 *   /alert_manager/v1/alerts           tenant=<customer UUID> includes units; or(), gt(ns) work
 *   /resource_management/v4/resource_statuses  tenant_id=<UUID>, exact tenant: every unit is sent
 *   /policy_management/v4/policies     tenant_id=<customer UUID>
 *   /agent_manager/v2/agents           ignores UUIDs: all agents, filtered by unit name here
 *   /task_manager/v2/tasks|activities  ids UPPERCASE; like()/gt() filters 500 or time out;
 *                                      X-Apigw-Tenant-Id is ignored: tenant/date filtered here
 *   /vault_manager/v1/backups|archives returns nothing to this partner-level client
 * Every list tool takes `full: true` to return Acronis's raw rows.
 */

import catalogJson from "./catalog.json";

interface KVLike {
  get(key: string, type: "json"): Promise<any>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface Env {
  ACRONIS_BASE_URL: string;
  ACRONIS_CLIENT_ID: string;
  ACRONIS_CLIENT_SECRET: string;
  MCP_AUTH_TOKEN?: string;
  ACRONIS_TOKENS?: KVLike;
}

type Args = Record<string, unknown>;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
const MAX_CHARS = 60000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function base(env: Env): string {
  return (env.ACRONIS_BASE_URL || "").trim().replace(/\/+$/, "").replace(/\/api(\/2)?$/, "");
}

// ─── Token ────────────────────────────────────────────────────────────────────

let cachedToken: { token: string; expires: number } | null = null; // expires = ms, already early
let tokenRequest: Promise<string> | null = null;
const TOKEN_KV_KEY = "acronis_token";

async function getToken(env: Env, rejected?: string): Promise<string> {
  if (cachedToken && cachedToken.token !== rejected && cachedToken.expires > Date.now()) return cachedToken.token;
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
    if (env.ACRONIS_TOKENS) {
      const shared = await env.ACRONIS_TOKENS.get(TOKEN_KV_KEY, "json");
      if (shared && shared.token !== rejected && shared.expires > Date.now()) {
        cachedToken = shared;
        return shared.token as string;
      }
    }
    const url = `${base(env)}/api/2/idp/token`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.ACRONIS_CLIENT_ID}:${env.ACRONIS_CLIENT_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Acronis auth failed (${res.status}) at ${url}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text) as { access_token: string; expires_on?: number; expires_in?: number };
    const expMs = data.expires_on ? data.expires_on * 1000 : Date.now() + (data.expires_in ?? 7200) * 1000;
    const lifetime = Math.max(0, expMs - Date.now());
    // Renew 15 minutes early (Acronis guidance), or a quarter of a short lifetime.
    cachedToken = { token: data.access_token, expires: expMs - Math.min(900000, lifetime / 4) };
    if (env.ACRONIS_TOKENS) {
      const ttl = Math.floor((cachedToken.expires - Date.now()) / 1000);
      if (ttl >= 60) await env.ACRONIS_TOKENS.put(TOKEN_KV_KEY, JSON.stringify(cachedToken), { expirationTtl: ttl });
    }
    return data.access_token;
  })();
  try {
    return await tokenRequest;
  } finally {
    tokenRequest = null;
  }
}

// GET {dc}/api<path>. `tenant` adds X-Apigw-Tenant-Id (scopes services that
// have no tenant filter). Never swallows errors: a failure throws the real
// status and body. A 401 gets one fresh token; 429/5xx retry twice.
async function api(env: Env, path: string, params?: Record<string, unknown>, tenant?: string): Promise<any> {
  // File Sync & Share lives at {dc}/fc/api/v1, every other API under {dc}/api.
  const url = new URL(path.startsWith("/fc/") ? `${base(env)}${path}` : `${base(env)}/api${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  let rejected: string | undefined;
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await getToken(env, rejected);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (tenant) headers["X-Apigw-Tenant-Id"] = tenant;
    const res = await fetch(url.toString(), { headers });
    const text = await res.text();
    if (res.ok) {
      try { return text ? JSON.parse(text) : null; } catch { return text; }
    }
    lastErr = `GET ${url.pathname}${url.search} failed (${res.status}): ${text.slice(0, 500)}`;
    if (res.status === 401 && !rejected) {
      if (cachedToken?.token === token) cachedToken = null;
      rejected = token;
      continue;
    }
    if ([429, 502, 503, 504].includes(res.status) && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("Retry-After")) || attempt + 1, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  throw new Error(lastErr);
}

function nextCursor(r: any): string | undefined {
  return r?.paging?.cursors?.after ?? r?.cursors?.after ?? r?.paging?.after ?? undefined;
}

// Follow `after` cursors up to maxPages; returns every item.
async function allPages(env: Env, path: string, params: Record<string, unknown>, tenant?: string, maxPages = 10): Promise<{ items: any[]; truncated: boolean }> {
  const items: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    // Acronis: when `after` is sent, only `limit` may go with it (the cursor carries the filters).
    const r = await api(env, path, after ? { limit: params.limit, after } : params, tenant);
    items.push(...(r?.items || []));
    after = nextCursor(r);
    if (!after || !(r?.items || []).length) return { items, truncated: false };
  }
  return { items, truncated: true };
}

// ─── Tenants ──────────────────────────────────────────────────────────────────

let partner: { id: string; name: string } | null = null;
async function partnerTenant(env: Env): Promise<{ id: string; name: string }> {
  if (partner) return partner;
  const client = await api(env, `/2/clients/${encodeURIComponent(env.ACRONIS_CLIENT_ID)}`);
  const t = await api(env, `/2/tenants/${client.tenant_id}`);
  partner = { id: client.tenant_id, name: t.name };
  return partner;
}

type Tenant = { id: string; name: string; kind: string; parent_id?: string; enabled?: boolean };
let tenantCache: { at: number; list: Tenant[] } | null = null;
let tenantLoad: Promise<Tenant[]> | null = null;

// Every tenant under the API client's tenant (customers, partners, folders),
// cached for 5 minutes per isolate.
async function allTenants(env: Env): Promise<Tenant[]> {
  if (tenantCache && Date.now() - tenantCache.at < 300000) return tenantCache.list;
  if (tenantLoad) return tenantLoad;
  tenantLoad = (async () => {
    const root = await partnerTenant(env);
    const { items } = await allPages(env, "/2/tenants", { subtree_root_id: root.id, lod: "basic", limit: 1000 }, undefined, 20);
    const list = items.map((t: any) => ({ id: t.id, name: t.name, kind: t.kind, parent_id: t.parent_id, enabled: t.enabled }));
    tenantCache = { at: Date.now(), list };
    return list;
  })();
  try {
    return await tenantLoad;
  } finally {
    tenantLoad = null;
  }
}

async function tenantName(env: Env, id?: string): Promise<string | undefined> {
  if (!id) return undefined;
  try {
    return (await allTenants(env)).find((t) => t.id === id)?.name;
  } catch {
    return undefined;
  }
}

function pick(args: Args, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined && args[n] !== null && args[n] !== "") return args[n];
  return undefined;
}

// `tenant` may be a tenant UUID or a (part of a) customer name.
async function tenantArg(env: Env, args: Args, needed: boolean): Promise<Tenant | undefined> {
  const v = pick(args, "tenant", "tenant_id", "customer", "client");
  if (v === undefined) {
    if (needed) throw new Error("tenant is required (customer name or tenant UUID; list_customers shows them)");
    return undefined;
  }
  const s = String(v).trim();
  const list = await allTenants(env);
  if (UUID_RE.test(s)) return list.find((t) => t.id === s) || { id: s, name: s, kind: "unknown" };
  const q = s.toLowerCase();
  let hits = list.filter((t) => (t.name || "").toLowerCase() === q);
  if (!hits.length) hits = list.filter((t) => (t.name || "").toLowerCase().includes(q));
  if (hits.length > 1) {
    const customers = hits.filter((t) => t.kind === "customer");
    if (customers.length === 1) hits = customers;
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No Acronis tenant matches "${s}". Use list_customers to find it.`);
  throw new Error(`"${s}" matches ${hits.length} tenants: ${hits.slice(0, 15).map((t) => `${t.name} [${t.kind}] (${t.id})`).join("; ")}. Pass the tenant UUID.`);
}

// ─── Scope: a customer and its units ──────────────────────────────────────────
//
// Verified live 2026-11-16 (Fritz, Nippes): machines, agents and backup tasks
// do not belong to the customer tenant itself but to a `unit` under it, e.g.
// "BackupUser@fncpas.com" (the account the agent registered with). Each API
// scopes differently:
//   alerts            tenant=<customer UUID>    includes units
//   resource_statuses tenant_id=<UUID>          exact tenant only -> send every unit
//   policies          tenant_id=<customer UUID> plans live at the customer
//   agents            tenant_id ignores UUIDs   -> filter by the agent's tenant name
//   tasks/activities  no tenant filter and the X-Apigw-Tenant-Id header is
//                     ignored -> filter by row.tenant.uuid here

type Scope = { root: Tenant; customer: Tenant; ids: Set<string>; names: Set<string> };

function ancestors(list: Tenant[], t: Tenant): Tenant[] {
  const byId = new Map(list.map((x) => [x.id, x]));
  const chain: Tenant[] = [];
  let cur: Tenant | undefined = t;
  for (let i = 0; cur && i < 20; i++) {
    chain.push(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

// The customer a tenant belongs to (itself if it is one), for display.
async function customerOf(env: Env, uuid?: string): Promise<string | undefined> {
  if (!uuid) return undefined;
  try {
    const list = await allTenants(env);
    const t = list.find((x) => x.id === uuid);
    if (!t) return undefined;
    return (ancestors(list, t).find((x) => x.kind === "customer") || t).name;
  } catch {
    return undefined;
  }
}

async function scopeArg(env: Env, args: Args, needed: boolean): Promise<Scope | undefined> {
  const root = await tenantArg(env, args, needed);
  if (!root) return undefined;
  const list = await allTenants(env);
  const ids = new Set<string>([root.id]);
  // Breadth-first over parent_id: every tenant below root (units, sub-customers).
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of list) if (t.parent_id && ids.has(t.parent_id) && !ids.has(t.id)) { ids.add(t.id); grew = true; }
  }
  const names = new Set(list.filter((t) => ids.has(t.id)).map((t) => t.name));
  names.add(root.name);
  const customer = ancestors(list, root).find((x) => x.kind === "customer") || root;
  return { root, customer, ids, names };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECRET_KEY = /secret|password|passwd|passphrase|private_?key|access_?token|refresh_?token|registration_?token|api_?key/i;

function out(data: unknown): string {
  const s = typeof data === "string" ? data : JSON.stringify(data, (k, v) => (k && SECRET_KEY.test(k) && typeof v === "string" ? "[redacted]" : v));
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + `\n... [truncated at ${MAX_CHARS} of ${s.length} chars; narrow the query or lower limit]` : s;
}

function cap(v: unknown, n = 1500): unknown {
  if (v === undefined || v === null) return undefined;
  const s = JSON.stringify(v);
  return s.length <= n ? v : s.slice(0, n) + "...";
}

function clampLimit(v: unknown, def: number, max: number): number {
  return Math.min(Math.max(Number(v ?? def) || def, 1), max);
}

// "7d", "24h", "90m" or an ISO date -> epoch ms.
function sinceMs(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  const m = /^(\d+)\s*([mhd])$/i.exec(s);
  if (m) return Date.now() - Number(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 } as Record<string, number>)[m[2].toLowerCase()];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Can't read "${s}" as a time: use ISO (2026-11-01T00:00:00Z) or 24h / 7d`);
  return t;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function list(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);
}

// One value as-is, several as or(a,b) (Acronis filter syntax; works on alerts).
function orFilter(v: unknown): string | undefined {
  const l = list(v);
  return l.length === 0 ? undefined : l.length === 1 ? l[0] : `or(${l.join(",")})`;
}

function daysSince(ts?: string): number | undefined {
  if (!ts) return undefined;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? undefined : Math.floor((Date.now() - t) / 86400000);
}

const PROBLEM_STATUSES = ["warning", "error", "critical", "not_protected", "interaction_required"];

// ─── Data loaders ─────────────────────────────────────────────────────────────

// Workload statuses for a scope: tenant_id is an exact match, so send every
// tenant in the scope (100 per call). Resource groups are skipped unless asked.
async function loadWorkloads(env: Env, scope: Scope | undefined, opts: { type?: unknown; includeGroups?: boolean }): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = [];
  let truncated = false;
  const ids = scope ? [...scope.ids] : [undefined];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = scope ? ids.slice(i, i + 100) : undefined;
    const r = await allPages(env, "/resource_management/v4/resource_statuses", { tenant_id: chunk, type: opts.type, limit: 200 }, undefined, scope ? 10 : 25);
    rows.push(...r.items);
    truncated ||= r.truncated;
  }
  return { rows: opts.includeGroups ? rows : rows.filter((i) => !String(i.context?.type || "").startsWith("resource.group")), truncated };
}

// Every agent of the partner account, cached 2 minutes (agent_manager ignores
// UUIDs in tenant_id, so a customer's agents are picked by their tenant name).
let agentCache: { at: number; rows: any[] } | null = null;
async function allAgents(env: Env): Promise<any[]> {
  if (agentCache && Date.now() - agentCache.at < 120000) return agentCache.rows;
  const { items } = await allPages(env, "/agent_manager/v2/agents", { limit: 100 }, undefined, 30);
  agentCache = { at: Date.now(), rows: items };
  return items;
}

async function loadAgents(env: Env, scope: Scope | undefined): Promise<any[]> {
  const rows = await allAgents(env);
  return scope ? rows.filter((a) => scope.names.has(a.tenant?.name)) : rows;
}

// Resource ids (UPPERCASE, as task_manager stores them) of workloads in scope whose name contains q.
async function resourceIdsByName(env: Env, scope: Scope | undefined, q: string): Promise<{ ids: string[]; names: string[] }> {
  const { rows } = await loadWorkloads(env, scope, {});
  const hits = rows.filter((i) => `${i.context?.name || ""} ${i.context?.user_defined_name || ""}`.toLowerCase().includes(q.toLowerCase()));
  return { ids: [...new Set(hits.map((i) => String(i.context.id).toUpperCase()))], names: [...new Set(hits.map((i) => i.context.user_defined_name || i.context.name))] };
}

// ─── Slim views ───────────────────────────────────────────────────────────────

// Acronis errors nest ~20 levels deep under context._src.suberror. cause_str /
// effect_str are the summary; the most specific text is often deeper, e.g. a
// Hyper-V ErrorDescription ("Checkpoint operation ... failed ... 0x8000FFFF")
// under a cause_str of just "The task has completed with errors." (2026-11-16).
function deepestDetail(ctx: any): string | undefined {
  let node = ctx?._src;
  let detail: string | undefined;
  for (let i = 0; node && i < 40; i++) {
    const d = node.fields?.ErrorDescription || node.fields?.ErrorMessage;
    if (d) detail = String(d);
    node = node.suberror && Object.keys(node.suberror).length ? node.suberror : undefined;
  }
  return detail;
}

function oneError(e: any) {
  const c = e?.context || {};
  const detail = deepestDetail(c);
  return {
    reason: e?.reason || e?.code,
    cause: c.cause_str || c.msg,
    detail: detail && detail !== c.cause_str ? detail.replace(/\s+/g, " ").slice(0, 400) : undefined,
    effect: c.effect_str !== c.cause_str ? c.effect_str : undefined,
  };
}

function errorSummary(result: any): unknown {
  if (!result) return undefined;
  const warnings = (result.warnings || []).filter((w: any) => w?.reason !== "ActivitySucceededWithWarnings").slice(0, 3).map(oneError);
  if (!result.error && !warnings.length) return result.code;
  return { code: result.code, ...(result.error ? oneError(result.error) : {}), warnings: warnings.length ? warnings : undefined };
}

async function slimAlert(env: Env, a: any) {
  const d = typeof a.details === "string" ? (() => { try { return JSON.parse(a.details); } catch { return {}; } })() : a.details || {};
  return {
    id: a.id, severity: a.severity, category: a.category, type: a.type,
    customer: (await customerOf(env, a.tenant?.uuid)) ?? a.tenant?.id,
    resource: d.resourceName, resource_id: d.resourceId, plan: d.planName,
    activity: d.activityName, message: d.warning?.suberror?.suberror?.fields?.ErrorDescription ?? d.errorMessage?.kbLink?.serCode,
    createdAt: a.createdAt, updatedAt: a.updatedAt, dismissedAt: a.deletedAt || undefined,
  };
}

// Workload rows carry the unit's NUMERIC tenant id and its name, so the
// customer is found through the unit's name in the tenant list.
async function customerOfUnitName(env: Env, unitName?: string): Promise<string | undefined> {
  if (!unitName) return undefined;
  try {
    const t = (await allTenants(env)).find((x) => x.name === unitName);
    return t ? customerOf(env, t.id) : undefined;
  } catch {
    return undefined;
  }
}

async function slimWorkload(env: Env, i: any) {
  const c = i.context || {};
  const backups = (i.policies || []).filter((p: any) => String(p.type).includes("backup"));
  const lastSuccess = backups.map((p: any) => p.last_success_run).filter(Boolean).sort().pop();
  const lastRun = backups.map((p: any) => p.last_run).filter(Boolean).sort().pop();
  return {
    id: c.id, name: c.user_defined_name || c.name, type: c.type,
    customer: (await customerOfUnitName(env, c.tenant_name)) ?? c.tenant_name, unit: c.tenant_name,
    status: i.aggregate?.status, plans: i.aggregate?.names,
    last_backup_run: lastRun, last_backup_success: lastSuccess,
    days_since_success: daysSince(lastSuccess),
    next_run: backups.map((p: any) => p.next_run).filter(Boolean).sort()[0],
    other_policies: (i.policies || []).filter((p: any) => !String(p.type).includes("backup")).map((p: any) => p.type),
  };
}

function slimTask(t: any) {
  return {
    id: t.idString ?? t.id, title: t.context?.title, state: t.state, result: errorSummary(t.result),
    resource: t.resource?.name, resource_id: t.resource?.id, plan: t.policy?.name,
    unit: t.tenant?.name, run_mode: t.context?.runMode, started_by: t.startedByUser,
    enqueuedAt: t.enqueuedAt, startedAt: t.startedAt, completedAt: t.completedAt,
  };
}

function slimActivity(a: any) {
  return {
    id: a.idString ?? a.id, task_id: a.taskIdString ?? a.taskId, title: a.context?.title, state: a.state,
    result: errorSummary(a.result), resource: a.resource?.name, plan: a.policy?.name ?? a.context?.BackupPlanName,
    backup_type: a.context?.BackupType, location: a.context?.Location?.StorageKind?.LocationKind,
    startedAt: a.startedAt, completedAt: a.completedAt,
  };
}

function slimAgent(a: any) {
  return {
    id: a.id, hostname: a.hostname, online: a.online, enabled: a.enabled, unit: a.tenant?.name,
    os: a.platform?.name && a.platform.name !== "windows" ? a.platform.name : a.platform?.family,
    agent_version: a.core_version?.current ? `${a.core_version.current.release_id}.${a.core_version.current.build}` : undefined,
    installer_version: a.installer_version?.current?.release_id,
    update_status: a.unattended_update?.status, registered: a.registration_date,
  };
}

function slimPlan(it: any, customer?: string) {
  const all: any[] = Array.isArray(it.policy) ? it.policy : [it.policy || it];
  const p = all.find((x) => !x.parent_ids?.length) || all[0];
  const ctx = it.context?.items;
  return {
    id: p?.id, name: p?.name, enabled: p?.enabled, comment: p?.comment, customer,
    enabled_parts: all.filter((x) => x !== p && x.enabled).map((x) => x.name || x.type),
    applied_to: Array.isArray(ctx) ? ctx.map((c: any) => c.name || c.id).slice(0, 100) : undefined,
  };
}

// ─── Endpoint catalog ─────────────────────────────────────────────────────────
// src/catalog.json is generated from Acronis's OpenAPI specs (spec/, `npm run
// catalog`). LIVE_NOTES records what calling each API with Altec's
// partner-level API client actually did (2026-11-16).

type CatOp = { a: string; m: string; p: string; s?: string; d?: string; q: [string, string, number, string, string?, unknown[]?][] };
const CATALOG = catalogJson as unknown as { built: string; apis: { api: string; title: string; version: string; base: string; operations: number }[]; ops: CatOp[] };

const LIVE_NOTES: Record<string, string> = {
  "account-management-v2": "Works. Tenant list includes the units under each customer (where machines live).",
  "alerts-v1": "Works. tenant=<customer UUID> includes its units; severity=or(a,b) and updated_at=gt(<unix ns>) work.",
  "agents-v2": "Works partner-wide. tenant_id ignores UUIDs (only Acronis's numeric tenant ids, e.g. 273146, which appear in alert/task 'locator' paths).",
  "resource-policy-management-v4": "Works. resource_statuses tenant_id = exact tenant (send each unit's UUID); policies at the customer UUID; /policy_management/v4/applications gives per-machine deployment state, last success and next run.",
  "tasks-v2": "Works. Resource ids UPPERCASE; like()/gt() filters return 500 or time out; X-Apigw-Tenant-Id is ignored. Sort with order=desc(id).",
  "vaultman-v1": "Returns empty lists to this partner-level client (vaults, archives, backups, backed_up_resources, storage_usage_stats). Probably needs a customer-level API client.",
  "disaster-recovery-v2": "Refused: 'Request is not allowed for tenant kind partner'. Needs a customer-level API client.",
  "mdr-v1": "Needs customer_id=<customer UUID>; a customer without EDR answers 'route to DB client is not found'.",
  "events-v1": "Works. /event_manager/v1/topics lists topics (task events, tenant changes); /types needs a topic or type id.",
  "advanced-automation-v1": "Acronis PSA (ticketing/billing) - only useful if Acronis PSA is in use; Altec uses HaloPSA. Not tested.",
  "files-v1": "File Sync & Share (Acronis Cyber Files), a separate product - not backup contents. Path starts /fc/api/v1. Not tested.",
  "pricelist-v1": "Price lists. Not tested.",
};

const VAULT_NOTE = "Acronis returned no recovery points. With a partner-level API client the Vault Manager API has returned nothing so far (2026-11-16); use list_workloads (last_backup_success) and list_activities instead.";

// ─── Tools ────────────────────────────────────────────────────────────────────

const TENANT = { type: "string", description: "Customer name (or part of it) or tenant UUID" };
const FULL = { type: "boolean", description: "Return Acronis's raw rows instead of the trimmed view" };
const SINCE = { type: "string", description: "Only items since this time: ISO (2026-11-01T00:00:00Z) or relative (24h, 7d)" };
const RESOURCE = { type: "string", description: "Workload id (from list_workloads / get_backup_status)" };
const RESOURCE_NAME = { type: "string", description: "Part of the machine/workload name (looked up in list_workloads)" };

const TOOLS = [
  {
    name: "healthcheck",
    description: "Check the Acronis connection: token, the API client's own tenant, and how many customers it can see.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_customers",
    description: "List Acronis customer tenants under our partner account (name, tenant UUID, enabled). name filters by part of the name. Use the name or UUID as `tenant` in other tools.",
    inputSchema: { type: "object", properties: {
      name: { type: "string" },
      kind: { type: "string", description: "customer (default), partner, folder, unit, or all" },
      include_disabled: { type: "boolean" },
    } },
  },
  {
    name: "get_tenant",
    description: "One tenant's details: kind, parent, enabled, customer type, contact, MFA status, created date, and its units (where the machines live).",
    inputSchema: { type: "object", properties: { tenant: TENANT, full: FULL }, required: ["tenant"] },
  },
  {
    name: "get_tenant_usage",
    description: "A tenant's current service usage (workloads, storage, M365 seats...) against quotas. Only non-zero usages unless full.",
    inputSchema: { type: "object", properties: { tenant: TENANT, full: FULL }, required: ["tenant"] },
  },
  {
    name: "get_backup_status",
    description: "Start here for 'is this client's backup working?'. For one customer: every workload with status, last backup run, last SUCCESSFUL backup and days since it (problems first), offline agents, and open alerts (warning and worse). Then use list_activities with the workload name to see why a backup failed.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      name: { type: "string", description: "Only workloads/agents/alerts whose name contains this (e.g. a computer name)" },
    }, required: ["tenant"] },
  },
  {
    name: "list_workloads",
    description: "Protection status per workload (machine, VM, M365 mailbox...): status, plan, last backup run, last successful backup, days since success, next run. Across all customers when tenant is left out.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      name: RESOURCE_NAME,
      type: { type: "string", description: "Acronis resource type, e.g. resource.machine, resource.virtual_machine.mshyperv" },
      only_problems: { type: "boolean", description: "Only warning/error/critical/not protected/needs interaction" },
      stale_days: { type: "number", description: "Only workloads whose last successful backup is older than this many days" },
      include_groups: { type: "boolean", description: "Also return resource groups (hidden by default)" },
      limit: { type: "number", description: "Max rows returned (default 100)" },
      full: FULL,
    } },
  },
  {
    name: "get_workload",
    description: "One workload (resource) by id, with its attributes (OS, agent, IPs as Acronis records them).",
    inputSchema: { type: "object", properties: { resource_id: RESOURCE }, required: ["resource_id"] },
  },
  {
    name: "list_alerts",
    description: "Acronis alerts (backup failed, status unknown, no backup for X days, agent offline, malware...), newest first. Dismissed alerts are hidden unless include_dismissed.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      severity: { type: "string", description: "One or more of information, warning, error, critical (comma-separated)" },
      category: { type: "string", description: "e.g. Backup, System, Monitoring, Antimalware protection" },
      type: { type: "string", description: "Alert type, e.g. BackupFailed, BackupStatusUnknown, NoBackupForXDays" },
      query: { type: "string", description: "Part of the resource (machine) or plan name" },
      resource_id: RESOURCE,
      since: SINCE,
      include_dismissed: { type: "boolean" },
      limit: { type: "number", description: "default 25, max 200" },
      full: FULL,
    } },
  },
  {
    name: "get_alert",
    description: "One alert with its full details.",
    inputSchema: { type: "object", properties: { alert_id: { type: "string" } }, required: ["alert_id"] },
  },
  {
    name: "customer_alert_counts",
    description: "Open alert count per customer across the whole partner account, busiest first. Good for 'which clients have backup problems?'.",
    inputSchema: { type: "object", properties: {
      severity: { type: "string", description: "default warning,error,critical" },
      category: { type: "string" },
      since: SINCE,
    } },
  },
  {
    name: "list_activities",
    description: "Backup history for a machine with the REAL error: each backup run/step, newest first, with result and cause (e.g. \"Disk 'E:\\\\...avhdx' is not found\"). Pass resource_name (or resource_id), or task_id for the steps of one task. errors_only skips successful runs.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      resource_name: RESOURCE_NAME,
      resource_id: RESOURCE,
      task_id: { type: "string" },
      errors_only: { type: "boolean", description: "Only runs that ended with error/warning" },
      since: SINCE,
      limit: { type: "number", description: "default 15, max 100" },
      full: FULL,
    } },
  },
  {
    name: "list_tasks",
    description: "Task history (backup plan runs, replication, indexing...), newest first, with result and cause. Backup-plan tasks are logged against the machine running the agent (e.g. the Hyper-V host), per-VM detail is in list_activities. Filter by resource, tenant, state and result.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      resource_name: RESOURCE_NAME,
      resource_id: RESOURCE,
      state: { type: "string", description: "enqueued, assigned, started, paused, completed" },
      result: { type: "string", description: "ok, warning, error, cancelled, abandoned, timedout" },
      since: SINCE,
      limit: { type: "number", description: "default 15, max 100" },
      full: FULL,
    } },
  },
  {
    name: "list_agents",
    description: "Protection agents: hostname, online, version, OS, update status. Filter by customer, name, online state.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      name: { type: "string", description: "Part of the hostname" },
      online: { type: "boolean" },
      limit: { type: "number", description: "Max rows returned (default 100)" },
      full: FULL,
    } },
  },
  {
    name: "list_protection_plans",
    description: "A customer's protection plans: enabled state, which parts are on (backup, antimalware, patching...) and, if include_resources, which workloads each covers.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      search: { type: "string", description: "Part of the plan name" },
      include_resources: { type: "boolean" },
      full: FULL,
    }, required: ["tenant"] },
  },
  {
    name: "list_backups",
    description: "Recovery points of one workload from the Vault Manager API, newest first. NOTE: with our partner-level API client this API has returned nothing so far; prefer list_workloads (last_backup_success) and list_activities.",
    inputSchema: { type: "object", properties: {
      resource_id: RESOURCE,
      limit: { type: "number", description: "default 10" },
      full: FULL,
    }, required: ["resource_id"] },
  },
  {
    name: "list_archives",
    description: "Backup archives of one workload or plan from the Vault Manager API, with storage size. Same caveat as list_backups.",
    inputSchema: { type: "object", properties: {
      resource_id: RESOURCE,
      plan_id: { type: "string" },
      limit: { type: "number", description: "default 20" },
    } },
  },
  {
    name: "acronis_find_endpoints",
    description: `Search every documented Acronis API endpoint (${CATALOG.ops.length} operations, ${CATALOG.ops.filter((o) => o.m === "GET").length} of them reads, from Acronis's own OpenAPI specs: Account Management, Alerts, Agents, Resource/Policy Management, Tasks, Vault Manager, Event Manager, EDR, Disaster Recovery, Acronis PSA, Pricelist, File Sync & Share). Use it to find a read endpoint no named tool covers, then call it with acronis_api_get. With no query, lists the APIs and what this API client can and cannot use. Note: Acronis publishes NO API for searching or browsing files inside backups.`,
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Words that must all appear in the path, summary, description or parameter names, e.g. 'alert types', 'hardware node', 'archive stats', 'incident'" },
      api: { type: "string", description: "Only this API, e.g. alerts-v1, vaultman-v1, agents-v2" },
      include_writes: { type: "boolean", description: "Also list POST/PUT/PATCH/DELETE (not callable here; this MCP is read-only)" },
      limit: { type: "number", description: "Max hits (default 30)" },
    } },
  },
  {
    name: "acronis_describe_endpoint",
    description: "Full detail of one Acronis endpoint from the catalog: path, every parameter (where it goes, required, type, allowed values, meaning), and what is known from live use about calling it with this API client. Pass the path as acronis_find_endpoints shows it.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "e.g. /alert_manager/v1/types or /agent_manager/v2/hardware_nodes" }, method: { type: "string", description: "Default GET" } }, required: ["path"] },
  },
  {
    name: "acronis_api_get",
    description: "Read-only escape hatch: GET any Acronis path from acronis_find_endpoints - under /api (e.g. /2/tenants/{id}, /alert_manager/v1/types, /policy_management/v4/applications) or /fc/api/v1/... for File Sync & Share. Query params as an object (an array value repeats the parameter). Notes: task_manager ids are UPPERCASE; resource_statuses tenant_id takes UUIDs (exact tenant); agents' tenant_id needs Acronis's numeric id. Token/secret/password paths are refused. 60K cap.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, params: { type: "object" }, tenant: TENANT }, required: ["path"] },
  },
];

async function runTool(name: string, args: Args, env: Env): Promise<string> {
  args = args || {};
  switch (name) {
    case "healthcheck": {
      const root = await partnerTenant(env);
      const tenants = await allTenants(env);
      return out({ ok: true, datacenter: base(env), api_client_tenant: root, customers: tenants.filter((t) => t.kind === "customer").length, tenants_visible: tenants.length });
    }

    case "list_customers": {
      const kind = String(args.kind ?? "customer").toLowerCase();
      const all = await allTenants(env);
      let rows = all;
      if (kind !== "all") rows = rows.filter((t) => t.kind === kind);
      if (!args.include_disabled) rows = rows.filter((t) => t.enabled !== false);
      if (args.name) rows = rows.filter((t) => (t.name || "").toLowerCase().includes(String(args.name).toLowerCase()));
      const names = new Map(all.map((t) => [t.id, t.name]));
      rows = [...rows].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return out({ count: rows.length, customers: rows.map((t) => ({ name: t.name, id: t.id, kind: t.kind, enabled: t.enabled, parent: names.get(t.parent_id || "") })) });
    }

    case "get_tenant": {
      const s = (await scopeArg(env, args, true))!;
      const r = await api(env, `/2/tenants/${s.root.id}`);
      if (args.full) return out(r);
      const units = (await allTenants(env)).filter((t) => s.ids.has(t.id) && t.id !== s.root.id).map((t) => ({ name: t.name, id: t.id, kind: t.kind }));
      return out({
        id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, customer_type: r.customer_type,
        parent: (await tenantName(env, r.parent_id)) ?? r.parent_id, mfa_status: r.mfa_status,
        pricing_mode: r.pricing_mode, created_at: r.created_at, contact: cap(r.contact, 800), units,
      });
    }

    case "get_tenant_usage": {
      const t = (await tenantArg(env, args, true))!;
      const r = await api(env, "/2/tenants/usages", { tenants: t.id });
      if (args.full) return out(r);
      const rows = (r?.items || []).flatMap((it: any) => (it.usages || []).filter((u: any) => Number(u.value || u.absolute_value || 0) > 0).map((u: any) => ({
        name: u.name, edition: u.edition, type: u.usage_type ?? u.type, value: u.value, absolute_value: u.absolute_value,
        measurement_unit: u.measurement_unit, quota: u.offering_item?.quota?.value ?? u.quota?.value,
      })));
      return out({ tenant: t.name, usages: rows.length || !r?.items ? rows : "no non-zero usage rows - call again with full: true" });
    }

    case "list_workloads": {
      const s = await scopeArg(env, args, false);
      let { rows, truncated } = await loadWorkloads(env, s, { type: args.type, includeGroups: Boolean(args.include_groups) });
      if (args.name) rows = rows.filter((i: any) => `${i.context?.name || ""} ${i.context?.user_defined_name || ""}`.toLowerCase().includes(String(args.name).toLowerCase()));
      if (args.only_problems) rows = rows.filter((i: any) => PROBLEM_STATUSES.includes(String(i.aggregate?.status)));
      const limit = clampLimit(args.limit, 100, 1000);
      if (args.full) return out({ count: rows.length, items: rows.slice(0, limit) });
      let slim = await Promise.all(rows.map((i: any) => slimWorkload(env, i)));
      if (args.stale_days !== undefined) slim = slim.filter((w) => w.last_backup_run && (w.days_since_success === undefined || w.days_since_success > Number(args.stale_days)));
      return out({ customer: s?.customer.name, count: slim.length, returned: Math.min(slim.length, limit), truncated, workloads: slim.slice(0, limit) });
    }

    case "get_backup_status": {
      const s = (await scopeArg(env, args, true))!;
      const nameQ = args.name ? String(args.name).toLowerCase() : undefined;
      // Each part reports its own error instead of failing the whole answer.
      const settle = async <T>(f: () => Promise<T>): Promise<T | { error: string }> => { try { return await f(); } catch (e) { return { error: (e as Error).message }; } };
      const [wl, agents, alerts] = await Promise.all([
        settle(() => loadWorkloads(env, s, {})),
        settle(() => loadAgents(env, s)),
        settle(() => api(env, "/alert_manager/v1/alerts", { tenant: s.root.id, severity: "or(warning,error,critical)", order: "desc(updated_at)", limit: 100 })),
      ]);
      const result: Record<string, unknown> = { customer: s.customer.name, tenant_id: s.root.id, units: [...s.names].filter((n) => n !== s.root.name), checked_at: iso(Date.now()) };
      if ("error" in wl) result.workloads = wl;
      else {
        let rows = wl.rows;
        if (nameQ) rows = rows.filter((i: any) => `${i.context?.name || ""} ${i.context?.user_defined_name || ""}`.toLowerCase().includes(nameQ));
        const slim = await Promise.all(rows.map((i: any) => slimWorkload(env, i)));
        const counts: Record<string, number> = {};
        for (const w of slim) counts[String(w.status)] = (counts[String(w.status)] || 0) + 1;
        const problem = (w: any) => PROBLEM_STATUSES.includes(String(w.status)) || (w.days_since_success ?? 0) > 2;
        result.workload_status_counts = counts;
        result.workloads_with_problems = slim.filter(problem);
        result.other_workloads = slim.filter((w) => !problem(w)).slice(0, 150);
        if (wl.truncated) result.workloads_note = "list cut short - use list_workloads with name for one machine";
      }
      if ("error" in agents) result.agents = agents;
      else {
        let rows = agents;
        if (nameQ) rows = rows.filter((a: any) => String(a.hostname || "").toLowerCase().includes(nameQ));
        result.agents_total = rows.length;
        result.agents_offline = rows.filter((a: any) => a.online === false).map(slimAgent);
      }
      if ("error" in alerts) result.open_alerts = alerts;
      else {
        let rows = alerts?.items || [];
        if (nameQ) rows = rows.filter((a: any) => JSON.stringify(a.details || {}).toLowerCase().includes(nameQ));
        result.open_alerts = await Promise.all(rows.map((a: any) => slimAlert(env, a)));
      }
      result.next_step = "For a workload with problems, call list_activities with its name and errors_only: true to see the cause.";
      return out(result);
    }

    case "get_workload": {
      const id = String(pick(args, "resource_id", "id") ?? "");
      if (!id) throw new Error("resource_id is required");
      return out(await api(env, `/resource_management/v4/resources/${encodeURIComponent(id)}`, { include_attributes: true }));
    }

    case "list_alerts": {
      const t = await tenantArg(env, args, false);
      const since = sinceMs(args.since);
      const r = await api(env, "/alert_manager/v1/alerts", {
        tenant: t?.id, severity: orFilter(args.severity), category: orFilter(args.category), type: orFilter(args.type),
        query: args.query, resourceId: pick(args, "resource_id"),
        updated_at: since !== undefined ? `gt(${since}000000)` : undefined, // Unix nanoseconds
        show_deleted: args.include_dismissed ? true : undefined,
        order: "desc(updated_at)", limit: clampLimit(args.limit, 25, 200),
      });
      if (args.full) return out(r);
      const items = await Promise.all((r?.items || []).map((a: any) => slimAlert(env, a)));
      return out({ tenant: t?.name, count: items.length, alerts: items });
    }

    case "get_alert": {
      const id = String(pick(args, "alert_id", "id") ?? "");
      if (!id) throw new Error("alert_id is required");
      return out(await api(env, `/alert_manager/v1/alerts/${encodeURIComponent(id)}`));
    }

    case "customer_alert_counts": {
      const since = sinceMs(args.since);
      const r = await api(env, "/alert_manager/v1/customer_alerts_count", {
        severity: orFilter(args.severity ?? "warning,error,critical"), category: orFilter(args.category),
        updated_at: since !== undefined ? `gt(${since}000000)` : undefined,
      });
      const byName = new Map((await allTenants(env)).filter((t) => t.kind === "customer").map((t) => [t.name, t.id]));
      const rows = (r?.items || []).filter((x: any) => Number(x.alerts_count) > 0)
        .sort((a: any, b: any) => Number(b.alerts_count) - Number(a.alerts_count))
        .map((x: any) => ({ customer: x.customer_name, tenant_id: byName.get(x.customer_name), alerts: x.alerts_count }));
      return out({ customers_with_alerts: rows.length, items: rows });
    }

    case "list_activities":
    case "list_tasks": {
      const s = await scopeArg(env, args, false);
      const since = sinceMs(args.since);
      const limit = clampLimit(args.limit, 15, 100);
      const params: Record<string, unknown> = { lod: "short", order: "desc(id)" };
      let resolved: string[] | undefined;
      const taskId = pick(args, "task_id");
      if (taskId && name === "list_activities") params.taskId = String(taskId);
      else if (pick(args, "resource_id")) params.resourceId = String(pick(args, "resource_id")).toUpperCase();
      else if (pick(args, "resource_name")) {
        const r = await resourceIdsByName(env, s, String(pick(args, "resource_name")));
        if (!r.ids.length) throw new Error(`No workload matches "${pick(args, "resource_name")}"${s ? ` for ${s.customer.name}` : ""}. Use list_workloads to find it.`);
        params.resourceId = r.ids.slice(0, 20); // repeated param = any of them
        resolved = r.names;
      } else if (!s) throw new Error("Pass tenant, resource_name, resource_id" + (name === "list_activities" ? " or task_id" : ""));
      if (name === "list_tasks") {
        if (args.state) params.state = String(args.state);
        if (args.result) params.resultCode = list(args.result);
      }
      // No server-side date or tenant filter that works (like()/gt() give 500s
      // and timeouts): page newest-first and filter here.
      const wantErrors = name === "list_activities" && args.errors_only;
      const rows: any[] = [];
      let after: string | undefined;
      let scanned = 0;
      for (let page = 0; page < 5 && rows.length < limit; page++) {
        const r = await api(env, `/task_manager/v2/${name === "list_tasks" ? "tasks" : "activities"}`, after ? { limit: 50, after } : { ...params, limit: 50 });
        const items = r?.items || [];
        scanned += items.length;
        let stop = false;
        for (const x of items) {
          const when = Date.parse(x.completedAt || x.startedAt || x.enqueuedAt || x.createdAt || "");
          if (since !== undefined && !Number.isNaN(when) && when > 0 && when < since) { stop = true; break; }
          if (s && x.tenant?.uuid && !s.ids.has(x.tenant.uuid)) continue;
          if (wantErrors && !["error", "warning"].includes(x.result?.code) && !(x.result?.warnings || []).length) continue;
          rows.push(x);
          if (rows.length >= limit) break;
        }
        after = nextCursor(r);
        if (stop || !after || !items.length) break;
      }
      if (args.full) return out({ count: rows.length, items: rows });
      return out({
        customer: s?.customer.name, resources: resolved, scanned, count: rows.length,
        [name === "list_tasks" ? "tasks" : "activities"]: rows.map((x: any) => (name === "list_tasks" ? slimTask(x) : slimActivity(x))),
      });
    }

    case "list_agents": {
      const s = await scopeArg(env, args, false);
      let rows = await loadAgents(env, s);
      if (args.name) rows = rows.filter((a: any) => String(a.hostname || "").toLowerCase().includes(String(args.name).toLowerCase()));
      if (typeof args.online === "boolean") rows = rows.filter((a: any) => a.online === args.online);
      const limit = clampLimit(args.limit, 100, 1000);
      if (args.full) return out({ count: rows.length, items: rows.slice(0, limit) });
      return out({ customer: s?.customer.name, count: rows.length, agents: rows.slice(0, limit).map(slimAgent) });
    }

    case "list_protection_plans": {
      const s = (await scopeArg(env, args, true))!;
      const { items, truncated } = await allPages(env, "/policy_management/v4/policies", { tenant_id: s.customer.id, include_applied_context: args.include_resources ? true : undefined, limit: 50 }, undefined, 5);
      let plans = items.map((it: any) => slimPlan(it, s.customer.name));
      if (args.search) plans = plans.filter((p: any) => String(p.name || "").toLowerCase().includes(String(args.search).toLowerCase()));
      if (args.full) return out({ count: items.length, items });
      return out({ customer: s.customer.name, count: plans.length, truncated, plans });
    }

    case "list_backups": {
      const id = String(pick(args, "resource_id") ?? "");
      if (!id) throw new Error("resource_id is required");
      const r = await api(env, "/vault_manager/v1/backups", { resourceId: id, limit: 500 });
      const items = (r?.items || []).sort((a: any, b: any) => String(b.created).localeCompare(String(a.created))).slice(0, clampLimit(args.limit, 10, 500));
      if (!items.length) return out({ count: 0, note: VAULT_NOTE });
      if (args.full) return out({ count: items.length, items });
      return out({ count: items.length, newest_first: items.map((b: any) => ({
        created: b.created, type: b.type ?? b.backup_type, size: b.size, original_data_size: b.original_data_size,
        validation: b.validation_status, malware_scan: b.malware_assessment_result, deleted: b.deleted || undefined,
        backup_id: b.backup_id ?? b.id, archive_id: b.archive_id,
      })) });
    }

    case "list_archives": {
      if (!args.resource_id && !args.plan_id) throw new Error("Pass resource_id or plan_id");
      const r = await api(env, "/vault_manager/v1/archives", { resourceId: args.resource_id, backupPlanId: args.plan_id, includeStats: true, limit: clampLimit(args.limit, 20, 200) });
      const items = r?.items || [];
      if (!items.length) return out({ count: 0, note: VAULT_NOTE });
      return out({ count: items.length, archives: items.map((a: any) => ({
        id: a.id, name: a.name, created: a.created, updated: a.updated, size: a.size, type: a.type, consistent: a.consistent, deleted: a.deleted || undefined, stats: cap(a.stats, 600),
      })) });
    }

    case "acronis_find_endpoints": {
      const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const apiQ = args.api ? String(args.api).toLowerCase() : undefined;
      if (!words.length && !apiQ) {
        return out({
          built: CATALOG.built, operations: CATALOG.ops.length, reads: CATALOG.ops.filter((o) => o.m === "GET").length,
          apis: CATALOG.apis.map((a) => ({ ...a, reads: CATALOG.ops.filter((o) => o.a === a.api && o.m === "GET").length, live_notes: LIVE_NOTES[a.api] })),
          file_level_search: "Not available: Acronis publishes no API to search or browse files inside backups.",
        });
      }
      const hits = CATALOG.ops.filter((o) => {
        if (apiQ && o.a.toLowerCase() !== apiQ) return false;
        if (!args.include_writes && o.m !== "GET") return false;
        const hay = `${o.a} ${o.m} ${o.p} ${o.s || ""} ${o.d || ""} ${o.q.map((x) => x[0]).join(" ")}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const limit = clampLimit(args.limit, 30, 200);
      return out({
        count: hits.length, shown: Math.min(hits.length, limit),
        endpoints: hits.slice(0, limit).map((o) => ({ api: o.a, method: o.m, path: o.p, summary: o.s, params: o.q.map((x) => (x[2] ? `${x[0]}*` : x[0])).join(", ") || undefined })),
        next: "acronis_describe_endpoint for parameters, acronis_api_get to call a GET (* = required)",
      });
    }

    case "acronis_describe_endpoint": {
      let p = String(args.path ?? "").trim();
      if (p.startsWith("/api/")) p = p.slice(4);
      const method = String(args.method ?? "GET").toUpperCase();
      const norm = (x: string) => x.replace(/\{[^}]+\}/g, "{}").toLowerCase();
      const op = CATALOG.ops.find((o) => o.m === method && o.p === p) || CATALOG.ops.find((o) => o.m === method && norm(o.p) === norm(p));
      if (!op) {
        const near = CATALOG.ops.filter((o) => o.p.toLowerCase().includes(p.toLowerCase().split("/").filter(Boolean).pop() || "~")).slice(0, 10).map((o) => `${o.m} ${o.p}`);
        throw new Error(`No ${method} ${p} in the catalog.${near.length ? ` Close: ${near.join("; ")}` : ""} Use acronis_find_endpoints.`);
      }
      return out({
        api: op.a, method: op.m, path: op.p, summary: op.s, description: op.d,
        callable: op.m === "GET" ? "yes, with acronis_api_get" : "no - this MCP is read-only",
        params: op.q.map(([name, where, req, type, desc, en]) => ({ name, in: where, required: Boolean(req), type, values: en || undefined, description: desc })),
        live_notes: LIVE_NOTES[op.a],
      });
    }

    case "acronis_api_get": {
      let path = String(args.path ?? "");
      if (path.startsWith("/api/")) path = path.slice(4);
      if (!path.startsWith("/") || path.includes("..") || path.includes("?")) throw new Error("path must start with '/' and contain no '..' or '?' (put query params in params)");
      if (/idp|token|secret|password|credential/i.test(path)) throw new Error("acronis_api_get refuses token, secret, password and credential paths");
      const t = await tenantArg(env, args, false);
      const params = args.params && typeof args.params === "object" ? (args.params as Record<string, unknown>) : {};
      return out(await api(env, path, params, t?.id));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

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
    // A secret pasted into the dashboard can carry a trailing space or line
    // break; compare trimmed values on both sides (2026-11-16: Claude's
    // connector token was rejected with 401 although it looked right).
    const expected = (env.MCP_AUTH_TOKEN || "").trim();
    const configured = Boolean(env.ACRONIS_BASE_URL && env.ACRONIS_CLIENT_ID && env.ACRONIS_CLIENT_SECRET && expected);
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", configured }), { headers: JSON_HEADERS });
    // Fail closed: the API client sees every customer's backups.
    if (!configured) {
      return new Response(JSON.stringify({ error: "acronis-mcp is not configured: set ACRONIS_BASE_URL (var) and the ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET and MCP_AUTH_TOKEN secrets." }), { status: 503, headers: JSON_HEADERS });
    }
    const header = request.headers.get("Authorization") || "";
    const provided = header.replace(/^Bearer\s+/i, "").trim();
    if (!timingSafeEqual(provided, expected)) {
      // Why it was rejected, never the token itself: scheme, lengths, and
      // whether the saved secret itself carried whitespace.
      console.log(JSON.stringify({
        evt: "auth_rejected", path: url.pathname, method: request.method,
        scheme: header ? header.split(/\s+/)[0] : "none",
        provided_len: provided.length, expected_len: expected.length,
        secret_had_whitespace: (env.MCP_AUTH_TOKEN || "").length !== expected.length,
      }));
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
    }
    // No event stream here (2026-10-26 repo rule): GET/DELETE /mcp answer 405.
    if (url.pathname === "/mcp" && (request.method === "GET" || request.method === "DELETE")) return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });
    if (url.pathname === "/mcp" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg || ({} as any);
        if (id === undefined || id === null) continue; // notification
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "acronis-mcp", version: "1.0.0" } } });
          else if (method === "ping") responses.push({ jsonrpc: "2.0", id, result: {} });
          else if (method === "tools/list") responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          else if (method === "tools/call") {
            const text = await runTool(params?.name as string, (params?.arguments ?? {}) as Args, env);
            responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
          } else responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        } catch (err) {
          responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } });
        }
      }
      if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });
      return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers: JSON_HEADERS });
    }
    return new Response("acronis-mcp - POST /mcp | GET /health", { status: 200, headers: CORS });
  },
};
