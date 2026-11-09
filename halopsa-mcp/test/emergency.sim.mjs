// Emergency paging simulation (2026-11-09): escalate_emergency and emergency_follow_up against a mock Halo.
// Run:  npx esbuild src/index.ts --bundle --format=esm --platform=neutral --outfile=test/.emergency-worker.mjs && node test/emergency.sim.mjs
// Checks: page before acknowledgment, the previous on-call as fallback, wording by result, Critical + Follow Up
// Needed when nobody was paged, the next-run / 30 / 60 minute re-pages, stop on a human action, once per ticket.
import worker from "./.emergency-worker.mjs";
const H = "https://halo.test";
function mkHalo({ shifts, failPageTo = [], actions = [] }) {
  const st = { actions: [...actions], posts: [], ticketUpdates: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url); const m = (init.method || "GET").toUpperCase();
    const j = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.pathname === "/auth/token") return j({ access_token: "t" });
    const p = u.pathname.replace(/^\/api/, "");
    if (m === "GET" && p === "/Tickets/500") return j({ id: 500, user_name: "Dana Smith", client_name: "Acme", summary: "Server down", emailtolist: "dana@acme.test", hasbeenclosed: false });
    if (m === "GET" && p === "/Actions") return j({ actions: st.actions });
    if (m === "GET" && p === "/Appointment") return j(shifts);
    if (m === "GET" && p.startsWith("/Agent/")) { const id = +p.split("/")[2]; return j({ email: `agent${id}@altec.test`, sms: id === 7 ? "(417) 555-0101" : "" }); }
    if (m === "GET" && p === "/Status") return j([{ id: 9, name: "Follow Up Needed" }, { id: 4, name: "Waiting on client" }]);
    if (m === "POST" && p === "/Actions") {
      const b = JSON.parse(init.body)[0];
      if (b.emailto && failPageTo.includes(b.emailto)) return new Response("boom", { status: 500 });
      const a = { id: 100 + st.actions.length, datetime: new Date().toISOString().slice(0, 19), who: "Allie", who_type: 1, actionby_application_id: "Claude", ...b };
      st.actions.unshift(a); st.posts.push(b.emailto ? `PAGE->${b.emailto}` : b.hiddenfromuser ? `NOTE:${b.note.slice(0, 60)}` : `ACK:${b.note.split("\n")[2]}`);
      return j([a]);
    }
    if (m === "POST" && p === "/Tickets") { st.ticketUpdates.push(JSON.parse(init.body)[0]); return j([{}]); }
    return new Response(`unmocked ${m} ${p}`, { status: 404 });
  };
  return st;
}
async function call(name, args) {
  const env = { HALO_BASE_URL: H, HALO_CLIENT_ID: "x", HALO_CLIENT_SECRET: "y", HALO_TENANT: "z" };
  const r = await worker.fetch(new Request("https://w.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, {});
  const t = await r.text(); const d = JSON.parse(t.replace(/^data: /m, ""));
  return d.result?.content?.[0]?.text ?? JSON.stringify(d);
}
const iso = (ms) => new Date(Date.now() + ms).toISOString().replace("Z", "");
const now = Date.now(), hr = 3600e3;
const shift = (id, agent, s, e) => ({ id, type: 4, shift_type_id: 1, agent_id: agent, agent_name: `Agent${agent}`, subject: "On-call", start_date: new Date(now + s).toISOString().slice(0, 19), end_date: new Date(now + e).toISOString().slice(0, 19) });
const args = { ticket_id: 500, issue_summary: "the server is down for everyone", follow_up_status_id: 9, team_id: 2, agent_id: 1 };
let ok = true; const check = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) ok = false; };

// A: someone on shift
let st = mkHalo({ shifts: [shift(1, 7, -hr, hr), shift(2, 8, -5 * hr, -hr)] });
let out = JSON.parse(await call("escalate_emergency", args));
check(st.posts[0] === "PAGE->agent7@altec.test" && st.posts[1].startsWith("ACK:"), "A page before ack: " + st.posts.join(" | "));
check(/on-call engineer has been notified and will follow up as soon as possible/.test(out.acknowledgment), "A paged wording");
check(!/escalat/i.test(out.acknowledgment), "A no 'escalated'");
check(!st.ticketUpdates[0].priority_id, "A no Critical when paged");
check(/page=on_call/.test(st.posts[2]), "A audit page=on_call");

// B: nobody on shift -> previous on-call
st = mkHalo({ shifts: [shift(2, 8, -5 * hr, -hr), shift(3, 9, -30 * hr, -20 * hr)] });
out = JSON.parse(await call("escalate_emergency", args));
check(st.posts[0] === "PAGE->agent8@altec.test", "B fallback pages the most recent previous on-call: " + st.posts[0]);
check(out.on_call_alert.list === "fallback" && /notified/.test(out.acknowledgment), "B list=fallback, paged wording");

// C: current page fails -> fallback
st = mkHalo({ shifts: [shift(1, 7, -hr, hr), shift(2, 8, -5 * hr, -hr)], failPageTo: ["agent7@altec.test"] });
out = JSON.parse(await call("escalate_emergency", args));
check(st.posts[0] === "PAGE->agent8@altec.test" && out.on_call_alert.list === "fallback", "C failed page falls back to previous");

// D: no shifts at all -> nobody, not-paged wording, Critical + Follow Up Needed
st = mkHalo({ shifts: [] });
out = JSON.parse(await call("escalate_emergency", { ...args, follow_up_status_id: undefined }));
check(st.posts[0].startsWith("ACK:") && /our team has been alerted and will respond as soon as possible/.test(out.acknowledgment), "D not-paged wording: " + st.posts[0]);
check(!/on-call/.test(out.acknowledgment), "D ack never mentions on-call");
check(st.ticketUpdates[0].priority_id === 1 && st.ticketUpdates[0].status_id === 9, "D Critical + Follow Up Needed: " + JSON.stringify(st.ticketUpdates[0]));
{ const n = st.actions.find(a => /EMERGENCY ACK SENT/.test(a.note)).note; console.log("   audit: " + n); check(/page=none/.test(n) && /NOT paged/.test(n), "D audit says NOT paged"); }

// E: follow-ups
const ackNote = (minsAgo, page) => ({ id: 1, datetime: new Date(now - minsAgo * 60e3).toISOString().slice(0, 19), who: "Allie", who_type: 1, actionby_application_id: "Claude", note: `[EMERGENCY ACK SENT] x page=${page} - ...` });
st = mkHalo({ shifts: [shift(2, 8, -5 * hr, -hr)], actions: [ackNote(10, "none")] });
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.stage === "retry" && out.paged && st.posts[0] === "PAGE->agent8@altec.test", "E retry goes to fallback on next run: " + JSON.stringify(out));
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.stage === null && out.done === false, "E retry runs once");

st = mkHalo({ shifts: [shift(1, 7, -hr, hr), shift(2, 8, -5 * hr, -hr)], actions: [ackNote(20, "on_call")] });
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.stage === null, "F nothing due at 20 min when paged");
st = mkHalo({ shifts: [shift(1, 7, -hr, hr), shift(2, 8, -5 * hr, -hr)], actions: [ackNote(31, "on_call")] });
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.stage === "30min" && st.posts[0] === "PAGE->agent7@altec.test", "F 30 min re-pages current on-call");
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.stage === null, "F 30 min runs once");
st = mkHalo({ shifts: [shift(1, 7, -hr, hr), shift(2, 8, -5 * hr, -hr)], actions: [ackNote(61, "on_call")] });
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.stage === "60min" && out.done && st.posts[0] === "PAGE->agent8@altec.test", "F 60 min pages fallback list, then done");
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.done && !st.posts[1], "F nothing after 60 min");

// G: human touched -> stop
st = mkHalo({ shifts: [shift(1, 7, -hr, hr)], actions: [{ id: 2, datetime: new Date(now - 5 * 60e3).toISOString().slice(0, 19), who: "Erick", who_type: 1, actionby_application_id: "web", outcome: "Private Note" }, ackNote(40, "on_call")] });
out = JSON.parse(await call("emergency_follow_up", { ticket_id: 500 }));
check(out.done && st.posts.length === 0, "G a person acted -> no re-page");

// H: once per ticket still holds
st = mkHalo({ shifts: [], actions: [ackNote(1, "on_call")] });
out = await call("escalate_emergency", args);
check(/already had its emergency acknowledgment/.test(out) && st.posts.length === 0, "H runs once per ticket");
console.log(ok ? "ALL PASS" : "SOME FAILED");
