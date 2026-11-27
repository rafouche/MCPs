// Billing write tools (2026-11-27). Same Worker, same Halo API application and credentials as every other tool.
//
// NOT part of the Help Desk agent's allowlist: Allie's tools are an explicit list of names in
// rafouche/AllieService (src/Packs.HelpDesk/Generated/Upstream.g.cs) and none of these are in it; mcp-gateway hides
// them too (they are not in servers.json readTools).
//
// Rules every write here follows:
//  - dry_run defaults to TRUE. A dry run sends nothing; it returns the method, path and body that would be sent,
//    the current record, and the exact `confirm` string a real write needs.
//  - A real write needs dry_run: false AND confirm equal to the target path (e.g. "/RecurringInvoice/-143").
//  - After a real write the record is re-read (short retries for Halo's eventual consistency) and a field-level
//    diff is returned.
//  - Every real write, failed ones included, is recorded in KV (binding HALO_AUDIT). No binding = no writes.
//  - Which paths may be written, which may be deleted, which /Control keys, and the bulk size are CONFIG
//    (wrangler.jsonc vars), not code. An unset list allows nothing.
//  - Hard blocks that no config can lift: agents, roles, API applications, credentials, webhooks; secret-looking
//    fields in any body; deleting a posted or QuickBooks-synced invoice; /Control keys outside the allowlist.
//
// Halo facts this was built on (tenant swagger v2, read 2026-11-27) and what is still UNVERIFIED are in
// halopsa-mcp/README.md. Read that before trusting a line write.

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(opts: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
}
export interface BillingEnv {
  HALO_BASE_URL: string;
  HALO_CLIENT_ID: string;
  HALO_CLIENT_SECRET: string;
  HALO_WRITE_PATHS?: string; // comma-separated collection paths that accept POST
  HALO_DELETE_PATHS?: string; // comma-separated collection paths that accept DELETE /{id}
  HALO_CONTROL_KEYS?: string; // comma-separated /Control keys that may be written
  HALO_CONTROL_WRITES?: string; // "enabled" allows real /Control writes; anything else = dry run only
  HALO_BULK_MAX?: string; // records per call (default 20, never above 50)
  HALO_AUDIT?: KvLike;
}

const NOTE = " Not part of the Help Desk agent's allowlist.";
const SAFETY = " dry_run defaults to true (nothing is sent; you get the method, path, body and the current record). A real write needs dry_run: false and confirm set to the `confirm_to_send` value the dry run returns; it is then re-read, diffed field by field, and written to the audit log.";
const common = {
  dry_run: { type: "boolean", description: "Default true. false = really send (needs confirm)." },
  confirm: { type: "string", description: "The target path, exactly as the dry run's confirm_to_send shows it, e.g. '/RecurringInvoice/-143'." },
  full: { type: "boolean", description: "Return untrimmed records and bodies (large). Default: invoice lines are shown as a short summary." },
};
const fieldsProp = (what: string) => ({ type: "object", description: `Halo field names and new values for the ${what}, e.g. {"notes_1":"..."}. Only these are sent.` });

export const BILLING_TOOLS = [
  { name: "halo_api_post", description: "Billing write, generic: POST to one of the configured Halo collection paths (HALO_WRITE_PATHS). Halo creates and updates by POST to the collection with a JSON array; an object carrying an existing `id` is an update, without one it is a create. Pass one object or an array (bulk limit applies). Anything outside the configured paths is refused, as are agents/roles/API applications/credentials, secret-looking fields, and /Control keys outside the allowlist. Prefer the purpose-built tools for recurring invoice LINES: a `lines` array sent here is sent exactly as given." + SAFETY + NOTE, inputSchema: { type: "object", properties: { path: { type: "string", description: "Collection path, e.g. '/RecurringInvoice'" }, body: { description: "One object, or an array of objects" }, ...common }, required: ["path", "body"] } },
  { name: "halo_api_delete", description: "Billing write, generic: DELETE {path}/{id} on one of the configured delete paths (HALO_DELETE_PATHS). Refuses an invoice that is posted or has a QuickBooks id - void that in QuickBooks instead. There is no undo; the deleted record is kept in the audit entry." + SAFETY + NOTE, inputSchema: { type: "object", properties: { path: { type: "string", description: "Collection path, e.g. '/RecurringInvoice'" }, id: { type: "number" }, ...common }, required: ["path", "id"] } },
  { name: "set_recurring_invoice_active", description: "Enable or disable recurring invoice templates (Halo's `disabled` field; template ids are negative in this tenant, e.g. -138). Sends only {id, disabled} per template - lines are not sent and not touched." + SAFETY + NOTE, inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "number" }, description: "Template ids (bulk limit applies)" }, active: { type: "boolean", description: "true = enabled (disabled: false), false = disabled" }, ...common }, required: ["ids", "active"] } },
  { name: "create_recurring_invoice", description: "Create a recurring invoice template for a client. Created DISABLED unless active: true, so it cannot bill until someone enables it. `fields` are header fields; `lines` are the template's lines (each at least _itemid or item_code, qty_order, unit_price)." + SAFETY + NOTE, inputSchema: { type: "object", properties: { client_id: { type: "number" }, contract_id: { type: "number" }, fields: fieldsProp("template header"), lines: { type: "array", items: { type: "object" } }, active: { type: "boolean", description: "Default false: created disabled." }, ...common }, required: ["client_id"] } },
  { name: "update_recurring_invoice", description: "Update a recurring invoice template's header fields, and optionally REPLACE its whole line set. Without `lines`, no lines are sent or touched. With `lines` you must pass the COMPLETE set you want to end up with and replace_all_lines: true; existing lines keep their `id`, a line without an id is new, and the dry run lists every existing line your set leaves out. To change one line use update_recurring_invoice_line." + SAFETY + NOTE, inputSchema: { type: "object", properties: { id: { type: "number", description: "Template id (negative in this tenant)" }, fields: fieldsProp("template header"), lines: { type: "array", items: { type: "object" }, description: "The complete line set. Never a partial list." }, replace_all_lines: { type: "boolean", description: "Required with lines: confirms the list is the complete set." }, ...common }, required: ["id"] } },
  { name: "update_recurring_invoice_line", description: "Change fields on ONE line of a recurring invoice template (e.g. qty_order, unit_price, item_shortdescription). Reads the template's full current line set, applies the change to that line, and sends the complete set back, never a partial list." + SAFETY + NOTE, inputSchema: { type: "object", properties: { invoice_id: { type: "number", description: "Template id (negative in this tenant)" }, line_id: { type: "number" }, fields: fieldsProp("line"), ...common }, required: ["invoice_id", "line_id", "fields"] } },
  { name: "update_contract", description: "Update fields on a contract (POST /ClientContract)." + SAFETY + NOTE, inputSchema: { type: "object", properties: { id: { type: "number" }, fields: fieldsProp("contract"), ...common }, required: ["id", "fields"] } },
  { name: "update_client", description: "Update fields on a client (POST /Client)." + SAFETY + NOTE, inputSchema: { type: "object", properties: { id: { type: "number" }, fields: fieldsProp("client"), ...common }, required: ["id", "fields"] } },
  { name: "update_item", description: "Update fields on an item/product (POST /Item)." + SAFETY + NOTE, inputSchema: { type: "object", properties: { id: { type: "number" }, fields: fieldsProp("item"), ...common }, required: ["id", "fields"] } },
  { name: "upsert_software_licence", description: "Set a client's software licence count. With `id` it updates that licence. With `name` it looks for the client's licence of exactly that name: one match is updated, none creates it, several is an error (pass id)." + SAFETY + NOTE, inputSchema: { type: "object", properties: { client_id: { type: "number" }, id: { type: "number" }, name: { type: "string" }, count: { type: "number" }, item_id: { type: "number", description: "Halo item the licence bills as" }, fields: fieldsProp("licence"), ...common }, required: ["client_id"] } },
  { name: "update_halo_settings", description: "Change Halo's global settings (/Control), allowlisted keys only (HALO_CONTROL_KEYS). Sends only the keys given, then compares EVERY setting before and after and reports any other key that changed. Real writes stay off until HALO_CONTROL_WRITES is 'enabled' (see the README: a partial POST to /Control is not yet proven to leave other settings alone)." + SAFETY + NOTE, inputSchema: { type: "object", properties: { settings: { type: "object", description: "{ key: value }, e.g. {\"autocreaterecurringinvoices\": false}" }, ...common }, required: ["settings"] } },
  { name: "create_invoice_from_recurring", description: "Generate an invoice now from one recurring invoice template (POST /RecurringInvoice/process with the template id). UNVERIFIED on this tenant: Halo may email the invoice and sync it to QuickBooks according to its settings, and whether it respects the template's schedule is not known. The dry run shows the template and the auto-send settings." + SAFETY + NOTE, inputSchema: { type: "object", properties: { recurring_invoice_id: { type: "number" }, ...common }, required: ["recurring_invoice_id"] } },
  { name: "get_billing_audit", description: "Read the audit log of real billing writes made through this Worker, newest first: time, tool, method, path, record ids, body, HTTP status. `key` returns one entry in full, including the record as it was before the write." + NOTE, inputSchema: { type: "object", properties: { limit: { type: "number", description: "Default 10, max 20" }, key: { type: "string", description: "One entry's key, for the full entry" } } } },
];
const NAMES = new Set(BILLING_TOOLS.map((t) => t.name));
export const isBillingTool = (name: string) => NAMES.has(name);

// ---- plumbing -------------------------------------------------------------------------------------------------
type Ctx = { env: BillingEnv; token?: string; calls: number };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function token(c: Ctx): Promise<string> {
  if (c.token) return c.token;
  c.calls++;
  const res = await fetch(`${c.env.HALO_BASE_URL}/auth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.env.HALO_CLIENT_ID, client_secret: c.env.HALO_CLIENT_SECRET, scope: "all" }).toString() });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return (c.token = ((await res.json()) as { access_token: string }).access_token);
}
async function halo(c: Ctx, method: string, path: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; ok: boolean; text: string; json: any }> {
  const t = await token(c);
  const url = new URL(`${c.env.HALO_BASE_URL}/api${path}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  c.calls++;
  const res = await fetch(url.toString(), { method, headers: { Authorization: `Bearer ${t}`, ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, text, json };
}
async function read(c: Ctx, path: string, params?: Record<string, string>): Promise<any> {
  const r = await halo(c, "GET", path, { params });
  if (!r.ok) throw new Error(`GET ${path} failed (${r.status}): ${r.text.slice(0, 2000)}`);
  return r.json;
}
async function readOrNull(c: Ctx, path: string): Promise<any> {
  const r = await halo(c, "GET", path);
  return r.ok && r.json && typeof r.json === "object" && (r.json.id !== undefined || Object.keys(r.json).length > 0) ? r.json : null;
}

// ---- config and hard blocks -----------------------------------------------------------------------------------
const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const bulkMax = (env: BillingEnv) => Math.max(1, Math.min(50, Number(env.HALO_BULK_MAX) || 20));
// No config can allow these: agents, roles, API applications, credentials, tokens, webhooks, key vault.
const BLOCKED_PATH = /(agent|application|auth|role|keyvault|token|credential|password|secret|webhook)/i;
// Secret-looking field names are refused in any body (e.g. Pax8Details new_client_secret / new_access_token).
const SECRET_KEY = /(secret|password|passwd|token|apikey|api_key|_exchangecode|code_verifier|credential)/i;
function canonical(path: unknown, configured: string[], verb: string, varName: string): string {
  const p = String(path ?? "").trim().replace(/\/+$/, "");
  if (!p.startsWith("/") || p.includes("..") || p.includes("?") || p.includes("#")) throw new Error(`${verb}: path must be a collection path such as '/RecurringInvoice' (starts with '/', no '..', '?' or '#').`);
  if (BLOCKED_PATH.test(p)) throw new Error(`${verb}: ${p} is blocked. This Worker never writes to agents, roles, API applications, credentials or webhooks, whatever the config says.`);
  const hit = configured.find((x) => x.toLowerCase() === p.toLowerCase());
  if (!hit) throw new Error(`${verb}: ${p} is not in ${varName} (${configured.join(", ") || "empty: nothing is allowed"}). Give the collection path without an id. To allow another path, add it to ${varName} in halopsa-mcp/wrangler.jsonc.`);
  return hit;
}
function secretKeys(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => secretKeys(x, `${at}[${i}]`));
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (SECRET_KEY.test(k) ? [at ? `${at}.${k}` : k] : secretKeys(x, at ? `${at}.${k}` : k)));
}
function controlCheck(env: BillingEnv, item: Record<string, unknown>): void {
  const allowed = list(env.HALO_CONTROL_KEYS).map((k) => k.toLowerCase());
  const bad = Object.keys(item).filter((k) => !allowed.includes(k.toLowerCase()));
  if (bad.length) throw new Error(`/Control: ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not in HALO_CONTROL_KEYS (${allowed.join(", ") || "empty"}). Nothing was sent.`);
  if (!Object.keys(item).length) throw new Error("/Control: no settings given.");
}
function invoiceDeleteBlock(path: string, rec: any): string | null {
  if (!/^\/(invoice|recurringinvoice)$/i.test(path) || !rec) return null;
  const qbo = rec.qboid !== undefined && rec.qboid !== null && String(rec.qboid).trim() !== "" && String(rec.qboid).trim() !== "0";
  if (rec.posted === true || qbo) return `Invoice ${rec.id} is ${rec.posted === true ? "posted" : "synced to QuickBooks"}${qbo ? ` (qboid ${rec.qboid})` : ""}. It is not deleted from here: void it in QuickBooks instead.`;
  return null;
}

// ---- shaping what the caller sees ------------------------------------------------------------------------------
const LINE_KEYS = ["id", "ihid", "_itemid", "item_code", "item_shortdescription", "qty_order", "unit_price", "unit_cost", "net_amount", "tax_code", "isinactive", "sequenceid"];
const DROP_TOP = ["client", "quickbooks_details"]; // nested read-only copies of other records; never sent, never diffed
const VOLATILE = /(^|\.)(last_modified|last_change_agent|change_seq|alastupdate|auto_increase_last_date|token_expiry|lastupdate|dateupdated)$/i;
const lineSummary = (l: any) => Object.fromEntries(LINE_KEYS.filter((k) => l?.[k] !== undefined).map((k) => [k, l[k]]));
function slim(rec: any, full: boolean): any {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return rec;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (DROP_TOP.includes(k)) continue;
    if (k === "lines" && Array.isArray(v) && !full) { out.lines = v.map(lineSummary); out.lines_shown = "summary (full: true for every field)"; continue; }
    out[k] = v;
  }
  return out;
}
const strip = (rec: any) => (rec && typeof rec === "object" && !Array.isArray(rec) ? Object.fromEntries(Object.entries(rec).filter(([k]) => !DROP_TOP.includes(k))) : rec);
function flatten(v: unknown, at: string, out: Map<string, unknown>): void {
  if (Array.isArray(v)) {
    if (!v.length) { out.set(at, "[]"); return; }
    v.forEach((x, i) => flatten(x, `${at}[${x && typeof x === "object" && (x as any).id !== undefined ? `id=${(x as any).id}` : i}]`, out));
  } else if (v && typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>);
    if (!e.length) { out.set(at, "{}"); return; }
    for (const [k, x] of e) flatten(x, at ? `${at}.${k}` : k, out);
  } else out.set(at, v);
}
function diff(before: any, after: any): Array<{ field: string; before: unknown; after: unknown }> {
  const a = new Map<string, unknown>(), b = new Map<string, unknown>();
  flatten(strip(before) ?? {}, "", a); flatten(strip(after) ?? {}, "", b);
  const out: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k), y = b.get(k);
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field: k, before: x === undefined ? "(absent)" : x, after: y === undefined ? "(absent)" : y });
  }
  return out;
}
const same = (want: unknown, got: unknown) => JSON.stringify(want) === JSON.stringify(got) || (want !== null && got !== null && typeof want !== "object" && typeof got !== "object" && String(want) === String(got));
// Top-level primitive fields of a sent body that the re-read does not show.
function notApplied(sent: Record<string, unknown>, after: any): string[] {
  return Object.entries(sent).filter(([k, v]) => k !== "id" && !k.startsWith("_") && (v === null || typeof v !== "object") && after && k in after && !same(v, after[k])).map(([k]) => k);
}
function cap(o: unknown): string {
  const text = JSON.stringify(o, null, 2);
  return text.length > 60000 ? text.slice(0, 60000) + `\n... [truncated: ${text.length} characters in all. The complete entry is in the audit log (get_billing_audit).]` : text;
}

// ---- audit -----------------------------------------------------------------------------------------------------
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(x)]));
}
async function audit(env: BillingEnv, entry: Record<string, unknown>): Promise<{ key?: string; error?: string }> {
  const key = `audit:${String(9999999999999 - Date.now()).padStart(13, "0")}:${Math.random().toString(36).slice(2, 8)}`;
  try { await env.HALO_AUDIT!.put(key, JSON.stringify(redact(entry))); return { key }; } catch (e: any) { return { error: `AUDIT ENTRY WAS NOT SAVED: ${e?.message ?? e}` }; }
}

// ---- the one write path every tool goes through ----------------------------------------------------------------
type Plan = {
  tool: string;
  method: "POST" | "DELETE";
  path: string; // collection path as configured, or the full path for DELETE / process
  confirm: string; // what `confirm` must equal
  body?: unknown; // exactly what is sent
  shownBody?: unknown; // what the caller sees (lines summarised)
  readPaths: string[]; // records to read before and after
  sentById?: Record<string, Record<string, unknown>>; // read path -> the fields sent for it
  before?: Record<string, any>; // already-read records, by read path
  notes?: string[];
  expectGone?: boolean;
  blocked?: string; // a real write is refused with this message; the dry run still works
  afterHook?: (c: Ctx, res: any) => Promise<Record<string, unknown>>;
};
async function execute(c: Ctx, args: Record<string, unknown>, plan: Plan): Promise<string> {
  const full = args.full === true;
  const before: Record<string, any> = { ...(plan.before ?? {}) };
  for (const p of plan.readPaths) if (!(p in before)) before[p] = await readOrNull(c, p);
  if (args.dry_run !== false) {
    return cap({ dry_run: true, nothing_sent: true, tool: plan.tool, method: plan.method, path: plan.path, body: plan.method === "DELETE" ? undefined : full ? plan.body : plan.shownBody ?? plan.body, current: Object.fromEntries(Object.entries(before).map(([p, r]) => [p, slim(r, full)])), notes: plan.notes?.length ? plan.notes : undefined, confirm_to_send: plan.blocked ? undefined : plan.confirm, to_send: plan.blocked ? `Not possible yet: ${plan.blocked}.` : `Call again with dry_run: false and confirm: "${plan.confirm}".` });
  }
  if (plan.blocked) throw new Error(`${plan.tool}: ${plan.blocked}. Nothing was sent.`);
  if (String(args.confirm ?? "") !== plan.confirm) throw new Error(`${plan.tool}: confirm ${args.confirm === undefined ? "is missing" : `"${args.confirm}" does not match`}. This write needs confirm: "${plan.confirm}". Nothing was sent.`);
  if (!c.env.HALO_AUDIT) throw new Error(`${plan.tool}: the audit log (KV binding HALO_AUDIT) is not bound to this Worker, so no billing write is sent. Nothing was sent.`);
  const ids = plan.readPaths.map((p) => p.split("/").pop());
  // The rollback copy: the record itself, without the nested copies of other records (client, QuickBooks settings).
  const beforeAudit = Object.fromEntries(Object.entries(before).map(([p, r]) => [p, strip(r)]));
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), tool: plan.tool, method: plan.method, path: plan.path, record_ids: ids, body: plan.body ?? null };
  let res: { status: number; ok: boolean; text: string; json: any };
  try { res = await halo(c, plan.method, plan.path, { body: plan.body }); } catch (e: any) {
    const a = await audit(c.env, { ...entry, http_status: null, ok: false, error: String(e?.message ?? e), before: beforeAudit });
    throw new Error(`${plan.tool}: ${plan.method} ${plan.path} did not complete (${e?.message ?? e}). It may or may not have reached Halo - read the record before retrying. Audit: ${a.key ?? a.error}`);
  }
  // Re-read, with short waits: Halo can accept a write before it reads back.
  const after: Record<string, any> = {};
  const settled = (p: string) => (plan.expectGone ? after[p] === null : after[p] !== null && notApplied(plan.sentById?.[p] ?? {}, after[p]).length === 0);
  if (res.ok) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const todo = plan.readPaths.filter((p) => !(p in after) || !settled(p));
      if (!todo.length || c.calls + todo.length > 46) break; // the free plan allows 50 outbound calls per request
      if (attempt > 0) await sleep(1500);
      for (const p of todo) after[p] = await readOrNull(c, p);
    }
  }
  const created = res.ok && Array.isArray(res.json) ? res.json.map((x: any) => x?.id).filter((x: any) => x !== undefined) : res.ok && res.json && typeof res.json === "object" && res.json.id !== undefined ? [res.json.id] : [];
  const extra = res.ok && plan.afterHook ? await plan.afterHook(c, res.json).catch((e: any) => ({ after_check_error: String(e?.message ?? e) })) : {};
  const a = await audit(c.env, { ...entry, http_status: res.status, ok: res.ok, error: res.ok ? undefined : res.text.slice(0, 4000), response_ids: created.length ? created : undefined, before: beforeAudit });
  if (!res.ok) throw new Error(`${plan.tool}: ${plan.method} ${plan.path} failed (${res.status}): ${res.text.slice(0, 4000)} | Audit: ${a.key ?? a.error}`);
  const records = plan.readPaths.map((p) => {
    const d = diff(before[p], after[p]);
    const sent = plan.sentById?.[p] ?? {};
    const asked = new Set(Object.keys(sent));
    const na = plan.expectGone ? [] : notApplied(sent, after[p]);
    const unexpected = d.filter((x) => !VOLATILE.test(x.field) && !asked.has(x.field.split(/[.[]/)[0]));
    return { path: p, changed: d.length > 0, read_back: p in after ? (after[p] === null ? "not found" : "ok") : "not re-read (call budget)", deleted: plan.expectGone ? after[p] === null : undefined, not_applied: na.length ? na : undefined, unexpected_changes: unexpected.length && !plan.expectGone ? unexpected.slice(0, 100) : undefined, diff: plan.expectGone ? undefined : d.slice(0, 300), diff_truncated: d.length > 300 ? d.length : undefined };
  });
  const verified = records.length ? records.every((r) => (plan.expectGone ? r.deleted === true : r.read_back === "ok" && !r.not_applied)) : undefined;
  return cap({ sent: true, tool: plan.tool, method: plan.method, path: plan.path, http_status: res.status, verified, response_ids: created.length ? created : undefined, records, ...extra, notes: plan.notes?.length ? plan.notes : undefined, audit_key: a.key, audit_error: a.error, after: full ? after : undefined });
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object of { field: value }.`);
  return v as Record<string, unknown>;
};
const num = (v: unknown, what: string): number => {
  const n = Number(v);
  if (v === undefined || v === null || v === "" || !Number.isFinite(n)) throw new Error(`${what} must be a number.`);
  return n;
};
function noSecrets(tool: string, body: unknown): void {
  const bad = secretKeys(body);
  if (bad.length) throw new Error(`${tool}: the body has secret-looking fields (${bad.slice(0, 10).join(", ")}). This Worker never writes integration secrets. Nothing was sent.`);
}
// POST of one or more objects to a collection: the generic core used by halo_api_post and the simple wrappers.
async function planPost(c: Ctx, tool: string, pathArg: unknown, items: Array<Record<string, unknown>>, notes: string[] = []): Promise<Plan> {
  const path = canonical(pathArg, list(c.env.HALO_WRITE_PATHS), tool, "HALO_WRITE_PATHS");
  if (!items.length) throw new Error(`${tool}: nothing to send.`);
  if (items.length > bulkMax(c.env)) throw new Error(`${tool}: ${items.length} records in one call; the limit is ${bulkMax(c.env)} (HALO_BULK_MAX). Split the call.`);
  noSecrets(tool, items);
  if (/^\/control$/i.test(path)) {
    if (items.length !== 1) throw new Error(`${tool}: /Control takes exactly one object of settings.`);
    controlCheck(c.env, items[0]);
    const before = await read(c, "/Control");
    const enabled = String(c.env.HALO_CONTROL_WRITES ?? "").toLowerCase() === "enabled";
    notes.push(enabled ? "Every /Control setting is compared before and after; any other key that changed is listed under unexpected_changes." : "REAL /Control WRITES ARE OFF (HALO_CONTROL_WRITES is not 'enabled'): it is not yet proven on this tenant that a POST with only the changed keys leaves the other settings alone. Dry run only.");
    const cur = Object.fromEntries(Object.keys(items[0]).map((k) => [k, before?.[k]]));
    return { tool, method: "POST", path, confirm: path, body: items, readPaths: [], notes, before: { "/Control (these keys)": cur }, afterHook: async (cc) => {
      const after = await read(cc, "/Control");
      const d = diff(before, after);
      const asked = new Set(Object.keys(items[0]));
      return { settings: Object.fromEntries([...asked].map((k) => [k, { before: before?.[k], after: after?.[k], applied: same(items[0][k], after?.[k]) }])), other_keys_changed: d.filter((x) => !asked.has(x.field.split(/[.[]/)[0]) && !VOLATILE.test(x.field)).slice(0, 200) };
    }, blocked: enabled ? undefined : "real /Control writes are off: HALO_CONTROL_WRITES is not 'enabled' in halopsa-mcp/wrangler.jsonc (see the README for the check to run first)" };
  }
  const ids = items.map((x) => (x.id === undefined || x.id === null || x.id === "" ? null : num(x.id, `${tool}: id`)));
  const withId = ids.filter((x): x is number => x !== null);
  if (new Set(withId).size !== withId.length) throw new Error(`${tool}: the same id appears twice.`);
  const readPaths = withId.map((id) => `${path}/${id}`);
  const before: Record<string, any> = {};
  for (const p of readPaths) {
    before[p] = await readOrNull(c, p);
    if (!before[p]) throw new Error(`${tool}: ${p} was not found, so this would not be an update of an existing record. Nothing was sent. (Leave id out to create.)`);
  }
  const creates = ids.filter((x) => x === null).length;
  if (creates) notes.push(`${creates} record${creates > 1 ? "s" : ""} without an id will be CREATED.`);
  const confirm = withId.length ? `${path}/${withId.join(",")}` : path;
  const sentById = Object.fromEntries(items.filter((x) => x.id !== undefined && x.id !== null && x.id !== "").map((x) => [`${path}/${Number(x.id)}`, x]));
  const shownBody = items.map((x) => (Array.isArray(x.lines) ? { ...x, lines: (x.lines as any[]).map(lineSummary), lines_shown: "summary; every line is sent with all its fields" } : x));
  return { tool, method: "POST", path, confirm, body: items, shownBody, readPaths, sentById, before, notes };
}
async function loadTemplate(c: Ctx, tool: string, id: number): Promise<any> {
  const rec = await readOrNull(c, `/RecurringInvoice/${id}`);
  if (!rec) throw new Error(`${tool}: recurring invoice ${id} was not found. Template ids are negative in this tenant (e.g. -138).`);
  if (rec.is_recurring_invoice === false) throw new Error(`${tool}: ${id} is not a recurring invoice template.`);
  if (!Array.isArray(rec.lines)) throw new Error(`${tool}: Halo returned recurring invoice ${id} without its lines, so the full line set cannot be sent back safely. Nothing was sent.`);
  return rec;
}
async function simpleUpdate(c: Ctx, tool: string, path: string, args: Record<string, unknown>): Promise<string> {
  const fields = obj(args.fields, `${tool}: fields`);
  if ("id" in fields && Number(fields.id) !== num(args.id, `${tool}: id`)) throw new Error(`${tool}: fields.id does not match id.`);
  if (!Object.keys(fields).filter((k) => k !== "id").length) throw new Error(`${tool}: fields is empty.`);
  return execute(c, args, await planPost(c, tool, path, [{ ...fields, id: num(args.id, `${tool}: id`) }]));
}

export async function runBillingTool(name: string, args: Record<string, unknown>, env: BillingEnv): Promise<string> {
  const c: Ctx = { env, calls: 0 };
  switch (name) {
    case "halo_api_post": {
      const raw = args.body;
      const items = (Array.isArray(raw) ? raw : [raw]).map((x, i) => obj(x, `halo_api_post: body${Array.isArray(raw) ? `[${i}]` : ""}`));
      const notes: string[] = [];
      if (items.some((x) => Array.isArray(x.lines))) notes.push("This body carries `lines`. It is sent exactly as given. Whether Halo replaces the whole line set with it or merges is NOT verified on this tenant - use update_recurring_invoice_line / update_recurring_invoice, which always send the complete set.");
      return execute(c, args, await planPost(c, name, args.path, items, notes));
    }
    case "halo_api_delete": {
      const path = canonical(args.path, list(env.HALO_DELETE_PATHS), name, "HALO_DELETE_PATHS");
      const id = num(args.id, "halo_api_delete: id");
      const target = `${path}/${id}`;
      const rec = await readOrNull(c, target);
      if (!rec) throw new Error(`halo_api_delete: ${target} was not found. Nothing was sent.`);
      const block = invoiceDeleteBlock(path, rec);
      if (block) throw new Error(`halo_api_delete: ${block} Nothing was sent.`);
      return execute(c, args, { tool: name, method: "DELETE", path: target, confirm: target, readPaths: [target], before: { [target]: rec }, expectGone: true, notes: ["There is no undo. The record as it is now is kept in the audit entry."] });
    }
    case "set_recurring_invoice_active": {
      if (!Array.isArray(args.ids) || !args.ids.length) throw new Error("set_recurring_invoice_active: ids must be a non-empty array of template ids.");
      if (typeof args.active !== "boolean") throw new Error("set_recurring_invoice_active: active must be true or false.");
      const ids = (args.ids as unknown[]).map((x) => num(x, "set_recurring_invoice_active: id"));
      const plan = await planPost(c, name, "/RecurringInvoice", ids.map((id) => ({ id, disabled: !args.active })));
      const already = ids.filter((id) => plan.before?.[`/RecurringInvoice/${id}`]?.disabled === !args.active);
      if (already.length) plan.notes!.push(`Already ${args.active ? "enabled" : "disabled"}: ${already.join(", ")} (sending it again changes nothing).`);
      plan.notes!.push("Lines are not sent. The read-back diff would show it if Halo changed them anyway.");
      return execute(c, args, plan);
    }
    case "create_recurring_invoice": {
      const fields = args.fields === undefined ? {} : obj(args.fields, "create_recurring_invoice: fields");
      if ("id" in fields) throw new Error("create_recurring_invoice: fields.id is not allowed on a create (use update_recurring_invoice).");
      const body: Record<string, unknown> = { ...fields, client_id: num(args.client_id, "create_recurring_invoice: client_id"), disabled: args.active === true ? false : true };
      if (args.contract_id !== undefined) body.contract_id = num(args.contract_id, "create_recurring_invoice: contract_id");
      if (args.lines !== undefined) { if (!Array.isArray(args.lines)) throw new Error("create_recurring_invoice: lines must be an array."); body.lines = (args.lines as unknown[]).map((l, i) => obj(l, `create_recurring_invoice: lines[${i}]`)); }
      const client = await readOrNull(c, `/Client/${body.client_id}`);
      if (!client) throw new Error(`create_recurring_invoice: client ${body.client_id} was not found. Nothing was sent.`);
      const plan = await planPost(c, name, "/RecurringInvoice", [body], [`Client: ${client.name}.`, body.disabled ? "The template is created DISABLED; enable it with set_recurring_invoice_active once it is checked." : "The template is created ENABLED and will bill on its schedule.", "Creating a template through the API has not been exercised on this tenant yet: check the result in Halo."]);
      plan.afterHook = async (cc, res) => {
        const newId = Array.isArray(res) ? res[0]?.id : res?.id;
        if (newId === undefined) return { created: null, note: "Halo did not return an id - look the template up with list_recurring_invoices before retrying, so it is not created twice." };
        return { created: slim(await readOrNull(cc, `/RecurringInvoice/${newId}`), args.full === true) };
      };
      return execute(c, args, plan);
    }
    case "update_recurring_invoice": {
      const id = num(args.id, "update_recurring_invoice: id");
      const fields = args.fields === undefined ? {} : obj(args.fields, "update_recurring_invoice: fields");
      if ("lines" in fields) throw new Error("update_recurring_invoice: pass lines as the `lines` argument, not inside fields.");
      if ("id" in fields && Number(fields.id) !== id) throw new Error("update_recurring_invoice: fields.id does not match id.");
      const cur = await loadTemplate(c, name, id);
      const body: Record<string, unknown> = { ...fields, id };
      const notes: string[] = [];
      if (args.lines !== undefined) {
        if (!Array.isArray(args.lines)) throw new Error("update_recurring_invoice: lines must be an array.");
        if (args.replace_all_lines !== true) throw new Error("update_recurring_invoice: lines is the COMPLETE line set the template should end up with. Pass replace_all_lines: true to confirm that, or use update_recurring_invoice_line to change one line. Nothing was sent.");
        const curById = new Map<number, any>((cur.lines as any[]).map((l) => [Number(l.id), l]));
        const seen = new Set<number>();
        body.lines = (args.lines as unknown[]).map((l, i) => {
          const line = obj(l, `update_recurring_invoice: lines[${i}]`);
          if (line.id === undefined || line.id === null) return { ...line, ihid: id };
          const lid = Number(line.id);
          if (!curById.has(lid)) throw new Error(`update_recurring_invoice: line ${line.id} is not a line of template ${id}. Nothing was sent.`);
          if (seen.has(lid)) throw new Error(`update_recurring_invoice: line ${lid} appears twice.`);
          seen.add(lid);
          return { ...curById.get(lid), ...line }; // an existing line goes back whole, with the changes on top
        });
        const dropped = [...curById.values()].filter((l) => !seen.has(Number(l.id)));
        notes.push(`Line set: ${(body.lines as any[]).length} sent (${seen.size} existing, ${(body.lines as any[]).length - seen.size} new); the template has ${curById.size} now.`);
        if (dropped.length) notes.push(`LEFT OUT, and removed if Halo replaces the line set: ${dropped.map((l) => `#${l.id} ${String(l.item_shortdescription ?? "").slice(0, 60)}`).join("; ")}.`);
        notes.push("Whether Halo replaces the line set or merges into it is NOT verified on this tenant; the read-back diff shows what it did.");
      } else if (!Object.keys(fields).filter((k) => k !== "id").length) throw new Error("update_recurring_invoice: nothing to change (no fields, no lines).");
      else notes.push("Lines are not sent.");
      const plan = await planPost(c, name, "/RecurringInvoice", [body], notes);
      return execute(c, args, plan);
    }
    case "update_recurring_invoice_line": {
      const id = num(args.invoice_id, "update_recurring_invoice_line: invoice_id");
      const lineId = num(args.line_id, "update_recurring_invoice_line: line_id");
      const fields = obj(args.fields, "update_recurring_invoice_line: fields");
      if (!Object.keys(fields).length) throw new Error("update_recurring_invoice_line: fields is empty.");
      for (const k of ["id", "ihid"]) if (k in fields) throw new Error(`update_recurring_invoice_line: ${k} cannot be changed.`);
      const cur = await loadTemplate(c, name, id);
      const lines = cur.lines as any[];
      if (!lines.some((l) => Number(l.id) === lineId)) throw new Error(`update_recurring_invoice_line: line ${lineId} is not on template ${id} (its lines: ${lines.map((l) => l.id).join(", ") || "none"}). Nothing was sent.`);
      const target = lines.find((l) => Number(l.id) === lineId);
      const body = { id, lines: lines.map((l) => (Number(l.id) === lineId ? { ...l, ...fields } : l)) };
      const notes = [`All ${lines.length} lines of the template are sent, line ${lineId} with the change: ${Object.keys(fields).map((k) => `${k} ${JSON.stringify(target[k])} -> ${JSON.stringify(fields[k])}`).join(", ")}.`, "Totals (net_amount, tax) are left for Halo to recalculate; check them in the diff."];
      const plan = await planPost(c, name, "/RecurringInvoice", [body], notes);
      plan.confirm = `/RecurringInvoice/${id}/lines/${lineId}`;
      return execute(c, args, plan);
    }
    case "update_contract": return simpleUpdate(c, name, "/ClientContract", args);
    case "update_client": return simpleUpdate(c, name, "/Client", args);
    case "update_item": return simpleUpdate(c, name, "/Item", args);
    case "upsert_software_licence": {
      const clientId = num(args.client_id, "upsert_software_licence: client_id");
      const fields = args.fields === undefined ? {} : obj(args.fields, "upsert_software_licence: fields");
      const set: Record<string, unknown> = { ...fields };
      if (args.count !== undefined) set.count = num(args.count, "upsert_software_licence: count");
      if (args.item_id !== undefined) set.item_id = num(args.item_id, "upsert_software_licence: item_id");
      let id: number | null = args.id !== undefined && args.id !== null ? num(args.id, "upsert_software_licence: id") : null;
      const notes: string[] = [];
      if (id === null) {
        const name_ = String(args.name ?? "").trim();
        if (!name_) throw new Error("upsert_software_licence: pass id (update) or name (find or create).");
        const found = await read(c, "/SoftwareLicence", { client_id: String(clientId), search: name_, count: "200" });
        const rows: any[] = Array.isArray(found) ? found : found?.licences ?? found?.softwarelicences ?? (Object.values(found ?? {}).find((v) => Array.isArray(v)) as any[] | undefined) ?? [];
        const hits = rows.filter((r) => String(r.name ?? "").trim().toLowerCase() === name_.toLowerCase() && Number(r.client_id) === clientId);
        if (hits.length > 1) throw new Error(`upsert_software_licence: ${hits.length} licences named "${name_}" for client ${clientId} (ids ${hits.map((h) => h.id).join(", ")}). Pass id. Nothing was sent.`);
        if (hits.length === 1) { id = Number(hits[0].id); notes.push(`Found licence #${id} "${hits[0].name}" (count ${hits[0].count}): UPDATE.`); }
        else { set.name = name_; notes.push(`No licence named "${name_}" for client ${clientId}: CREATE.`); }
      } else if (args.name !== undefined) set.name = String(args.name);
      if (id !== null) {
        const cur = await readOrNull(c, `/SoftwareLicence/${id}`);
        if (!cur) throw new Error(`upsert_software_licence: licence ${id} was not found. Nothing was sent.`);
        if (Number(cur.client_id) !== clientId) throw new Error(`upsert_software_licence: licence ${id} belongs to client ${cur.client_id} (${cur.client_name ?? "?"}), not ${clientId}. Nothing was sent.`);
        if (!Object.keys(set).length) throw new Error("upsert_software_licence: nothing to change (pass count, item_id or fields).");
        return execute(c, args, await planPost(c, name, "/SoftwareLicence", [{ ...set, id }], notes));
      }
      return execute(c, args, await planPost(c, name, "/SoftwareLicence", [{ ...set, client_id: clientId }], notes));
    }
    case "update_halo_settings": return execute(c, args, await planPost(c, name, "/Control", [obj(args.settings, "update_halo_settings: settings")]));
    case "create_invoice_from_recurring": {
      const path = canonical("/RecurringInvoice/process", list(env.HALO_WRITE_PATHS), name, "HALO_WRITE_PATHS");
      const id = num(args.recurring_invoice_id, "create_invoice_from_recurring: recurring_invoice_id");
      const tpl = await loadTemplate(c, name, id);
      const recent = async (cc: Ctx): Promise<any[]> => {
        const r = await read(cc, "/Invoice", { recurringinvoice_id: String(id), count: "10", order: "id", orderdesc: "true" });
        const rows: any[] = Array.isArray(r) ? r : r?.invoices ?? [];
        return rows.map((x) => ({ id: x.id, invoicenumber: x.invoicenumber, total: x.total, posted: x.posted, date_created: x.date_created, datesent: x.datesent, qboid: x.qboid }));
      };
      const beforeInv = await recent(c);
      const notes = ["UNVERIFIED on this tenant: what POST /RecurringInvoice/process does with a single id (schedule, emailing, QuickBooks sync) has not been observed. Expect a real invoice."];
      if (tpl.disabled === true) notes.push("This template is DISABLED; Halo may refuse it or process it anyway.");
      if (args.dry_run !== false) {
        const ctl = await read(c, "/Control").catch(() => null);
        const keys = ["autocreaterecurringinvoices", "autosendemailforautorinvoices", "automaticallysendinvoiceemails", "enableinvoiceapprovals", "mergerecurringinvoices"];
        if (ctl) notes.push(`Settings now: ${keys.map((k) => `${k}=${JSON.stringify(ctl[k])}`).join(", ")}.`);
      }
      return execute(c, args, { tool: name, method: "POST", path, confirm: `${path}/${id}`, body: [id], readPaths: [], before: { [`/RecurringInvoice/${id}`]: tpl, [`invoices from template ${id} (latest 10)`]: beforeInv }, notes, afterHook: async (cc) => {
        await sleep(1500);
        const known = new Set(beforeInv.map((x) => x.id));
        const now = await recent(cc);
        const fresh = now.filter((x) => !known.has(x.id));
        return { new_invoices: fresh, note: fresh.length ? undefined : "No new invoice from this template is visible yet. Check Halo before running it again, so it is not invoiced twice." };
      } });
    }
    case "get_billing_audit": {
      if (!env.HALO_AUDIT) throw new Error("get_billing_audit: the audit log (KV binding HALO_AUDIT) is not bound to this Worker.");
      if (args.key) {
        const k = String(args.key);
        if (!k.startsWith("audit:")) throw new Error("get_billing_audit: key must be one returned by this tool.");
        const v = await env.HALO_AUDIT.get(k);
        if (!v) throw new Error(`get_billing_audit: no entry ${k}.`);
        return cap({ key: k, entry: JSON.parse(v) });
      }
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
      const keys = (await env.HALO_AUDIT.list({ prefix: "audit:", limit })).keys;
      const entries = [] as unknown[];
      for (const k of keys) {
        const v = await env.HALO_AUDIT.get(k.name);
        if (!v) continue;
        const e = JSON.parse(v);
        const body = JSON.stringify(e.body ?? null);
        entries.push({ key: k.name, ts: e.ts, tool: e.tool, method: e.method, path: e.path, record_ids: e.record_ids, http_status: e.http_status, ok: e.ok, error: e.error, response_ids: e.response_ids, body: body.length > 1500 ? `${body.slice(0, 1500)}... [${body.length} characters; pass key for the full entry]` : e.body });
      }
      return cap({ count: entries.length, newest_first: true, entries });
    }
    default: throw new Error(`Unknown billing tool: ${name}`);
  }
}

// ---- halo_api_get helpers (fields filter) ----------------------------------------------------------------------
// fields: comma-separated names; a dotted name reaches into a nested object or each element of a nested array
// ("lines.id,lines.qty_order"). Applied to a single record, to each row of a list, or to each row of the list
// inside Halo's {record_count, <rows>: [...]} wrapper (the wrapper's own scalar fields are kept).
function pick(v: any, paths: string[][]): any {
  if (Array.isArray(v)) return v.map((x) => pick(x, paths));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  const groups = new Map<string, string[][]>();
  for (const p of paths) { if (!groups.has(p[0])) groups.set(p[0], []); if (p.length > 1) groups.get(p[0])!.push(p.slice(1)); else groups.get(p[0])!.unshift([]); }
  for (const [k, subs] of groups) {
    if (!(k in v)) continue;
    const whole = subs.some((s) => s.length === 0);
    out[k] = whole ? v[k] : pick(v[k], subs);
  }
  return out;
}
export function filterFields(data: any, fields: string): any {
  const paths = fields.split(",").map((f) => f.trim()).filter(Boolean).map((f) => f.split("."));
  if (!paths.length) return data;
  if (Array.isArray(data)) return pick(data, paths);
  if (data && typeof data === "object") {
    const top = new Set(paths.map((p) => p[0]));
    const arrays = Object.entries(data).filter(([, x]) => Array.isArray(x) && (x as any[]).some((r) => r && typeof r === "object"));
    const isWrapper = arrays.length > 0 && ![...top].some((k) => k in data);
    if (isWrapper) return Object.fromEntries(Object.entries(data).map(([k, x]) => [k, Array.isArray(x) ? pick(x, paths) : x]).filter(([, x]) => x === null || typeof x !== "object" || Array.isArray(x)));
    return pick(data, paths);
  }
  return data;
}
