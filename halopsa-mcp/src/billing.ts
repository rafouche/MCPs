// Billing administration tools, served ONLY on POST /billing/mcp (see index.ts).
// Roger, 2026-10-12: write access to recurring invoices, contracts, clients,
// items, software licences and a few billing settings, without giving the
// Help Desk agent (Allie, on /mcp with MCP_AUTH_TOKEN) anything new. The /mcp
// tool list is unchanged; this route has its own token (BILLING_MCP_AUTH_TOKEN)
// and its own Halo API application (HALO_BILLING_CLIENT_ID/SECRET). No
// fallback to the ticket credentials: without the billing secrets every tool
// here errors.
//
// Safety on every write: dry_run defaults to true (shows method, path, body
// and the current record; sends nothing); a real write needs dry_run:false AND
// confirm equal to the target path; afterwards the record is read back and a
// field-level diff returned; every real write is audited (Workers Logs line
// "BILLING_AUDIT {...}" always, plus KV BILLING_AUDIT when bound); bulk calls
// cap at 50 records. Write paths come from BILLING_WRITE_PATHS (config), and
// some things are refused whatever the config says (HARD_DENY, secret-bearing
// fields, /Control keys outside BILLING_CONTROL_KEYS, deleting a posted or
// QuickBooks-synced invoice).
import { HALO_FIELDS } from "./billing-schema";

export interface BillingEnv {
  HALO_BASE_URL: string;
  HALO_BILLING_CLIENT_ID?: string;
  HALO_BILLING_CLIENT_SECRET?: string;
  HALO_BILLING_SCOPE?: string;
  BILLING_WRITE_PATHS?: string;
  BILLING_CONTROL_KEYS?: string;
  BILLING_AUDIT?: KVNamespace;
}

export interface CallerInfo {
  route: string;
  ip?: string | null;
  user_agent?: string | null;
  cf_ray?: string | null;
}

type Json = any;

export const MAX_BULK = 50;
const SHOW_BODY_CHARS = 20000;
const MAX_DIFF_ENTRIES = 300;

// Agents, roles, API applications and integration secrets: refused whatever
// BILLING_WRITE_PATHS says. Matched on the lower-cased first path segment
// (Halo's paths are case-insensitive, so "/agent" must not slip past "/Agent").
// /Pax8Details is an integration record but Roger allowlisted it; its secret
// fields are refused by SECRET_KEY below instead.
const HARD_DENY = /^(agent[a-z]*|roles|userroles|cabrole|xtyperole|[a-z]*rolemapping|softwarelicencerole|application|singlesignonapplication|logintoken|mcpconnection|[a-z]*integration[a-z]*|azuread[a-z]*|ldapconnection|[a-z]*mailbox[a-z]*|mailboxcredential|passwordfield|securesecretlink|[a-z]*webhook[a-z]*|licenseinfo|users|[a-z0-9]+details?)$/;
const HARD_DENY_EXCEPT = new Set(["pax8details"]);
// Any key like this, at any depth, is refused in a write body and redacted in
// every output. Checked against this tenant's schemas: every match in
// InvoiceHeader/InvoiceDetail/ContractHeader/Area/Item/Licence_List/Pax8Details
// is a real secret (client API secrets, Pax8 OAuth tokens, sagetoken...).
const SECRET_KEY = /(secret|password|passwd|passphrase|token|apikey|api_key|private_?key|code_verifier|credential)/i;
const SECRET_EXACT = new Set(["code", "_exchangecode"]);
// Embedded read-only objects Halo returns inside a record (a recurring
// invoice carries the whole client, including its QuickBooks connection).
// Dropped from outputs, never sent back.
const STRIP_FROM_OUTPUT = new Set(["client", "quickbooks_details"]);
// Fields Halo bumps on any save; shown separately in a post-write diff.
const VOLATILE = new Set(["last_modified", "lastmodified", "change_seq", "last_change_agent", "last_change_seq", "alastupdate", "date_updated", "last_synced"]);

function isSecretKey(k: string): boolean {
  return SECRET_KEY.test(k) || SECRET_EXACT.has(k);
}

function sanitize(v: Json): Json {
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === "object") {
    const out: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) {
      if (STRIP_FROM_OUTPUT.has(k) && x && typeof x === "object") continue;
      out[k] = isSecretKey(k) ? "[redacted]" : sanitize(x);
    }
    return out;
  }
  return v;
}

function findSecretKeys(v: Json, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => findSecretKeys(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (isSecretKey(k)) out.push(path ? `${path}.${k}` : k);
      findSecretKeys(x, path ? `${path}.${k}` : k, out);
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `\n... [truncated, ${text.length} chars total]` : text;
}

function listFromConfig(raw: string | undefined): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith("[")) {
    try { return (JSON.parse(t) as unknown[]).map((x) => String(x).trim()).filter(Boolean); } catch { return []; }
  }
  return t.split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- Halo client (billing credentials only) ----------

let tokenCache: { key: string; token: string; expires: number; scope: string | null } | null = null;

async function billingToken(env: BillingEnv): Promise<{ token: string; scope: string | null }> {
  if (!env.HALO_BILLING_CLIENT_ID || !env.HALO_BILLING_CLIENT_SECRET) {
    throw new Error("Billing tools are disabled: HALO_BILLING_CLIENT_ID and HALO_BILLING_CLIENT_SECRET are not set on this Worker. They are deliberately separate from the ticket credentials, which are never used here. See halopsa-mcp/README.md \"Billing tools\".");
  }
  const key = env.HALO_BILLING_CLIENT_ID;
  if (tokenCache && tokenCache.key === key && tokenCache.expires > Date.now() + 60_000) return { token: tokenCache.token, scope: tokenCache.scope };
  const res = await fetch(`${env.HALO_BASE_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.HALO_BILLING_CLIENT_ID, client_secret: env.HALO_BILLING_CLIENT_SECRET, scope: env.HALO_BILLING_SCOPE || "all" }).toString(),
  });
  if (!res.ok) throw new Error(`Billing auth failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number; scope?: string };
  tokenCache = { key, token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 600) * 1000, scope: j.scope ?? null };
  return { token: j.access_token, scope: tokenCache.scope };
}

async function haloRequest(env: BillingEnv, method: "GET" | "POST" | "DELETE", path: string, opts: { params?: Record<string, string>; body?: Json } = {}): Promise<{ status: number; data: Json }> {
  const { token } = await billingToken(env);
  const url = new URL(`${env.HALO_BASE_URL}/api${path}`);
  if (opts.params) for (const [k, v] of Object.entries(opts.params)) url.searchParams.set(k, v);
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${token}` } };
  if (opts.body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url.toString(), init);
  const text = await res.text();
  let data: Json = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data };
}

async function haloGetOk(env: BillingEnv, path: string, params?: Record<string, string>): Promise<Json> {
  const r = await haloRequest(env, "GET", path, { params });
  if (r.status < 200 || r.status >= 300) throw new Error(`GET ${path} failed (${r.status}): ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}`);
  return r.data;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  });
  await Promise.all(workers);
  return out;
}

// ---------- path rules ----------

function normalizePath(raw: unknown, what = "path"): string {
  const p = String(raw ?? "").trim();
  if (!p.startsWith("/") || p.length < 2) throw new Error(`${what} must start with '/', e.g. /RecurringInvoice.`);
  if (/\.\.|[?#%\\\s]|\/\//.test(p) || p.endsWith("/")) throw new Error(`${what} '${p}' is not allowed: no '..', '?', '#', '%', backslash, whitespace, '//' or trailing '/'.`);
  if (!p.split("/").slice(1).every((s) => /^-?[A-Za-z0-9_]+$/.test(s))) throw new Error(`${what} '${p}' has an invalid segment (letters, digits, '_' and a leading '-' for ids only).`);
  return p;
}

function rootOf(path: string): string {
  return path.split("/")[1].toLowerCase();
}

export function checkWritePath(env: BillingEnv, path: string): void {
  const root = rootOf(path);
  if (HARD_DENY.test(root) && !HARD_DENY_EXCEPT.has(root)) {
    throw new Error(`Refused: /${path.split("/")[1]} is never writable through these tools (agents, roles, API applications and integration secrets are hard-blocked regardless of BILLING_WRITE_PATHS).`);
  }
  const allowed = listFromConfig(env.BILLING_WRITE_PATHS).map((p) => p.replace(/^\//, "").split("/")[0].toLowerCase());
  if (!allowed.includes(root)) {
    throw new Error(`Refused: /${path.split("/")[1]} is not in BILLING_WRITE_PATHS (${listFromConfig(env.BILLING_WRITE_PATHS).join(", ") || "empty - nothing is writable"}). Add it in wrangler.jsonc vars to allow it.`);
  }
}

function controlKeys(env: BillingEnv): string[] {
  return listFromConfig(env.BILLING_CONTROL_KEYS);
}

function checkControlBody(env: BillingEnv, body: Json): void {
  if (!Array.isArray(body) || body.length !== 1 || !body[0] || typeof body[0] !== "object") throw new Error("/Control writes take a one-element array: [{ <setting>: <value>, ... }].");
  const allowed = new Set(controlKeys(env));
  const bad = Object.keys(body[0]).filter((k) => k !== "id" && !allowed.has(k));
  if (bad.length) throw new Error(`Refused: /Control key(s) ${bad.join(", ")} are not in BILLING_CONTROL_KEYS (${[...allowed].join(", ") || "empty"}).`);
}

function checkBodyShape(body: Json): void {
  if (!Array.isArray(body)) throw new Error("body must be a JSON array (Halo creates and updates by POSTing an array to the collection; an object with an existing id is an update).");
  if (body.length === 0) throw new Error("body is an empty array - nothing to send.");
  if (body.length > MAX_BULK) throw new Error(`body has ${body.length} records; the cap is ${MAX_BULK} per call.`);
  if (!body.every((o) => o && typeof o === "object" && !Array.isArray(o))) throw new Error("body must be an array of objects.");
}

function checkNoSecrets(body: Json): void {
  const secrets = findSecretKeys(body);
  if (secrets.length) throw new Error(`Refused: the body contains secret-bearing field(s) ${secrets.slice(0, 10).join(", ")}. Integration secrets and credentials are never written through these tools.`);
}

// ---------- validation against the tenant's schema ----------

function checkFields(object: keyof typeof HALO_FIELDS | string, fields: Record<string, Json>, current?: Record<string, Json> | null): void {
  const known = new Set<string>(HALO_FIELDS[object] ?? []);
  if (current) for (const k of Object.keys(current)) known.add(k);
  const unknown = Object.keys(fields).filter((k) => !known.has(k));
  if (unknown.length) {
    const hints = unknown.map((u) => {
      const lu = u.toLowerCase();
      const near = [...known].filter((k) => (k.length > 3 && (k.includes(lu) || lu.includes(k))) || editDistance(k, lu) <= 2).slice(0, 5);
      return near.length ? `${u} (did you mean: ${near.join(", ")}?)` : u;
    });
    throw new Error(`Unknown ${object} field(s): ${hints.join("; ")}. Field names come from this tenant's swagger plus the fields the current record actually carries.`);
  }
  const secrets = findSecretKeys(fields);
  if (secrets.length) throw new Error(`Refused: secret-bearing field(s) ${secrets.join(", ")}.`);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// ---------- diff ----------

type Change = { path: string; from: Json; to: Json };

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isIdList(a: Json): boolean {
  return Array.isArray(a) && a.length > 0 && a.every((x) => x && typeof x === "object" && "id" in x);
}

// mode "proposed": only keys present in b (what the body would set);
// mode "all": every key on either side (what actually changed).
function diff(a: Json, b: Json, path: string, out: Change[], mode: "proposed" | "all"): void {
  if (out.length >= MAX_DIFF_ENTRIES) return;
  if ((isIdList(a) || isIdList(b)) && (Array.isArray(a) || a == null) && (Array.isArray(b) || b == null)) {
    const A = new Map<string, Json>((a || []).map((x: Json) => [String(x.id), x]));
    const B = new Map<string, Json>((b || []).map((x: Json) => [String(x.id), x]));
    for (const [id, bx] of B) {
      if (!A.has(id)) out.push({ path: `${path}[id=${id}]`, from: undefined, to: "(added)" });
      else diff(A.get(id), bx, `${path}[id=${id}]`, out, mode);
    }
    for (const id of A.keys()) if (!B.has(id) && mode === "all") out.push({ path: `${path}[id=${id}]`, from: "(present)", to: "(removed)" });
    return;
  }
  const isObj = (x: Json) => x && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const keys = mode === "proposed" ? Object.keys(b) : [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (k === "id" || STRIP_FROM_OUTPUT.has(k)) continue;
      diff(a[k], b[k], path ? `${path}.${k}` : k, out, mode);
    }
    return;
  }
  if (!same(a, b)) out.push({ path, from: isSecretKeyPath(path) ? "[redacted]" : a, to: isSecretKeyPath(path) ? "[redacted]" : b });
}

function isSecretKeyPath(path: string): boolean {
  const last = path.split(".").pop() || "";
  return isSecretKey(last.replace(/\[.*$/, ""));
}

function splitVolatile(changes: Change[]): { changes: Change[]; volatile: Change[] } {
  const vol = (c: Change) => VOLATILE.has(c.path.split(".").pop() || "");
  return { changes: changes.filter((c) => !vol(c)), volatile: changes.filter(vol) };
}

// ---------- audit ----------

async function audit(env: BillingEnv, entry: Record<string, Json>): Promise<{ logged: boolean; kv_key: string | null; kv_error?: string }> {
  const safe = sanitize(entry);
  console.log("BILLING_AUDIT " + JSON.stringify(safe));
  if (!env.BILLING_AUDIT) return { logged: true, kv_key: null };
  const key = `audit:${safe.timestamp}:${crypto.randomUUID().slice(0, 8)}`;
  try {
    await env.BILLING_AUDIT.put(key, JSON.stringify(safe));
    return { logged: true, kv_key: key };
  } catch (e) {
    return { logged: true, kv_key: null, kv_error: (e as Error).message };
  }
}

// ---------- the one write path every tool goes through ----------

interface WritePlan {
  tool: string;
  method: "POST" | "DELETE";
  path: string;            // exact path sent; also what `confirm` must equal
  body?: Json;             // POST body (an array)
  recordPaths: string[];   // records to read before/after, e.g. /RecurringInvoice/-143
  readBack?: (env: BillingEnv) => Promise<Record<string, Json>>; // custom before/after reader (e.g. /Control keys only)
  preloaded?: Record<string, Json>; // "before" records the tool already read (sanitized), to avoid reading twice
  notes?: string[];
  proposedPerRecord?: Record<string, Json>; // recordPath -> object the body would set (for the before/after preview)
  extra?: Record<string, Json>;
}

async function readRecords(env: BillingEnv, plan: WritePlan): Promise<Record<string, Json>> {
  if (plan.readBack) return plan.readBack(env);
  const entries = await mapLimit(plan.recordPaths, 8, async (p) => {
    const r = await haloRequest(env, "GET", p);
    if (r.status === 404) return [p, null] as const;
    if (r.status < 200 || r.status >= 300) throw new Error(`GET ${p} failed (${r.status}): ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}`);
    return [p, sanitize(r.data)] as const;
  });
  return Object.fromEntries(entries);
}

export async function executeWrite(env: BillingEnv, plan: WritePlan, args: Record<string, Json>, caller: CallerInfo): Promise<Json> {
  // Re-checked here whatever the tool did, so no tool can skip them.
  checkWritePath(env, plan.path);
  if (plan.body !== undefined) checkNoSecrets(plan.body);
  if (rootOf(plan.path) === "control" && plan.method === "POST") checkControlBody(env, plan.body);
  const dryRun = args.dry_run !== false;
  const before = plan.preloaded ?? (await readRecords(env, plan));
  const bodyText = plan.body === undefined ? "" : JSON.stringify(plan.body);
  const bodyShown = plan.body === undefined ? undefined : (bodyText.length <= SHOW_BODY_CHARS || args.verbose === true ? plan.body : clip(JSON.stringify(plan.body, null, 1), SHOW_BODY_CHARS));

  // Before/after preview: for each record, only the fields the body sets.
  const preview: Record<string, Json> = {};
  for (const p of plan.recordPaths) {
    const proposed = plan.proposedPerRecord?.[p];
    if (!proposed) continue;
    const ch: Change[] = [];
    diff(before[p] ?? {}, sanitize(proposed), "", ch, "proposed");
    preview[p] = before[p] == null ? "(no current record - this creates one)" : ch.length ? ch : "(no field changes - the write would resend the current values)";
  }

  if (dryRun) {
    return {
      dry_run: true,
      sent: false,
      would_send: { method: plan.method, path: plan.path, body: bodyShown, body_bytes: bodyText.length, body_note: bodyText.length > SHOW_BODY_CHARS && args.verbose !== true ? "Body abbreviated for display; pass verbose:true to see it whole. The real write sends it whole." : undefined },
      would_change: plan.proposedPerRecord ? preview : undefined,
      current: args.verbose === true ? before : summarize(before),
      notes: plan.notes,
      ...plan.extra,
      to_apply: { dry_run: false, confirm: plan.path },
    };
  }

  if (String(args.confirm ?? "") !== plan.path) {
    throw new Error(`Not sent: a real write needs confirm: "${plan.path}" (the exact target path) together with dry_run: false. Got confirm: ${JSON.stringify(args.confirm ?? null)}.`);
  }

  const started = new Date().toISOString();
  let status = 0;
  let response: Json = null;
  let error: string | null = null;
  try {
    const r = await haloRequest(env, plan.method, plan.path, plan.body === undefined ? {} : { body: plan.body });
    status = r.status;
    response = r.data;
    if (status < 200 || status >= 300) error = `${plan.method} ${plan.path} failed (${status}): ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}`;
  } catch (e) {
    error = `${plan.method} ${plan.path} failed: ${(e as Error).message}`;
  }

  let created: string[] = [];
  if (!error && plan.method === "POST" && plan.recordPaths.length === 0 && plan.extra?.collection) {
    const items = Array.isArray(response) ? response : response && typeof response === "object" ? [response] : [];
    created = items.filter((x: Json) => x && x.id !== undefined).map((x: Json) => `${plan.extra!.collection}/${x.id}`);
  }
  const after = error ? {} : await readRecords(env, { ...plan, recordPaths: [...plan.recordPaths, ...created] }).catch((e) => ({ _read_back_error: (e as Error).message }));
  const changes: Change[] = [];
  for (const p of [...plan.recordPaths, ...created]) {
    const b = before[p] ?? null;
    const a = (after as Record<string, Json>)[p] ?? null;
    if (b && !a) changes.push({ path: p, from: "(present)", to: "(gone)" });
    else if (!b && a) changes.push({ path: p, from: "(none)", to: "(created)" });
    else diff(b, a, p, changes, "all");
  }
  const { changes: real, volatile } = splitVolatile(changes);

  const recordIds = [...plan.recordPaths, ...created].map((p) => p.split("/").pop());
  const auditResult = await audit(env, {
    timestamp: started,
    caller,
    tool: plan.tool,
    method: plan.method,
    path: plan.path,
    body: plan.body ?? null,
    http_status: status,
    record_ids: recordIds,
    ok: !error,
    error,
    changed_fields: real.length,
  });

  if (error) throw new Error(`${error}\n(audited: ${auditResult.kv_key ?? "Workers Logs only"})`);
  return {
    dry_run: false,
    sent: true,
    http_status: status,
    record_ids: recordIds,
    diff: real.length ? real : "(no field changed)",
    volatile_changes: volatile.length ? volatile : undefined,
    response: clip(JSON.stringify(sanitize(response)), 4000),
    after: args.verbose === true ? after : summarize(after as Record<string, Json>),
    audit: { timestamp: started, ...auditResult },
    notes: plan.notes,
  };
}

// A compact view of a record: identity and billing-relevant fields, line ids.
function summarize(records: Record<string, Json>): Record<string, Json> {
  const keep = ["id", "name", "client_id", "client_name", "disabled", "inactive", "posted", "qboid", "status", "status_name", "contract_id", "contract_ref", "total", "amountdue", "period", "invoiceday", "startdate", "nextcreationdate", "lastcreated", "requires_approval", "ref", "contracttype_name", "active", "accountsid", "recurringprice", "baseprice", "costprice", "income_account", "income_account_name", "nominalcode", "count", "item_id", "is_active", "tenant_name", "distributor"];
  const out: Record<string, Json> = {};
  for (const [p, r] of Object.entries(records)) {
    if (!r || typeof r !== "object" || p === "/Control") { out[p] = r; continue; }
    const s: Record<string, Json> = {};
    for (const k of keep) if (k in r) s[k] = r[k];
    if (Array.isArray(r.lines)) s.lines = r.lines.map((l: Json) => ({ id: l.id, item: l.item_shortdescription ?? l.item_name, qty: l.qty_order, unit_price: l.unit_price, net: l.net_amount, inactive: l.isinactive }));
    out[p] = s;
  }
  return out;
}

// ---------- tool definitions ----------

const DRY = { dry_run: { type: "boolean", description: "Default true: show the exact request and the current record, send nothing." }, confirm: { type: "string", description: "Required with dry_run:false - the exact target path, as shown in the dry run's to_apply.confirm." }, verbose: { type: "boolean", description: "Show whole records and bodies instead of the compact view." } };

export const BILLING_TOOLS = [
  { name: "billing_healthcheck", description: "Billing route status: whether the billing Halo credentials work, which scopes Halo granted the token, the configured write paths and /Control keys, and where audit entries go. Read-only.", inputSchema: { type: "object", properties: {} } },
  { name: "get_billing_audit", description: "Recent audit entries from KV BILLING_AUDIT (newest first). Every real write is also in Workers Logs as a 'BILLING_AUDIT {...}' line whether or not KV is bound. Read-only.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "Default 10, max 50." } } } },
  { name: "halo_api_post", description: "POST any allowlisted Halo collection (BILLING_WRITE_PATHS). Halo creates and updates by POSTing a JSON ARRAY of objects to the collection; an object with an existing id is an update. body is passed through as given (max 50 records, no secret fields). /Control is limited to BILLING_CONTROL_KEYS. Note for /RecurringInvoice: send the template's complete `lines` with any header update (update_recurring_invoice does this for you) - whether Halo replaces or merges lines on POST is not verified.", inputSchema: { type: "object", properties: { path: { type: "string", description: "e.g. /RecurringInvoice, /ClientContract, /Client, /Item, /SoftwareLicence, /Control, /Invoice, /RecurringInvoice/process" }, body: { type: "array", description: "JSON array as Halo expects it" }, ...DRY }, required: ["path", "body"] } },
  { name: "halo_api_delete", description: "DELETE one record of an allowlisted Halo collection: DELETE {path}/{id}. Refused for an /Invoice that is posted or has a qboid (synced to QuickBooks) - void it in QBO instead - and for /Control.", inputSchema: { type: "object", properties: { path: { type: "string", description: "The collection, e.g. /RecurringInvoice" }, id: { type: "number" }, ...DRY }, required: ["path", "id"] } },
  { name: "set_recurring_invoice_active", description: "Enable or disable recurring invoice templates (Halo field `disabled` on /RecurringInvoice). Resends each template's complete current lines unchanged so no line can be dropped. Max 50 ids.", inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "number" }, description: "Template ids (negative numbers in Halo, e.g. -143)" }, active: { type: "boolean" }, ...DRY }, required: ["ids", "active"] } },
  { name: "create_recurring_invoice", description: "Create a recurring invoice template for a client. Created DISABLED unless active:true, so nothing invoices before you review it. header = any InvoiceHeader fields (period, invoiceday, startdate, enddate, pdftemplate_id, requires_approval, ...); lines = InvoiceDetail objects (item_shortdescription, qty_order, unit_price, _itemid, recurring_invoice_quantity_type, quantity_* ...).", inputSchema: { type: "object", properties: { client_id: { type: "number" }, contract_id: { type: "number" }, header: { type: "object" }, lines: { type: "array", items: { type: "object" } }, active: { type: "boolean", description: "Default false (created disabled)." }, ...DRY }, required: ["client_id", "lines"] } },
  { name: "update_recurring_invoice", description: "Update a recurring invoice template's header fields and/or lines. Always reads the template and sends its COMPLETE line set: `lines` entries with an id patch that existing line (only the fields given), entries without an id are added. Lines cannot be removed with this tool (Halo's replace-vs-merge behaviour for omitted lines is not verified).", inputSchema: { type: "object", properties: { id: { type: "number" }, fields: { type: "object", description: "Header fields to set (not lines)" }, lines: { type: "array", items: { type: "object" }, description: "Line patches: {id, ...fields} or a new line without id" }, ...DRY }, required: ["id"] } },
  { name: "update_recurring_invoice_line", description: "Change fields on one line of a recurring invoice template (reads the full line set, changes that one line, sends all lines).", inputSchema: { type: "object", properties: { invoice_id: { type: "number" }, line_id: { type: "number" }, fields: { type: "object" }, ...DRY }, required: ["invoice_id", "line_id", "fields"] } },
  { name: "update_contract", description: "Update a client contract (/ClientContract - this tenant has no /Contract). fields = ContractHeader fields, e.g. status, contract_status, active, end_date. Halo's value for 'Live' is not documented in the swagger; check an existing live contract's fields with halo_api_get first.", inputSchema: { type: "object", properties: { id: { type: "number" }, fields: { type: "object" }, ...DRY }, required: ["id", "fields"] } },
  { name: "update_client", description: "Update a client (/Client), e.g. accountsid, inactive. Note: the wallboard hides tickets of inactive clients.", inputSchema: { type: "object", properties: { id: { type: "number" }, fields: { type: "object" }, ...DRY }, required: ["id", "fields"] } },
  { name: "update_item", description: "Update a product/item (/Item), e.g. recurringprice, recurringcost, baseprice, costprice, income_account, nominalcode, update_recurring_invoice_price. This tenant's Item schema has no `inactive` field.", inputSchema: { type: "object", properties: { id: { type: "number" }, fields: { type: "object" }, ...DRY }, required: ["id", "fields"] } },
  { name: "upsert_software_licence", description: "Set the count on a client's software licence (/SoftwareLicence), creating it if no licence with that id/name exists for the client. Finds by id, else by exact name (case-insensitive). Warns when the licence is synced from a distributor (e.g. PAX8), whose next sync overwrites count.", inputSchema: { type: "object", properties: { client_id: { type: "number" }, id: { type: "number" }, name: { type: "string" }, count: { type: "number" }, item_id: { type: "number" }, fields: { type: "object", description: "Other Licence fields" }, ...DRY }, required: ["client_id", "count"] } },
  { name: "update_halo_settings", description: "Change billing settings in /Control, limited to BILLING_CONTROL_KEYS (default: autocreaterecurringinvoices, autosendemailforautorinvoices, automaticallysendinvoiceemails, enableinvoiceapprovals, mergerecurringinvoices). Reads and shows only those keys.", inputSchema: { type: "object", properties: { keys: { type: "object", description: "{ setting: value }" }, ...DRY }, required: ["keys"] } },
  { name: "create_invoice_from_recurring", description: "Generate invoices now from recurring templates via POST /RecurringInvoice/process (body: array of template ids, per the swagger; its exact behaviour is not verified). Can create real invoices that sync to QuickBooks and may email clients if Halo's auto-send settings are on - the dry run shows those settings. Max 50 ids.", inputSchema: { type: "object", properties: { recurring_invoice_ids: { type: "array", items: { type: "number" } }, ...DRY }, required: ["recurring_invoice_ids"] } },
];

// ---------- tool implementations ----------

function asObj(v: Json, name: string): Record<string, Json> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object.`);
  return v as Record<string, Json>;
}

function asIds(v: Json, name: string): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${name} must be a non-empty array of numbers.`);
  if (v.length > MAX_BULK) throw new Error(`${name} has ${v.length} ids; the cap is ${MAX_BULK} per call.`);
  const ids = v.map((x) => Number(x));
  if (ids.some((x) => !Number.isInteger(x))) throw new Error(`${name} must contain whole numbers.`);
  return [...new Set(ids)];
}

function intArg(v: Json, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number.`);
  return n;
}

async function getRecurring(env: BillingEnv, id: number): Promise<Json> {
  const r = await haloGetOk(env, `/RecurringInvoice/${id}`);
  if (!r || r.id === undefined) throw new Error(`Recurring invoice ${id} not found.`);
  if (r.is_recurring_invoice === false) throw new Error(`${id} is not a recurring invoice template.`);
  return r;
}

function stripForSend(line: Json): Json {
  // Lines are sent back as Halo returned them (the same object Halo's own UI
  // posts), minus embedded objects that are display-only.
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(line)) if (!STRIP_FROM_OUTPUT.has(k)) out[k] = v;
  return out;
}

async function settingsReader(env: BillingEnv, keys: string[]): Promise<Record<string, Json>> {
  const c = await haloGetOk(env, "/Control");
  const row = Array.isArray(c) ? c[0] : c;
  const picked: Record<string, Json> = {};
  for (const k of keys) picked[k] = row?.[k];
  return { "/Control": picked };
}

export async function runBillingTool(name: string, args: Record<string, Json>, env: BillingEnv, caller: CallerInfo): Promise<string> {
  const out = (v: Json) => JSON.stringify(v, null, 2);
  switch (name) {
    case "billing_healthcheck": {
      const paths = listFromConfig(env.BILLING_WRITE_PATHS);
      const base = { write_paths: paths, control_keys: controlKeys(env), audit: env.BILLING_AUDIT ? "Workers Logs + KV BILLING_AUDIT" : "Workers Logs only (KV BILLING_AUDIT not bound)", requested_scope: env.HALO_BILLING_SCOPE || "all" };
      try {
        tokenCache = null;
        const t = await billingToken(env);
        return out({ ok: true, instance: env.HALO_BASE_URL, granted_scope: t.scope, ...base });
      } catch (e) {
        return out({ ok: false, error: (e as Error).message, ...base });
      }
    }
    case "get_billing_audit": {
      if (!env.BILLING_AUDIT) return out({ kv: "not bound", note: "Real writes are still logged to Workers Logs as 'BILLING_AUDIT {...}' lines (Cloudflare dashboard > Workers > halopsa-mcp > Logs)." });
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
      const list = await env.BILLING_AUDIT.list({ prefix: "audit:" });
      const keys = list.keys.map((k) => k.name).sort().reverse().slice(0, limit);
      const entries = await Promise.all(keys.map(async (k) => ({ key: k, entry: JSON.parse((await env.BILLING_AUDIT!.get(k)) || "null") })));
      return out({ count: entries.length, entries });
    }

    case "halo_api_post": {
      const path = normalizePath(args.path);
      checkWritePath(env, path);
      const body = args.body;
      const isProcess = path.toLowerCase() === "/recurringinvoice/process";
      if (isProcess) asIds(body, "body");
      else checkBodyShape(body);
      const root = rootOf(path);
      const single = path.split("/").length === 2;
      const notes: string[] = [];
      if (root === "control") {
        checkControlBody(env, body);
        const keys = Object.keys((body as Json[])[0]).filter((k) => k !== "id");
        return out(await executeWrite(env, { tool: name, method: "POST", path, body, recordPaths: ["/Control"], readBack: (e) => settingsReader(e, keys), proposedPerRecord: { "/Control": Object.fromEntries(keys.map((k) => [k, (body as Json[])[0][k]])) } }, args, caller));
      }
      const ids = !single || isProcess ? [] : (body as Json[]).filter((o) => o.id !== undefined && o.id !== null && o.id !== 0).map((o) => intArg(o.id, "body[].id"));
      const recordPaths = ids.map((id) => `${path}/${id}`);
      const proposed: Record<string, Json> = {};
      if (single && !isProcess) for (const o of body as Json[]) if (o.id) proposed[`${path}/${o.id}`] = o;
      if (root === "recurringinvoice" && single && (body as Json[]).some((o) => o.id && !Array.isArray(o.lines))) notes.push("A /RecurringInvoice update without `lines`: whether Halo keeps or clears the existing lines in that case is not verified. update_recurring_invoice / set_recurring_invoice_active resend the complete line set instead.");
      if (!single) notes.push(`${path} is a sub-path: no current record is read and no diff is computed for it.`);
      const creates = single && !isProcess ? (body as Json[]).filter((o) => !o.id).length : 0;
      return out(await executeWrite(env, { tool: name, method: "POST", path, body, recordPaths, proposedPerRecord: proposed, notes, extra: creates ? { collection: path, creates } : undefined }, args, caller));
    }

    case "halo_api_delete": {
      const path = normalizePath(args.path);
      if (path.split("/").length !== 2) throw new Error("path must be the collection only, e.g. /RecurringInvoice; pass the record id in `id`.");
      checkWritePath(env, path);
      const id = intArg(args.id, "id");
      const root = rootOf(path);
      if (root === "control") throw new Error("Refused: /Control cannot be deleted.");
      const target = `${path}/${id}`;
      const notes: string[] = [];
      if (root === "invoice") {
        const inv = await haloGetOk(env, target);
        const qbo = inv?.qboid;
        if (inv?.posted === true || (qbo !== undefined && qbo !== null && qbo !== 0 && qbo !== "" && qbo !== "0")) {
          throw new Error(`Refused: invoice ${id} is ${inv?.posted ? "posted" : "not posted"}${qbo ? ` and synced to QuickBooks (qboid ${qbo})` : ""}. Deleting it here would leave QuickBooks out of step - void it in QBO instead.`);
        }
        notes.push(`Invoice ${id} is not posted and has no qboid, so the QuickBooks block does not apply.`);
      }
      const plan: WritePlan = { tool: name, method: "DELETE", path: target, recordPaths: [target], notes };
      return out(await executeWrite(env, plan, args, caller));
    }

    case "set_recurring_invoice_active": {
      const ids = asIds(args.ids, "ids");
      if (typeof args.active !== "boolean") throw new Error("active must be true or false.");
      checkWritePath(env, "/RecurringInvoice");
      const templates = await mapLimit(ids, 8, (id) => getRecurring(env, id));
      const body = templates.map((t) => ({ id: t.id, disabled: !args.active, lines: (t.lines || []).map(stripForSend) }));
      const proposed = Object.fromEntries(templates.map((t) => [`/RecurringInvoice/${t.id}`, { disabled: !args.active }]));
      const already = templates.filter((t) => t.disabled === !args.active).map((t) => t.id);
      const notes = ["Each template is sent with its complete current line set, unchanged."];
      if (already.length) notes.push(`Already ${args.active ? "active" : "disabled"}: ${already.join(", ")} (resending the same value).`);
      const preloaded = Object.fromEntries(templates.map((t) => [`/RecurringInvoice/${t.id}`, sanitize(t)]));
      return out(await executeWrite(env, { tool: name, method: "POST", path: "/RecurringInvoice", body, recordPaths: templates.map((t) => `/RecurringInvoice/${t.id}`), proposedPerRecord: proposed, preloaded, notes }, args, caller));
    }

    case "create_recurring_invoice": {
      checkWritePath(env, "/RecurringInvoice");
      const clientId = intArg(args.client_id, "client_id");
      const header = asObj(args.header, "header");
      if ("id" in header) throw new Error("header must not contain id - this tool creates; use update_recurring_invoice to change an existing template.");
      if ("lines" in header) throw new Error("Pass lines in `lines`, not inside header.");
      checkFields("RecurringInvoice", header);
      if (!Array.isArray(args.lines) || args.lines.length === 0) throw new Error("lines must be a non-empty array of line objects.");
      if (args.lines.length > MAX_BULK) throw new Error(`At most ${MAX_BULK} lines per call.`);
      args.lines.forEach((l: Json, i: number) => { if (l && l.id) throw new Error(`lines[${i}] has an id - new lines must not.`); checkFields("InvoiceLine", asObj(l, `lines[${i}]`)); });
      const client = await haloGetOk(env, `/Client/${clientId}`);
      const record: Record<string, Json> = { ...header, client_id: clientId, disabled: args.active === true ? false : true, lines: args.lines };
      if (args.contract_id !== undefined) record.contract_id = intArg(args.contract_id, "contract_id");
      const notes = [`Client ${clientId}: ${client?.name ?? "?"}${client?.inactive ? " (INACTIVE)" : ""}.`, args.active === true ? "Created ACTIVE (active:true)." : "Created DISABLED - enable it with set_recurring_invoice_active after review."];
      return out(await executeWrite(env, { tool: name, method: "POST", path: "/RecurringInvoice", body: [record], recordPaths: [], notes, extra: { collection: "/RecurringInvoice", creates: 1 } }, args, caller));
    }

    case "update_recurring_invoice":
    case "update_recurring_invoice_line": {
      checkWritePath(env, "/RecurringInvoice");
      const isLine = name === "update_recurring_invoice_line";
      const id = intArg(isLine ? args.invoice_id : args.id, isLine ? "invoice_id" : "id");
      const fields = isLine ? {} : asObj(args.fields, "fields");
      const patches: Json[] = isLine ? [{ id: intArg(args.line_id, "line_id"), ...asObj(args.fields, "fields") }] : Array.isArray(args.lines) ? args.lines : args.lines == null ? [] : (() => { throw new Error("lines must be an array."); })();
      if ("lines" in fields || "id" in fields) throw new Error("fields must not contain lines or id - use the `lines` parameter for lines.");
      if (Object.keys(fields).length === 0 && patches.length === 0) throw new Error("Nothing to change: give fields and/or lines.");
      const t = await getRecurring(env, id);
      checkFields("RecurringInvoice", fields, t);
      const lines: Json[] = (t.lines || []).map(stripForSend);
      const byId = new Map<number, number>(lines.map((l, i) => [Number(l.id), i]));
      let added = 0;
      for (const [i, p] of patches.entries()) {
        const patch = asObj(p, `lines[${i}]`);
        if (patch.id) {
          const at = byId.get(Number(patch.id));
          if (at === undefined) throw new Error(`Line ${patch.id} is not on template ${id} (its lines: ${[...byId.keys()].join(", ") || "none"}).`);
          checkFields("InvoiceLine", patch, lines[at]);
          lines[at] = { ...lines[at], ...patch };
        } else {
          checkFields("InvoiceLine", patch);
          lines.push(patch);
          added++;
        }
      }
      const record = { id: t.id, ...fields, lines };
      const proposed = { [`/RecurringInvoice/${t.id}`]: { ...fields, lines: patches.filter((p: Json) => p.id) } };
      const notes = [`Sends all ${lines.length} lines (${lines.length - added} existing${added ? `, ${added} new - shown in the body, not in would_change` : ""}); lines not mentioned are resent unchanged.`];
      return out(await executeWrite(env, { tool: name, method: "POST", path: "/RecurringInvoice", body: [record], recordPaths: [`/RecurringInvoice/${t.id}`], proposedPerRecord: proposed, preloaded: { [`/RecurringInvoice/${t.id}`]: sanitize(t) }, notes }, args, caller));
    }

    case "update_contract":
    case "update_client":
    case "update_item": {
      const map: Record<string, [string, string]> = { update_contract: ["/ClientContract", "ClientContract"], update_client: ["/Client", "Client"], update_item: ["/Item", "Item"] };
      const [path, object] = map[name];
      checkWritePath(env, path);
      const id = intArg(args.id, "id");
      const fields = asObj(args.fields, "fields");
      if (Object.keys(fields).length === 0) throw new Error("fields is empty - nothing to change.");
      if ("id" in fields) throw new Error("Put the record id in `id`, not in fields.");
      const current = await haloGetOk(env, `${path}/${id}`);
      if (!current || current.id === undefined) throw new Error(`${path}/${id} not found.`);
      checkFields(object, fields, current);
      const notes: string[] = [];
      if (name === "update_client" && "inactive" in fields) notes.push("Setting inactive changes what the wallboard shows: its Tickets zone and other zones hide inactive clients.");
      return out(await executeWrite(env, { tool: name, method: "POST", path, body: [{ id, ...fields }], recordPaths: [`${path}/${id}`], proposedPerRecord: { [`${path}/${id}`]: fields }, preloaded: { [`${path}/${id}`]: sanitize(current) }, notes }, args, caller));
    }

    case "upsert_software_licence": {
      checkWritePath(env, "/SoftwareLicence");
      const clientId = intArg(args.client_id, "client_id");
      const count = Number(args.count);
      if (!Number.isFinite(count) || count < 0) throw new Error("count must be a number >= 0.");
      if (args.id === undefined && !args.name) throw new Error("Give the licence id or its name.");
      const fields = asObj(args.fields, "fields");
      if ("id" in fields || "client_id" in fields || "count" in fields) throw new Error("Use the id/client_id/count parameters, not fields, for those.");
      const list = await haloGetOk(env, "/SoftwareLicence", { client_id: String(clientId), count: "1000", includeinactive: "true" });
      const lics: Json[] = (list?.licences || []).filter((l: Json) => Number(l.client_id) === clientId);
      let found: Json = null;
      if (args.id !== undefined) {
        found = lics.find((l) => Number(l.id) === intArg(args.id, "id"));
        if (!found) throw new Error(`Licence ${args.id} does not belong to client ${clientId} (or does not exist).`);
      } else {
        const matches = lics.filter((l) => String(l.name).toLowerCase() === String(args.name).toLowerCase());
        if (matches.length > 1) throw new Error(`${matches.length} licences named "${args.name}" for client ${clientId} (ids ${matches.map((m) => m.id).join(", ")}) - pass id.`);
        found = matches[0] ?? null;
      }
      const set: Record<string, Json> = { ...fields, count };
      if (args.item_id !== undefined) set.item_id = intArg(args.item_id, "item_id");
      checkFields("SoftwareLicence", set, found);
      const notes: string[] = [];
      if (found && (found.distributor || found.tenant_name)) notes.push(`Licence ${found.id} is synced from ${found.distributor || found.tenant_name}: its next sync will likely overwrite count.`);
      if (found) {
        return out(await executeWrite(env, { tool: name, method: "POST", path: "/SoftwareLicence", body: [{ id: found.id, ...set }], recordPaths: [`/SoftwareLicence/${found.id}`], proposedPerRecord: { [`/SoftwareLicence/${found.id}`]: set }, preloaded: { [`/SoftwareLicence/${found.id}`]: sanitize(found) }, notes }, args, caller));
      }
      notes.push(`No licence named "${args.name}" for client ${clientId} - this creates one.`);
      return out(await executeWrite(env, { tool: name, method: "POST", path: "/SoftwareLicence", body: [{ client_id: clientId, name: String(args.name), ...set }], recordPaths: [], notes, extra: { collection: "/SoftwareLicence", creates: 1 } }, args, caller));
    }

    case "update_halo_settings": {
      checkWritePath(env, "/Control");
      const keys = asObj(args.keys, "keys");
      if (Object.keys(keys).length === 0) throw new Error("keys is empty.");
      checkControlBody(env, [keys]);
      checkFields("Control", keys);
      // Halo's settings are a single /Control row; send its id so the POST
      // updates that row (only the listed keys) rather than relying on Halo
      // to infer it.
      const c = await haloGetOk(env, "/Control");
      const rowId = (Array.isArray(c) ? c[0] : c)?.id;
      const body = [rowId !== undefined && rowId !== null ? { id: rowId, ...keys } : { ...keys }];
      return out(await executeWrite(env, { tool: name, method: "POST", path: "/Control", body, recordPaths: ["/Control"], readBack: (e) => settingsReader(e, Object.keys(keys)), proposedPerRecord: { "/Control": keys }, notes: [`Only these keys are read, shown or sent: ${Object.keys(keys).join(", ")}.`] }, args, caller));
    }

    case "create_invoice_from_recurring": {
      checkWritePath(env, "/RecurringInvoice");
      const ids = asIds(args.recurring_invoice_ids, "recurring_invoice_ids");
      const templates = await mapLimit(ids, 8, (id) => getRecurring(env, id));
      const settings = await settingsReader(env, ["autosendemailforautorinvoices", "automaticallysendinvoiceemails", "enableinvoiceapprovals", "mergerecurringinvoices"]).catch((e) => ({ error: (e as Error).message }));
      const notes = ["POST /RecurringInvoice/process is the swagger's only generate-now endpoint (body: array of template ids). What it does exactly is not verified - try it first on one enabled, low-value template.", "After a real run the diff on each template (lastcreated / nextcreationdate) shows whether it produced an invoice."];
      const disabled = templates.filter((t) => t.disabled).map((t) => t.id);
      if (disabled.length) notes.push(`Disabled templates in the list: ${disabled.join(", ")}.`);
      return out(await executeWrite(env, { tool: name, method: "POST", path: "/RecurringInvoice/process", body: ids, recordPaths: ids.map((id) => `/RecurringInvoice/${id}`), notes, extra: { invoice_email_settings: settings } }, args, caller));
    }

    default:
      throw new Error(`Unknown billing tool: ${name}`);
  }
}
