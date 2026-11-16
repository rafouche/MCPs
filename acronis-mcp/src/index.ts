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
 * APIs used (developer.acronis.com, read 2026-11-16), all under {dc}/api:
 *   /2/...                         Account Management (clients, tenants, usages)
 *   /alert_manager/v1/alerts       filter `tenant`
 *   /resource_management/v4/...    filter `tenant_id` (resource_statuses = last run / last success)
 *   /policy_management/v4/policies filter `tenant_id`
 *   /agent_manager/v2/agents       filter `tenant_id`
 *   /task_manager/v2/tasks|activities  no tenant filter: scoped by the
 *                                  X-Apigw-Tenant-Id header and re-checked here
 *   /vault_manager/v1/backups|archives no tenant filter: filter by resource
 * Not yet checked against a live tenant: filter syntaxes like
 * completedAt=gt(<ISO>), severity=or(a,b), updated_at=gt(<unix ns>), and the
 * exact shape of policies/usages rows. Every list tool takes `full: true` to
 * return Acronis's raw rows when the trimmed view hides something.
 */

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
  const url = new URL(`${base(env)}/api${path}`);
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

// One value as-is, several as or(a,b) (Acronis filter syntax).
function orFilter(v: unknown): string | undefined {
  const l = list(v);
  return l.length === 0 ? undefined : l.length === 1 ? l[0] : `or(${l.join(",")})`;
}

const PROBLEM_STATUSES = ["warning", "error", "critical", "not_protected", "no_policies_applied", "interaction_required"];

// ─── Slim views ───────────────────────────────────────────────────────────────

async function slimAlert(env: Env, a: any) {
  const d = a.details || {};
  return {
    id: a.id, severity: a.severity, category: a.category, type: a.type,
    tenant: (await tenantName(env, a.tenant?.id)) ?? a.tenant?.id,
    resource: d.resourceName, plan: d.planName,
    createdAt: a.createdAt, updatedAt: a.updatedAt, dismissedAt: a.deletedAt || undefined,
    details: cap(d),
  };
}

async function slimWorkload(env: Env, i: any) {
  const c = i.context || {};
  return {
    id: c.id, name: c.user_defined_name || c.name, type: c.type,
    tenant: (await tenantName(env, c.tenant_id)) ?? c.tenant_id,
    status: i.aggregate?.status, plans: i.aggregate?.names,
    policies: (i.policies || []).map((p: any) => cap({ type: p.type, status: p.status, last_run: p.last_run, last_success_run: p.last_success_run, next_run: p.next_run ?? p.next_run_time }, 800)),
  };
}

function slimTask(t: any) {
  return {
    id: t.id, type: t.type, state: t.state, result: cap(t.result, 1200),
    resource: t.resource ? { id: t.resource.id, name: t.resource.name, type: t.resource.type } : undefined,
    plan: t.policy ? { id: t.policy.id, name: t.policy.name } : undefined,
    tenant: t.tenant?.name, startedBy: t.startedByUser,
    enqueuedAt: t.enqueuedAt, startedAt: t.startedAt, completedAt: t.completedAt,
  };
}

function slimAgent(a: any) {
  return {
    id: a.id, hostname: a.hostname, name: a.name !== a.hostname ? a.name : undefined,
    online: a.online, enabled: a.enabled, tenant: a.tenant?.name,
    os: a.platform?.family ?? a.platform?.os_family ?? cap(a.platform, 200),
    version: a.core_version?.current ?? cap(a.installer_version?.current, 200),
    auto_update: a.auto_update, registered: a.registration_date,
  };
}

function slimPlan(it: any) {
  const p = Array.isArray(it.policy) ? (it.policy.find((x: any) => !x.parent_ids?.length) || it.policy[0]) : (it.policy || it);
  const ctx = it.context?.items;
  return {
    id: p?.id, name: p?.name, type: p?.type, enabled: p?.enabled, tenant: p?.tenant_id,
    applied_to: Array.isArray(ctx) ? ctx.map((c: any) => c.name || c.id).slice(0, 100) : undefined,
  };
}

// Tasks/activities have no tenant filter: keep only rows of that tenant when
// the row says which tenant it belongs to.
function sameTenant(row: any, tid: string): boolean {
  const t = row.tenant;
  if (!t) return true;
  return t.uuid === tid || t.id === tid || String(t.locator || "").includes(tid);
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const TENANT = { type: "string", description: "Customer name (or part of it) or tenant UUID" };
const FULL = { type: "boolean", description: "Return Acronis's raw rows instead of the trimmed view" };
const SINCE = { type: "string", description: "Only items since this time: ISO (2026-11-01T00:00:00Z) or relative (24h, 7d)" };

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
    description: "One tenant's details: kind, parent, enabled, customer type, contact, MFA status, created date.",
    inputSchema: { type: "object", properties: { tenant: TENANT, full: FULL }, required: ["tenant"] },
  },
  {
    name: "get_tenant_usage",
    description: "A tenant's current service usage (workloads, storage, M365 seats...) against quotas. Only non-zero usages unless full.",
    inputSchema: { type: "object", properties: { tenant: TENANT, full: FULL }, required: ["tenant"] },
  },
  {
    name: "get_backup_status",
    description: "Start here for 'is this client's backup working?'. For one customer: every protected workload with its status and last run / last successful run, workloads with problems first, offline agents, and open alerts (warning and worse).",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      name: { type: "string", description: "Only workloads/agents whose name contains this (e.g. a computer name)" },
    }, required: ["tenant"] },
  },
  {
    name: "list_workloads",
    description: "Protection status per workload (machine, VM, M365 mailbox...): status (idle/ok, warning, error, critical, not_protected, running...), plan names, last run and last successful run per plan.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      name: { type: "string", description: "Part of the workload name" },
      type: { type: "string", description: "Acronis resource type, e.g. resource.machine" },
      only_problems: { type: "boolean", description: "Only warning/error/critical/not protected/needs interaction" },
      limit: { type: "number", description: "Max rows returned (default 100)" },
      full: FULL,
    } },
  },
  {
    name: "get_workload",
    description: "One workload (resource) by id, with its attributes (OS, agent, IPs as Acronis records them).",
    inputSchema: { type: "object", properties: { resource_id: { type: "string" } }, required: ["resource_id"] },
  },
  {
    name: "list_alerts",
    description: "Acronis alerts (backup failed, no backup for X days, agent offline, malware...), newest first. Dismissed alerts are hidden unless include_dismissed.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      severity: { type: "string", description: "One or more of information, warning, error, critical (comma-separated)" },
      category: { type: "string", description: "e.g. Backup, Monitoring, Antimalware protection" },
      type: { type: "string", description: "Alert type, e.g. NoBackupForXDays" },
      query: { type: "string", description: "Part of the resource (machine) or plan name" },
      resource_id: { type: "string" },
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
    name: "list_tasks",
    description: "Task history (backup runs, recoveries, replications...), newest first, with result code and error. Filter by workload, plan, state (enqueued/started/completed...) and result (ok, warning, error, cancelled, abandoned, timedout).",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      resource_id: { type: "string" },
      resource_name: { type: "string", description: "Part of the workload name" },
      plan_name: { type: "string", description: "Part of the protection plan name" },
      state: { type: "string" },
      result: { type: "string", description: "One or more result codes, comma-separated" },
      type: { type: "string", description: "Task type" },
      since: { type: "string", description: "Completed since: ISO or 24h / 7d" },
      limit: { type: "number", description: "default 20, max 200" },
      full: FULL,
    } },
  },
  {
    name: "list_activities",
    description: "Activities (steps) of one task, with their result and error details - use to see why a backup failed.",
    inputSchema: { type: "object", properties: {
      task_id: { type: "string" },
      tenant: TENANT,
      limit: { type: "number", description: "default 50, max 200" },
    }, required: ["task_id"] },
  },
  {
    name: "list_agents",
    description: "Protection agents: hostname, online, version, OS, tenant. Filter by name, online state, up_to_date.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      name: { type: "string", description: "Part of the hostname" },
      online: { type: "boolean" },
      up_to_date: { type: "boolean" },
      os_family: { type: "string", enum: ["WINDOWS", "LINUX", "MACOSX", "SOLARIS", "UNKNOWN"] },
      limit: { type: "number", description: "Max rows returned (default 100)" },
      full: FULL,
    } },
  },
  {
    name: "list_protection_plans",
    description: "Protection plans (backup, antimalware, patching...) with enabled state and, if include_resources, which workloads each covers.",
    inputSchema: { type: "object", properties: {
      tenant: TENANT,
      search: { type: "string", description: "Part of the plan name" },
      include_resources: { type: "boolean" },
      full: FULL,
    } },
  },
  {
    name: "list_backups",
    description: "Recovery points of one workload, newest first: time, size, type, validation and malware scan result.",
    inputSchema: { type: "object", properties: {
      resource_id: { type: "string", description: "Workload id from list_workloads / get_backup_status" },
      tenant: TENANT,
      limit: { type: "number", description: "default 10" },
      full: FULL,
    }, required: ["resource_id"] },
  },
  {
    name: "list_archives",
    description: "Backup archives (backup sets) of one workload or plan, with storage size.",
    inputSchema: { type: "object", properties: {
      resource_id: { type: "string" },
      plan_id: { type: "string" },
      tenant: TENANT,
      limit: { type: "number", description: "default 20" },
    } },
  },
  {
    name: "acronis_api_get",
    description: "Read-only escape hatch: GET any Acronis Cyber Platform path under /api, e.g. /2/tenants/{id}, /alert_manager/v1/types?os_type=windows, /policy_management/v4/applications, /resource_management/v4/resources. Query params as an object; tenant sets the X-Apigw-Tenant-Id scope. Token/secret/password paths are refused. 60K cap.",
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
      let rows = await allTenants(env);
      if (kind !== "all") rows = rows.filter((t) => t.kind === kind);
      if (!args.include_disabled) rows = rows.filter((t) => t.enabled !== false);
      if (args.name) rows = rows.filter((t) => (t.name || "").toLowerCase().includes(String(args.name).toLowerCase()));
      const names = new Map((await allTenants(env)).map((t) => [t.id, t.name]));
      rows.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      return out({ count: rows.length, customers: rows.map((t) => ({ name: t.name, id: t.id, kind: t.kind, enabled: t.enabled, parent: names.get(t.parent_id || "") })) });
    }

    case "get_tenant": {
      const t = (await tenantArg(env, args, true))!;
      const r = await api(env, `/2/tenants/${t.id}`);
      if (args.full) return out(r);
      return out({
        id: r.id, name: r.name, kind: r.kind, enabled: r.enabled, customer_type: r.customer_type,
        parent: (await tenantName(env, r.parent_id)) ?? r.parent_id, mfa_status: r.mfa_status,
        pricing_mode: r.pricing_mode, created_at: r.created_at, contact: cap(r.contact, 800),
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
      return out({ tenant: t.name, usages: rows.length || !r?.items ? rows : "no non-zero usage rows - call again with full: true", });
    }

    case "list_workloads":
    case "get_backup_status": {
      const t = await tenantArg(env, args, name === "get_backup_status");
      const nameQ = args.name ? String(args.name).toLowerCase() : undefined;
      const loadWorkloads = async () => {
        const { items, truncated } = await allPages(env, "/resource_management/v4/resource_statuses", { tenant_id: t?.id, type: args.type, limit: 200 });
        let rows = items;
        if (nameQ) rows = rows.filter((i: any) => `${i.context?.name || ""} ${i.context?.user_defined_name || ""}`.toLowerCase().includes(nameQ));
        return { rows, truncated };
      };

      if (name === "list_workloads") {
        let { rows, truncated } = await loadWorkloads();
        if (args.only_problems) rows = rows.filter((i: any) => PROBLEM_STATUSES.includes(String(i.aggregate?.status)));
        const limit = clampLimit(args.limit, 100, 1000);
        if (args.full) return out({ count: rows.length, items: rows.slice(0, limit) });
        const slim = await Promise.all(rows.slice(0, limit).map((i: any) => slimWorkload(env, i)));
        return out({ tenant: t?.name, count: rows.length, returned: slim.length, truncated, workloads: slim });
      }

      // get_backup_status: each part reports its own error instead of failing the whole answer.
      const settle = async <T>(f: () => Promise<T>): Promise<T | { error: string }> => { try { return await f(); } catch (e) { return { error: (e as Error).message }; } };
      const [wl, agents, alerts] = await Promise.all([
        settle(loadWorkloads),
        settle(() => allPages(env, "/agent_manager/v2/agents", { tenant_id: t!.id, limit: 100 }, undefined, 5)),
        settle(() => api(env, "/alert_manager/v1/alerts", { tenant: t!.id, severity: "or(warning,error,critical)", order: "desc(updated_at)", limit: 50 })),
      ]);
      const result: Record<string, unknown> = { tenant: t!.name, tenant_id: t!.id, checked_at: iso(Date.now()) };
      if ("error" in wl) result.workloads = wl;
      else {
        const slim = await Promise.all(wl.rows.map((i: any) => slimWorkload(env, i)));
        const counts: Record<string, number> = {};
        for (const w of slim) counts[String(w.status)] = (counts[String(w.status)] || 0) + 1;
        const problems = slim.filter((w) => PROBLEM_STATUSES.includes(String(w.status)));
        const rest = slim.filter((w) => !PROBLEM_STATUSES.includes(String(w.status)));
        result.workload_status_counts = counts;
        result.workloads_with_problems = problems;
        result.other_workloads = rest.slice(0, 150);
        if (rest.length > 150 || wl.truncated) result.workloads_note = "list cut short - use list_workloads with name for one machine";
      }
      if ("error" in agents) result.agents = agents;
      else {
        let rows = agents.items;
        if (nameQ) rows = rows.filter((a: any) => String(a.hostname || a.name || "").toLowerCase().includes(nameQ));
        result.agents_total = rows.length;
        result.agents_offline = rows.filter((a: any) => a.online === false).map(slimAgent);
      }
      if ("error" in alerts) result.open_alerts = alerts;
      else {
        let rows = alerts?.items || [];
        if (nameQ) rows = rows.filter((a: any) => JSON.stringify(a.details || {}).toLowerCase().includes(nameQ));
        result.open_alerts = await Promise.all(rows.map((a: any) => slimAlert(env, a)));
      }
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
      const rows = (r?.items || []).filter((x: any) => Number(x.alerts_count) > 0)
        .sort((a: any, b: any) => Number(b.alerts_count) - Number(a.alerts_count))
        .map((x: any) => ({ customer: x.customer_name, tenant_id: x.customer_id, alerts: x.alerts_count }));
      return out({ customers_with_alerts: rows.length, items: rows });
    }

    case "list_tasks": {
      const t = await tenantArg(env, args, false);
      const since = sinceMs(args.since);
      const like = (v: unknown) => (v === undefined ? undefined : String(v).includes("%") ? `like(${v})` : `like(%${v}%)`);
      const limit = clampLimit(args.limit, 20, 200);
      const r = await api(env, "/task_manager/v2/tasks", {
        resourceId: pick(args, "resource_id"), resourceName: like(pick(args, "resource_name")), policyName: like(pick(args, "plan_name")),
        state: args.state, resultCode: orFilter(args.result), type: args.type,
        completedAt: since !== undefined ? `gt(${iso(since)})` : undefined,
        order: "desc(enqueuedAt)", lod: "full", limit,
      }, t?.id);
      let items = r?.items || [];
      const before = items.length;
      if (t) items = items.filter((x: any) => sameTenant(x, t.id));
      if (args.full) return out({ ...r, items });
      return out({ tenant: t?.name, count: items.length, other_tenants_dropped: before - items.length || undefined, tasks: items.map(slimTask) });
    }

    case "list_activities": {
      const t = await tenantArg(env, args, false);
      const taskId = String(pick(args, "task_id") ?? "");
      if (!taskId) throw new Error("task_id is required");
      const r = await api(env, "/task_manager/v2/activities", { taskId, lod: "full", limit: clampLimit(args.limit, 50, 200) }, t?.id);
      return out({ count: (r?.items || []).length, activities: (r?.items || []).map((a: any) => cap(a, 2500)) });
    }

    case "list_agents": {
      const t = await tenantArg(env, args, false);
      const { items, truncated } = await allPages(env, "/agent_manager/v2/agents", { tenant_id: t?.id, online: args.online, up_to_date: args.up_to_date, os_family: args.os_family, limit: 100 }, undefined, 10);
      let rows = items;
      if (args.name) rows = rows.filter((a: any) => String(a.hostname || a.name || "").toLowerCase().includes(String(args.name).toLowerCase()));
      const limit = clampLimit(args.limit, 100, 1000);
      if (args.full) return out({ count: rows.length, items: rows.slice(0, limit) });
      return out({ tenant: t?.name, count: rows.length, truncated, agents: rows.slice(0, limit).map(slimAgent) });
    }

    case "list_protection_plans": {
      const t = await tenantArg(env, args, false);
      const { items, truncated } = await allPages(env, "/policy_management/v4/policies", { tenant_id: t?.id, search: args.search, include_applied_context: args.include_resources ? true : undefined, limit: 100 }, undefined, 5);
      if (args.full) return out({ count: items.length, items });
      return out({ tenant: t?.name, count: items.length, truncated, plans: items.map(slimPlan) });
    }

    case "list_backups": {
      const t = await tenantArg(env, args, false);
      const id = String(pick(args, "resource_id") ?? "");
      if (!id) throw new Error("resource_id is required");
      const r = await api(env, "/vault_manager/v1/backups", { resourceId: id, limit: 500 }, t?.id);
      const items = (r?.items || []).sort((a: any, b: any) => String(b.created).localeCompare(String(a.created))).slice(0, clampLimit(args.limit, 10, 500));
      if (args.full) return out({ count: items.length, items });
      return out({ count: items.length, newest_first: items.map((b: any) => ({
        created: b.created, type: b.type ?? b.backup_type, size: b.size, original_data_size: b.original_data_size,
        validation: b.validation_status, malware_scan: b.malware_assessment_result, deleted: b.deleted || undefined,
        backup_id: b.backup_id ?? b.id, archive_id: b.archive_id,
      })) });
    }

    case "list_archives": {
      const t = await tenantArg(env, args, false);
      if (!args.resource_id && !args.plan_id) throw new Error("Pass resource_id or plan_id");
      const r = await api(env, "/vault_manager/v1/archives", { resourceId: args.resource_id, backupPlanId: args.plan_id, includeStats: true, limit: clampLimit(args.limit, 20, 200) }, t?.id);
      return out({ count: (r?.items || []).length, archives: (r?.items || []).map((a: any) => ({
        id: a.id, name: a.name, created: a.created, updated: a.updated, size: a.size, type: a.type, consistent: a.consistent, deleted: a.deleted || undefined, stats: cap(a.stats, 600),
      })) });
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
    const configured = Boolean(env.ACRONIS_BASE_URL && env.ACRONIS_CLIENT_ID && env.ACRONIS_CLIENT_SECRET && env.MCP_AUTH_TOKEN);
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", configured }), { headers: JSON_HEADERS });
    // Fail closed: the API client sees every customer's backups.
    if (!configured) {
      return new Response(JSON.stringify({ error: "acronis-mcp is not configured: set ACRONIS_BASE_URL (var) and the ACRONIS_CLIENT_ID, ACRONIS_CLIENT_SECRET and MCP_AUTH_TOKEN secrets." }), { status: 503, headers: JSON_HEADERS });
    }
    const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN!)) {
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
