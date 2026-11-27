// Billing write tools against a mock Halo (2026-11-27). Nothing here reaches a real tenant.
// Run:  npx esbuild src/index.ts --bundle --format=esm --platform=neutral --outfile=test/.billing-worker.mjs && node test/billing.sim.mjs
// Checks: dry run by default and sends nothing, confirm must match, no audit binding = no write, audit entry per
// real write, config-driven path lists, hard blocks (agents, secrets, posted/QuickBooks invoices, /Control keys and
// the /Control gate), full line set on every line write, bulk limit, halo_api_get fields/paging.
import worker from "./.billing-worker.mjs";
const H = "https://halo.test";
const line = (id, qty, price) => ({ id, ihid: -143, item_shortdescription: `Line ${id}`, qty_order: qty, unit_price: price, net_amount: qty * price, _itemid: 1000 + id });
function mk() {
  const st = { writes: [], kv: new Map(), db: {
    "/RecurringInvoice/-143": { id: -143, is_recurring_invoice: true, disabled: true, client_id: 121, posted: false, qboid: 0, notes_1: "", lines: [line(1504, 1, 0.25), line(1505, 12, 4.34)], client: { id: 121, big: "x".repeat(500) } },
    "/RecurringInvoice/-138": { id: -138, is_recurring_invoice: true, disabled: false, client_id: 5, posted: false, qboid: 0, lines: [] },
    "/Invoice/900": { id: 900, posted: true, qboid: 0, lines: [] }, "/Invoice/901": { id: 901, posted: false, qboid: "4411", lines: [] }, "/Invoice/902": { id: 902, posted: false, qboid: 0, lines: [] },
    "/Client/121": { id: 121, name: "Springfield Brewing Company", notes: "old" },
    "/SoftwareLicence/7": { id: 7, client_id: 121, name: "M365 Business Premium", count: 10 },
    "/Control": { autocreaterecurringinvoices: true, mergerecurringinvoices: false, smtpserver: "x", other: 1 },
  } };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const m = (init.method || "GET").toUpperCase();
    const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (u.pathname === "/auth/token") return j({ access_token: "t" });
    const p = u.pathname.replace(/^\/api/, "");
    if (m === "GET") {
      if (p === "/SoftwareLicence") return j({ record_count: 1, licences: [st.db["/SoftwareLicence/7"]] });
      if (p === "/Invoice") return j({ invoices: [] });
      if (p === "/RecurringInvoice") return j({ record_count: 2, invoices: [st.db["/RecurringInvoice/-143"], st.db["/RecurringInvoice/-138"]], q: Object.fromEntries(u.searchParams) });
      return st.db[p] ? j(st.db[p]) : new Response("not found", { status: 404 });
    }
    const body = init.body ? JSON.parse(init.body) : null;
    st.writes.push({ m, p, body });
    if (m === "DELETE") { delete st.db[p]; return new Response("", { status: 200 }); }
    if (p === "/Control") { Object.assign(st.db["/Control"], body[0]); return j(st.db["/Control"]); }
    if (p === "/RecurringInvoice/process") return j([]);
    return j(body.map((b) => { const id = b.id ?? 5000; st.db[`${p}/${id}`] = { ...(st.db[`${p}/${id}`] ?? {}), ...b, id }; return st.db[`${p}/${id}`]; }));
  };
  st.env = { HALO_BASE_URL: H, HALO_CLIENT_ID: "x", HALO_CLIENT_SECRET: "y", HALO_TENANT: "z",
    HALO_WRITE_PATHS: "/RecurringInvoice,/RecurringInvoice/process,/ClientContract,/Client,/Item,/SoftwareLicence,/Pax8Details,/Control,/Invoice", HALO_DELETE_PATHS: "/RecurringInvoice,/Invoice,/SoftwareLicence",
    HALO_CONTROL_KEYS: "autocreaterecurringinvoices,mergerecurringinvoices", HALO_CONTROL_WRITES: "dry_run_only", HALO_BULK_MAX: "20",
    HALO_AUDIT: { get: async (k) => st.kv.get(k) ?? null, put: async (k, v) => { st.kv.set(k, v); }, list: async ({ prefix, limit }) => ({ keys: [...st.kv.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) }) } };
  return st;
}
async function call(st, name, args, env = st.env) {
  const r = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
  const d = JSON.parse((await r.text()).replace(/^data: /m, ""));
  const one = Array.isArray(d) ? d[0] : d;
  return one.result ? { ok: JSON.parse(one.result.content[0].text) } : { err: one.error?.message ?? JSON.stringify(one) };
}
let pass = 0, fail = 0;
const t = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : " :: " + JSON.stringify(detail)?.slice(0, 600)}`); };

let st = mk(), r;
r = await call(st, "set_recurring_invoice_active", { ids: [-143], active: false });
t("dry run is the default and sends nothing", r.ok?.dry_run === true && st.writes.length === 0 && r.ok.confirm_to_send === "/RecurringInvoice/-143" && JSON.stringify(r.ok.body) === '[{"id":-143,"disabled":true}]' && r.ok.current["/RecurringInvoice/-143"].client === undefined, r);
r = await call(st, "set_recurring_invoice_active", { ids: [-143], active: false, dry_run: false });
t("real write without confirm is refused", /confirm is missing/.test(r.err) && st.writes.length === 0, r);
r = await call(st, "set_recurring_invoice_active", { ids: [-143], active: false, dry_run: false, confirm: "/RecurringInvoice/-138" });
t("real write with the wrong confirm is refused", /does not match/.test(r.err) && st.writes.length === 0, r);
r = await call(st, "set_recurring_invoice_active", { ids: [-143], active: false, dry_run: false, confirm: "/RecurringInvoice/-143" }, { ...st.env, HALO_AUDIT: undefined });
t("no audit binding = no write", /HALO_AUDIT/.test(r.err) && st.writes.length === 0, r);
r = await call(st, "set_recurring_invoice_active", { ids: [-143, -138], active: true, dry_run: false, confirm: "/RecurringInvoice/-143,-138" });
t("bulk write lands, is verified and diffed", r.ok?.sent && r.ok.verified === true && st.writes.length === 1 && r.ok.records[0].diff.some((d) => d.field === "disabled" && d.before === true && d.after === false) && r.ok.records[1].changed === false && !("lines" in st.writes[0].body[0]), r);
const a = await call(st, "get_billing_audit", {});
t("audit entry written and readable", a.ok?.count === 1 && a.ok.entries[0].tool === "set_recurring_invoice_active" && a.ok.entries[0].http_status === 200 && a.ok.entries[0].path === "/RecurringInvoice", a);
const a1 = await call(st, "get_billing_audit", { key: a.ok.entries[0].key });
t("audit entry keeps the record as it was", a1.ok?.entry.before["/RecurringInvoice/-143"].disabled === true, a1);

st = mk();
r = await call(st, "halo_api_post", { path: "/Tickets", body: { id: 1, status_id: 2 } });
t("path outside the config is refused", /not in HALO_WRITE_PATHS/.test(r.err), r);
r = await call(st, "halo_api_post", { path: "/Agent", body: { id: 1 } }, { ...st.env, HALO_WRITE_PATHS: "/Agent" });
t("agents are blocked even if configured", /is blocked/.test(r.err), r);
r = await call(st, "halo_api_post", { path: "/Roles", body: { id: 1 } }, { ...st.env, HALO_WRITE_PATHS: "/Roles" });
t("roles are blocked even if configured", /is blocked/.test(r.err), r);
r = await call(st, "halo_api_post", { path: "/RecurringInvoice/-143", body: { id: -143 } });
t("an id in the path is refused", /not in HALO_WRITE_PATHS/.test(r.err), r);
r = await call(st, "halo_api_post", { path: "/Pax8Details", body: { id: 1, new_client_secret: "x" } });
t("secret-looking fields are refused", /secret-looking/.test(r.err), r);
r = await call(st, "halo_api_post", { path: "/Client", body: Array.from({ length: 21 }, (_, i) => ({ id: i })) });
t("bulk limit", /limit is 20/.test(r.err), r);
r = await call(st, "halo_api_post", { path: "/Client", body: { id: 999, notes: "x" } });
t("update of a missing record is refused", /was not found/.test(r.err), r);
r = await call(st, "update_client", { id: 121, fields: { notes: "new" }, dry_run: false, confirm: "/Client/121" });
t("update_client", r.ok?.verified && r.ok.records[0].diff.length === 1 && r.ok.records[0].diff[0].field === "notes", r);
r = await call(st, "update_halo_settings", { settings: { smtpserver: "evil" } });
t("/Control key outside the allowlist is refused", /not in HALO_CONTROL_KEYS/.test(r.err), r);
r = await call(st, "update_halo_settings", { settings: { mergerecurringinvoices: true } });
t("/Control dry run shows current values", r.ok?.dry_run && r.ok.current["/Control (these keys)"].mergerecurringinvoices === false && !r.ok.confirm_to_send, r);
r = await call(st, "update_halo_settings", { settings: { mergerecurringinvoices: true }, dry_run: false, confirm: "/Control" });
t("/Control real write is off by config", /real \/Control writes are off/.test(r.err) && !st.writes.some((w) => w.p === "/Control"), r);
r = await call(st, "update_halo_settings", { settings: { mergerecurringinvoices: true }, dry_run: false, confirm: "/Control" }, { ...st.env, HALO_CONTROL_WRITES: "enabled" });
t("/Control write when enabled compares every key", r.ok?.settings.mergerecurringinvoices.applied === true && r.ok.other_keys_changed.length === 0 && JSON.stringify(st.writes.at(-1).body) === '[{"mergerecurringinvoices":true}]', r);

st = mk();
for (const [id, why] of [[900, "posted"], [901, "QuickBooks"]]) { r = await call(st, "halo_api_delete", { path: "/Invoice", id, dry_run: false, confirm: `/Invoice/${id}` }); t(`delete of a ${why} invoice is refused`, /void it in QuickBooks/.test(r.err) && st.writes.length === 0, r); }
r = await call(st, "halo_api_delete", { path: "/Client", id: 121 });
t("delete path outside the delete list is refused", /not in HALO_DELETE_PATHS/.test(r.err), r);
r = await call(st, "halo_api_delete", { path: "/Invoice", id: 902 });
t("delete dry run", r.ok?.dry_run && st.writes.length === 0 && r.ok.confirm_to_send === "/Invoice/902", r);
r = await call(st, "halo_api_delete", { path: "/Invoice", id: 902, dry_run: false, confirm: "/Invoice/902" });
t("delete lands and is verified gone", r.ok?.verified === true && r.ok.records[0].deleted === true && st.writes[0].m === "DELETE" && st.writes[0].p === "/Invoice/902", r);

st = mk();
r = await call(st, "update_recurring_invoice_line", { invoice_id: -143, line_id: 1505, fields: { qty_order: 14 } });
t("line dry run shows the summary and the full-set note", r.ok?.dry_run && r.ok.body[0].lines.length === 2 && r.ok.confirm_to_send === "/RecurringInvoice/-143/lines/1505" && st.writes.length === 0, r);
r = await call(st, "update_recurring_invoice_line", { invoice_id: -143, line_id: 1505, fields: { qty_order: 14 }, dry_run: false, confirm: "/RecurringInvoice/-143/lines/1505" });
const sent = st.writes[0]?.body[0];
t("line write sends every line whole, one changed", sent?.lines.length === 2 && sent.lines[0].qty_order === 1 && sent.lines[0]._itemid === 2504 && sent.lines[1].qty_order === 14 && sent.client === undefined && r.ok.records[0].diff.some((d) => d.field === "lines[id=1505].qty_order" && d.after === 14), r);
r = await call(st, "update_recurring_invoice_line", { invoice_id: -143, line_id: 9, fields: { qty_order: 1 } });
t("unknown line is refused", /is not on template/.test(r.err), r);
r = await call(st, "update_recurring_invoice", { id: -143, lines: [{ id: 1504 }] });
t("lines without replace_all_lines is refused", /replace_all_lines/.test(r.err), r);
r = await call(st, "update_recurring_invoice", { id: -143, lines: [{ id: 1504, unit_price: 1 }, { _itemid: 5, qty_order: 2, unit_price: 3 }], replace_all_lines: true });
t("replace dry run names the line left out", r.ok?.notes.some((n) => /LEFT OUT.*#1505/.test(n)) && r.ok.body[0].lines.length === 2, r);
r = await call(st, "update_recurring_invoice", { id: -143, fields: { notes_1: "hello" } });
t("header-only update sends no lines", r.ok?.dry_run && !("lines" in r.ok.body[0]), r);
r = await call(st, "create_recurring_invoice", { client_id: 121, lines: [{ _itemid: 5, qty_order: 1, unit_price: 2 }] });
t("create is disabled by default", r.ok?.body[0].disabled === true && r.ok.confirm_to_send === "/RecurringInvoice", r);
r = await call(st, "upsert_software_licence", { client_id: 121, name: "m365 business premium", count: 12 });
t("licence upsert finds by name", r.ok?.confirm_to_send === "/SoftwareLicence/7" && r.ok.body[0].count === 12, r);
r = await call(st, "upsert_software_licence", { client_id: 121, name: "Something New", count: 3, item_id: 44 });
t("licence upsert creates when absent", r.ok?.confirm_to_send === "/SoftwareLicence" && r.ok.body[0].name === "Something New" && r.ok.body[0].client_id === 121, r);
r = await call(st, "upsert_software_licence", { client_id: 5, id: 7, count: 3 });
t("licence of another client is refused", /belongs to client/.test(r.err), r);
r = await call(st, "create_invoice_from_recurring", { recurring_invoice_id: -143 });
t("process dry run", r.ok?.dry_run && JSON.stringify(r.ok.body) === "[-143]" && r.ok.confirm_to_send === "/RecurringInvoice/process/-143", r);

const g = async (args) => { const x = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "halo_api_get", arguments: args } }) }), st.env); const d = JSON.parse(await x.text()); return (Array.isArray(d) ? d[0] : d).result.content[0].text; };
let x = JSON.parse(await g({ path: "/RecurringInvoice/-143", fields: "id,disabled,lines.id,lines.qty_order" }));
t("fields on a record, dotted into lines", JSON.stringify(x) === '{"id":-143,"disabled":true,"lines":[{"id":1504,"qty_order":1},{"id":1505,"qty_order":14}]}', x);
x = JSON.parse(await g({ path: "/RecurringInvoice", fields: "id,disabled", page_no: 2, page_size: 50 }));
t("fields on a wrapped list, paging passed through", x.record_count === 2 && JSON.stringify(x.invoices) === '[{"id":-143,"disabled":true},{"id":-138,"disabled":false}]', x);
x = JSON.parse(await g({ path: "/RecurringInvoice", page_no: 2, page_size: 50 }));
t("paging params reach Halo", x.q.pageinate === "true" && x.q.page_no === "2" && x.q.page_size === "50", x.q);
x = JSON.parse(await g({ path: "/Control", fields: "mergerecurringinvoices,other" }));
t("fields on /Control", JSON.stringify(x) === '{"mergerecurringinvoices":false,"other":1}', x);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
