export interface Env {
  MCP_AUTH_TOKEN?: string;
  HUMAN_TOUCH_IGNORE_APP_IDS?: string;
  // escalate_emergency (HelpDeskAgent v2.13.x): the on-call page is ONE hidden
  // emailed action on the ticket itself (outcome 16, emailto/emailcc
  // overrides, hiddenfromuser) addressed to whoever Halo's own Shifts
  // calendar has on call at that moment: the email on their Halo agent record
  // and, when the record has a Mobile Number (Halo's `sms` field), a text at
  // <digits>@ON_CALL_SMS_DOMAIN (default altec.text.email). No mobile number =
  // email only. Nobody with an On-call shift (shift_type_id
  // ON_CALL_SHIFT_TYPE_ID, default 1) = NOBODY is paged, on purpose: there is
  // no fallback address (Roger, 2026-09-21); the ticket gets the private
  // [EMERGENCY ACK SENT] note saying so and the tool response says sent=false,
  // which the resolver turns into a NEEDS URGENT note for a human.
  EMERGENCY_ACK_SIGNATURE?: string; // overrides the default Allie sign-off below
  ON_CALL_SHIFT_TYPE_ID?: string;
  ON_CALL_SMS_DOMAIN?: string;
  PIPELINE_AGENT_ID?: string; // the Help Desk agent's own Halo agent id (default 17, "Allie") - see guardUnassign
  HALO_BASE_URL: string;
  HALO_CLIENT_ID: string;
  HALO_CLIENT_SECRET: string;
  HALO_TENANT: string;
}
async function getToken(env: Env): Promise<string> {
  const res = await fetch(`${env.HALO_BASE_URL}/auth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.HALO_CLIENT_ID, client_secret: env.HALO_CLIENT_SECRET, scope: "all" }).toString() });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}
async function haloGet(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken(env);
  const url = new URL(`${env.HALO_BASE_URL}/api${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}
// Never take a ticket away from a person. Real incident (ticket #22506,
// 2026-09-22): the classifier saw the ticket unassigned, Erick claimed it two
// minutes later, and the resolver's draft write then set agent_id 1, moving
// it "From: Erick Gonzales; To: Unassigned". A request to set agent_id to
// Unassigned is honored only when the ticket is currently Unassigned or held
// by the pipeline's own agent; otherwise the agent change is dropped (the
// rest of the write still lands) and the response says so.
async function guardUnassign(env: Env, ticketId: unknown, requestedAgentId: unknown, results: Record<string, unknown>): Promise<boolean> {
  if (Number(requestedAgentId) !== 1) return true;
  const pipelineAgent = Number(env.PIPELINE_AGENT_ID || 17);
  try {
    const t = (await haloGet(env, `/Tickets/${ticketId}`)) as any;
    const current = Number(t?.agent_id ?? 1);
    if (current === 1 || current === pipelineAgent) return true;
    results.agent_change_skipped = `ticket is assigned to ${t?.agent_name || `agent ${current}`} (a person) - left with them instead of moving it to Unassigned; a human who has claimed a ticket owns it.`;
    return false;
  } catch { return true; }
}
async function haloPost(env: Env, path: string, body: unknown): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.HALO_BASE_URL}/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}
async function haloDelete(env: Env, path: string, params?: Record<string, string>): Promise<void> {
  const token = await getToken(env);
  const url = new URL(`${env.HALO_BASE_URL}/api${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`DELETE ${path} failed (${res.status}): ${await res.text()}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Real incident: HelpDeskAgent ticket #22067 - a carefully formatted,
// multi-paragraph draft note looked perfect in Halo's own ticket view, but
// once approved and emailed to the client, all formatting was gone (every
// paragraph break collapsed into one run-on block). Root cause: HaloPSA's
// Actions API has a separate `note` (plain-text) field and `note_html`
// (HTML) field - this Worker only ever set `note`. A plain-text note with
// bare `\n` line breaks renders forgivingly in Halo's own UI, but the
// outbound email is built from `note_html` when present, and HTML ignores
// bare whitespace entirely, so `\n` is not a line break there without an
// explicit `<br>`. Every note write now also sends an HTML-escaped,
// `<br>`-converted `note_html` alongside the plain `note`, so the emailed
// version preserves the same paragraph breaks the draft had.
function noteToHtml(note: string): string {
  const escaped = note
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\r\n|\r|\n/g, "<br>");
}

// Real incident: HelpDeskAgent ticket #22265 - Roger reported that a
// superseded draft was left behind instead of being deleted before the
// revised one was written (resolver-prompt.md's own instructed behavior).
// Root cause: this same ticket's draft note had been written as
// "[INTERNAL NOTE - Relinked] ... --- [DRAFT PENDING APPROVAL] ..." - the
// resolver had also just relinked the ticket's contact and chose to record
// that in the same private note as the draft, ahead of the marker, which
// is reasonable on its own but meant the note no longer *started with* the
// literal marker. delete_ticket_note's and mark_draft_approved's safety
// checks both required exactly that (`note.startsWith(...)`), so the
// delete call - if the resolver even attempted it - was refused, and
// resolver-prompt.md's own instructions say not to fight a refusal, just
// proceed and leave the old note in place. The fix is to stop requiring
// the marker be the very first character of the note and instead accept
// it appearing as its own line anywhere in the note - still an exact,
// specific match (nothing else confusable with a real client-facing reply
// or a human's own note would ever contain this literal line), just not
// fragile against reasonable preamble content place before it.
function hasDraftMarker(note: string): boolean {
  return /(?:^|\r\n|\r|\n)\[DRAFT PENDING APPROVAL\]/.test(note);
}
// A "[PIPELINE NOTE]" is this pipeline's own transient status note (a stop
// waiting on a human: mismatch, unreachable contact, needs a site) - not a
// finding. Once the ticket proceeds it is clutter, so delete_ticket_note may
// remove it too - but only when the note was authored by this pipeline
// (actionby_application_id "Claude"), never a human's note.
function hasPipelineNoteMarker(note: string): boolean {
  return /(?:^|\r\n|\r|\n)\[PIPELINE NOTE\]/.test(note);
}

// Real incident: HelpDeskAgent's resolver writes a note/status/agent change,
// then immediately re-reads the ticket to confirm it landed (Halo has a
// documented bug where a write can report success on an untriaged ticket
// but silently never take effect). Live investigation of one specific
// "confirmed failed" case found the write actually DID land - just a few
// minutes after the resolver's own immediate check gave up. That's not a
// permanent swallow, it's Halo's own eventual consistency: the write is
// accepted before it's reliably readable back. The resolver has no sleep/
// wait tool of its own, and re-checking instantly in its own next turn just
// reproduces the same race - a real, wall-clock delay is genuinely needed,
// which is something this Worker can do far more cheaply and reliably than
// spending another agentic turn on it. verifyWrite re-checks with two short
// delays before reporting failure, so a caller only sees "not confirmed"
// once Halo has actually had a real chance to catch up.
async function verifyWrite(env: Env, args: Record<string, unknown>, checkFields: boolean, checkNote: boolean): Promise<{ confirmed: boolean; attempts: number; fields_confirmed: boolean; note_confirmed: boolean }> {
  const maxAttempts = 3;
  const delayMs = 1500;
  let fieldsOk = !checkFields;
  let noteOk = !checkNote;
  let attempts = 0;
  while (attempts < maxAttempts && (!fieldsOk || !noteOk)) {
    if (attempts > 0) await sleep(delayMs);
    attempts++;
    if (!fieldsOk) {
      const t = (await haloGet(env, `/Tickets/${args.ticket_id}`)) as any;
      fieldsOk =
        (!args.status_id || t.status_id === args.status_id) &&
        (!args.agent_id || t.agent_id === args.agent_id) &&
        (!args.team_id || t.team_id === args.team_id) &&
        (!args.client_id || t.client_id === args.client_id) &&
        (!args.site_id || t.site_id === args.site_id) &&
        (!args.user_id || t.user_id === args.user_id) &&
        (!args.emailto || t.emailtolist === args.emailto);
    }
    if (!noteOk) {
      const recent = (await haloGet(env, "/Actions", { ticket_id: String(args.ticket_id), count: "5" })) as any;
      const list: any[] = recent.actions || [];
      noteOk = list.some((a: any) => a.note === args.note);
    }
  }
  return { confirmed: fieldsOk && noteOk, attempts, fields_confirmed: fieldsOk, note_confirmed: noteOk };
}

// --- Trimmed ticket/action projections (HelpDeskAgent cost program, increment 1) ---
// A raw GET /Tickets/{id} came back at ~94,000 characters (~23K tokens) for a
// single ordinary ticket, and every action in GET /Actions carries ~60 fields
// of which the resolver reads about ten. In an agentic loop that payload is
// re-read on every subsequent turn, so it was the largest single per-ticket
// cost driver measured in production. These projections keep exactly the
// fields the prompts actually reference, plus the device block NinjaOne's
// ticket form embeds in the body (hostname, device id, IPs), which is what
// the resolver would otherwise spend its first tool calls re-deriving.
function truncateText(s: unknown, max: number): { text: string; truncated: boolean } {
  const str = typeof s === "string" ? s : s == null ? "" : String(s);
  if (str.length <= max) return { text: str, truncated: false };
  return { text: str.slice(0, max) + `\n[... truncated ${str.length - max} chars ...]`, truncated: true };
}

function parseDeviceHints(details: string): Record<string, string> | null {
  // NinjaOne's "New support request from ..." form and similar embeds a
  // device block; grab the useful lines when present. Missing lines are
  // simply omitted, and an unrelated ticket body yields null.
  const grab = (label: string) => {
    const m = details.match(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "mi"));
    return m ? m[1].trim() : null;
  };
  const out: Record<string, string> = {};
  const pairs: Array<[string, string]> = [
    ["hostname", "Device"], ["ninja_device_id", "Device ID"], ["device_role", "Device Role"],
    ["public_ip", "Public IP"], ["private_ips", "Private IPs"], ["organization", "Organization"],
    ["location", "Location"], ["os", "OS"], ["username", "USERNAME"], ["ninja_url", "Ninja URL"],
  ];
  for (const [key, label] of pairs) {
    const v = grab(label);
    if (v && v !== "<UNKNOWN>") out[key] = v;
  }
  if (out.ninja_device_id) out.ninja_device_id = out.ninja_device_id.replace(/,/g, "");
  return Object.keys(out).length ? out : null;
}

function trimTicket(t: any, maxDetailsChars: number): Record<string, unknown> {
  const details = truncateText(t.details, maxDetailsChars);
  return {
    id: t.id,
    summary: t.summary ?? "",
    details: details.text,
    details_truncated: details.truncated,
    status_id: t.status_id ?? null,
    tickettype_id: t.tickettype_id ?? null,
    priority_id: t.priority_id ?? null,
    impact: t.impact ?? null,
    urgency: t.urgency ?? null,
    client_id: t.client_id ?? null,
    client_name: t.client_name ?? null,
    site_id: t.site_id ?? null,
    site_name: t.site_name ?? null,
    user_id: t.user_id ?? null,
    user_name: t.user_name ?? null,
    user_email: t.user_email ?? null,
    emailtolist: t.emailtolist ?? null,
    team_id: t.team_id ?? null,
    team: t.team ?? null,
    agent_id: t.agent_id ?? null,
    agent_name: t.agent_name ?? null,
    category_1: t.category_1 ?? null,
    category_2: t.category_2 ?? null,
    dateoccurred: t.dateoccurred ?? null,
    lastactiondate: t.lastactiondate ?? null,
    last_update: t.last_update ?? null,
    onhold: t.onhold ?? null,
    ticketage: t.ticketage ?? null,
    // Closed-state facts (increment 2): Halo keeps a closed ticket's status
    // name tenant-specific ("Resolved", "Closed Order", ...), but dateclosed /
    // hasbeenclosed are mechanical. A never-closed ticket has dateclosed null
    // or Halo's 1899-12-30 sentinel.
    dateclosed: typeof t.dateclosed === "string" && !t.dateclosed.startsWith("1899") ? t.dateclosed : null,
    hasbeenclosed: t.hasbeenclosed ?? null,
    closure_agent_id: t.closure_agent_id ?? null,
    device_hints: parseDeviceHints(typeof t.details === "string" ? t.details : ""),
  };
}

function trimAction(a: any, maxNoteChars: number): Record<string, unknown> {
  const note = truncateText(a.note, maxNoteChars);
  const out: Record<string, unknown> = {
    id: a.id,
    datetime: a.datetime ?? null,
    who: a.who ?? null,
    who_type: a.who_type ?? null,
    who_agentid: a.who_agentid ?? null,
    actionby_application_id: a.actionby_application_id ?? null,
    outcome: a.outcome ?? null,
    outcome_id: a.outcome_id ?? null,
    hiddenfromuser: a.hiddenfromuser ?? null,
    note: note.text,
  };
  if (note.truncated) out.note_truncated = true;
  if (a.emaildirection) { out.emaildirection = a.emaildirection; out.emailfrom = a.emailfrom ?? null; out.emailto = a.emailto ?? null; }
  if (a.old_status !== undefined && a.new_status !== undefined && a.old_status !== a.new_status) { out.old_status = a.old_status; out.new_status = a.new_status; out.new_status_name = a.new_status_name ?? null; }
  if (a.attachment_count) out.attachment_count = a.attachment_count;
  return out;
}

// Same rule get_ticket_time_entries already applies: a real human agent is
// who_type 1 and not this pipeline's own integration identity.
// Replay support (HelpDeskAgent v2.11.5): judge a ticket as it stood at a
// point in time. Drops every action dated after `asOf` (Halo's own
// `datetime`, local Halo time, compared as ISO strings after normalizing to
// the same precision) so human_touch computed over the remainder is the
// as-of ownership truth rather than today's. Real incident: two tickets
// nobody had touched at their as-of point were stopped HUMAN_OWNED in a
// replay because human_touch.found was computed over the full history.
function applyAsOf(actions: any[], asOf: unknown): { actions: any[]; hidden: number; applied: string | null } {
  if (typeof asOf !== "string" || !asOf.trim()) return { actions, hidden: 0, applied: null };
  const cutoff = asOf.trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(cutoff)) throw new Error(`as_of must be an ISO timestamp like 2026-09-17T12:30:00, got '${asOf}'`);
  const kept = actions.filter((a: any) => typeof a.datetime === "string" && a.datetime.slice(0, 19) <= cutoff.slice(0, 19).padEnd(19, ":00".slice(0, Math.max(0, 19 - cutoff.length))));
  return { actions: kept, hidden: actions.length - kept.length, applied: cutoff };
}

// Integrations that post to Halo through a bound agent account look like a
// human (who_type: 1) but aren't one: this pipeline itself ("Claude") and
// Huntress's alert intake ("Huntress"), seen live on tickets #22389/#22390
// where human_touch.found was true on a ticket no person had touched. Add
// more via the HUMAN_TOUCH_IGNORE_APP_IDS var (comma-separated
// actionby_application_id values).
function integrationAppIds(env?: Env): Set<string> {
  // "Acronis Client Portal": Halo's Acronis integration app posts its backup
  // alerts through the Allie agent account (who_agentid 17, who_type 1) -
  // seen on every Acronis ticket since at least 2026-08-22. Not a human, not
  // this pipeline; without this it would count as human_touch (2026-09-22).
  const ids = new Set(["Claude", "Huntress", "Acronis Client Portal"]);
  const extra = (env as any)?.HUMAN_TOUCH_IGNORE_APP_IDS;
  if (typeof extra === "string") extra.split(",").map((x: string) => x.trim()).filter(Boolean).forEach((x: string) => ids.add(x));
  return ids;
}
function isHumanAction(a: any, ignore: Set<string>): boolean {
  return a.who_type === 1 && !ignore.has(String(a.actionby_application_id ?? ""));
}

function computeHumanTouch(actions: any[], env?: Env) {
  const ignore = integrationAppIds(env);
  const human = actions.filter((a: any) => isHumanAction(a, ignore));
  return {
    found: human.length > 0,
    actions: human.map((a: any) => ({ id: a.id, who: a.who, who_agentid: a.who_agentid, datetime: a.datetime, outcome: a.outcome })),
  };
}

async function buildCandidateBrief(env: Env, id: string, historyCount: number, maxDetailsChars: number, maxNoteChars: number) {
  try {
    // history=0 means "ticket fields only" - skip the /Actions call entirely
    // (HelpDeskAgent's approved-tier backstop reads just status_id for every
    // classified ticket each cycle; paying for 100 actions apiece for that
    // would be silly). human_touch is then null, not false: unknown, not
    // "nobody".
    const wantActions = historyCount > 0;
    const [ticket, actionsData] = await Promise.all([
      haloGet(env, `/Tickets/${id}`) as Promise<any>,
      wantActions ? (haloGet(env, "/Actions", { ticket_id: String(id), count: "100" }) as Promise<any>) : Promise.resolve(null),
    ]);
    const actions: any[] = actionsData ? (actionsData.actions || []) : [];
    return {
      found: true,
      ticket: trimTicket(ticket, maxDetailsChars),
      human_touch: wantActions ? computeHumanTouch(actions, env) : null,
      action_count: wantActions ? (actionsData.record_count ?? actions.length) : null,
      recent_actions: actions.slice(0, historyCount).map((a) => trimAction(a, maxNoteChars)),
    };
  } catch (err) {
    return { found: false, ticket: { id: Number(id) }, error: (err as Error).message };
  }
}

type OnCallPerson = { agent_id: number; agent_name: string; email: string | null; mobile: string | null; sms: string[]; shift: { appointment_id: number; subject: string; start: string; end: string; shift_type_id: number } };
type OnCallResolution = { at: string; source: "halo" | "none"; on_call: OnCallPerson[]; emailto: string | null; emailcc: string[]; error?: string };
// The agent's Mobile Number (Halo's `sms` field) as an email-to-SMS address at
// the service domain: digits only, so "(417) 830-0075" -> 4178300075@<domain>.
// Fewer than 10 digits is not a usable mobile number - email only.
function smsAddressFor(env: Env, mobile: string | null): string[] {
  const domain = (env.ON_CALL_SMS_DOMAIN || "altec.text.email").trim().replace(/^@/, "");
  const raw = (mobile || "").replace(/\D/g, "");
  const digits = raw.length === 11 && raw.startsWith("1") ? raw.slice(1) : raw; // "+1 417..." -> 10 digits, like the gateway expects
  return domain && digits.length >= 10 ? [`${digits}@${domain}`] : [];
}
// Who is on call at `at`, from Halo's Shifts calendar. Shifts are appointments
// (type 4) that GET /Appointment only returns with showshifts=true; shiftsonly
// drops everything else and showall ignores the API user's own calendar
// filter. Recurring masters are templates, not shifts. Halo returns times in
// UTC without a suffix. Nobody scheduled, or a lookup error, means nobody to
// page (source "none", emailto null) - there is deliberately no fallback.
async function resolveOnCall(env: Env, at: Date): Promise<OnCallResolution> {
  const none: OnCallResolution = { at: at.toISOString(), source: "none", on_call: [], emailto: null, emailcc: [] };
  try {
    const shiftTypeId = Number(env.ON_CALL_SHIFT_TYPE_ID || 1);
    const day = 86400000;
    const rows = (await haloGet(env, "/Appointment", { showshifts: "true", shiftsonly: "true", showall: "true", start_date: new Date(at.getTime() - 14 * day).toISOString().slice(0, 10), end_date: new Date(at.getTime() + 2 * day).toISOString().slice(0, 10) })) as any[];
    const asUtc = (v: unknown) => new Date(/Z$|[+-]\d\d:\d\d$/.test(String(v)) ? String(v) : `${String(v)}Z`).getTime();
    const t = at.getTime();
    const active = (Array.isArray(rows) ? rows : []).filter((r: any) => r && !r._recurringmaster && Number(r.type) === 4
      && (Number(r.shift_type_id) === shiftTypeId || /\bon[ -]?call\b/i.test(String(r.subject ?? "")))
      && Number(r.agent_id) > 0 && asUtc(r.start_date) <= t && t < asUtc(r.end_date));
    const seen = new Set<number>();
    const people: OnCallPerson[] = [];
    for (const r of active) {
      const agentId = Number(r.agent_id);
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      let email: string | null = null; let mobile: string | null = null;
      try { const a = (await haloGet(env, `/Agent/${agentId}`)) as any; email = String(a?.email ?? "").trim().toLowerCase() || null; mobile = String(a?.sms ?? "").trim() || null; } catch { email = null; mobile = null; }
      people.push({ agent_id: agentId, agent_name: String(r.agent_name ?? ""), email, mobile, sms: smsAddressFor(env, mobile), shift: { appointment_id: Number(r.id), subject: String(r.subject ?? ""), start: String(r.start_date), end: String(r.end_date), shift_type_id: Number(r.shift_type_id) } });
    }
    const withEmail = people.filter((p) => p.email);
    if (withEmail.length === 0) {
      return { ...none, on_call: people, error: people.length ? `on-call agent(s) ${people.map((p) => p.agent_name || p.agent_id).join(", ")} have no email on their Halo agent record - nobody to page` : "nobody has an On-call shift covering this moment in Halo - nobody to page" };
    }
    const emailto = withEmail[0].email as string;
    const emailcc = Array.from(new Set(withEmail.slice(1).map((p) => p.email as string).concat(withEmail.flatMap((p) => p.sms)).filter((x) => x.toLowerCase() !== emailto)));
    return { at: at.toISOString(), source: "halo", on_call: people, emailto, emailcc };
  } catch (err) {
    return { ...none, error: `on-call lookup failed (${(err as Error).message}) - nobody to page` };
  }
}

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to HaloPSA and verify credentials are working", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "list_tickets", description: "List tickets from HaloPSA with optional filters. Without agent_id/team_id, this is an account-wide list capped at `count` (default 20) - large counts return full ticket bodies per row and can exceed the caller's own response-size limit well before reaching the true end of the open-ticket backlog, so a ticket with no recent activity can silently fall outside the window even though it's genuinely open. Pass agent_id (e.g. the real Halo 'Unassigned' agent, or a specific agent) and/or team_id to filter server-side instead of relying on count/recency - a real incident found an unassigned-tickets query with no team_id fetched every team's tickets account-wide (82 full ticket bodies in one case) just to manually discard everything outside the one team actually wanted, at real per-cycle cost. If even one agent's ticket count is still too large for one response, use pageinate/page_no/page_size (HaloPSA's own paging - page_size max 100 per HaloPSA's docs, but this MCP server's own response-size limit will likely force something smaller in practice) instead of `count` to walk through them in bounded pages - the response's own record_count field is the true total match count regardless of how many rows this particular page returned, so it tells you when you've reached the end.", inputSchema: { type: "object", properties: { count: { type: "number" }, open_only: { type: "boolean" }, client_id: { type: "number" }, agent_id: { type: "number", description: "Filter to tickets currently assigned to this single agent ID (HaloPSA's own /Tickets agent_id filter) - use this instead of a large count to reliably find a specific agent's tickets regardless of how recently they were touched." }, team_id: { type: "number", description: "Filter to tickets currently on this single team (HaloPSA's own /Tickets team_id filter) - combine with agent_id (e.g. team_id + agent_id:1 for a specific team's unassigned tickets) to avoid ever fetching another team's tickets at all." }, status_id: { type: "number", description: "Filter to tickets currently in this single status (HaloPSA's own /Tickets status_id filter) - combine with team_id to find every ticket in a specific status regardless of who it's assigned to, e.g. an explicit human hand-back status, without pulling the whole team's ticket list to filter client-side." }, pageinate: { type: "boolean", description: "Enable HaloPSA's own pagination instead of the plain count cutoff - use together with page_no/page_size." }, page_no: { type: "number", description: "Page number to return (1-based) when pageinate is true." }, page_size: { type: "number", description: "Rows per page when pageinate is true. HaloPSA caps this at 100, but this MCP server's response-size limit will often force a smaller value in practice - start small (e.g. 15-20) and only raise it if the response doesn't get truncated." }, search: { type: "string" } } } },
  { name: "get_ticket", description: "Get full details of a single HaloPSA ticket by ID", inputSchema: { type: "object", properties: { ticket_id: { type: "number" } }, required: ["ticket_id"] } },
  { name: "get_ticket_brief", description: "Trimmed view of a single ticket - the same fields as get_ticket that actually matter for working it (summary, body/details, status/type/priority/impact IDs, client/site/contact IDs and names, emailtolist, team/agent, category, key dates) at a fraction of the size, plus `device_hints` parsed from the body when a NinjaOne-style device block is present (hostname, ninja_device_id, private/public IPs, OS, username). Prefer this over get_ticket unless you specifically need a field it omits.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, max_details_chars: { type: "number", description: "Cap on the body/details text (default 6000); longer bodies are truncated with a marker and details_truncated: true." } }, required: ["ticket_id"] } },
  { name: "get_ticket_history", description: "Trimmed action log for a ticket - the same actions as get_ticket_time_entries with only the fields that matter (id, datetime, who/who_type/who_agentid, actionby_application_id, outcome, hiddenfromuser, note text, email direction/addresses when it was an email, status change when it changed, attachment count) plus the same computed `human_touch` field. Notes are capped per action (default 3000 chars). Prefer this over get_ticket_time_entries.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, count: { type: "number", description: "Max actions to return, newest first (default 100)." }, max_note_chars: { type: "number", description: "Per-note text cap (default 3000)." }, as_of: { type: "string", description: "Optional ISO timestamp (Halo time, e.g. 2026-09-17T12:30:00). Actions dated after it are dropped and human_touch is computed over what remains - for replaying a ticket as it stood at that moment." } }, required: ["ticket_id"] } },
  { name: "create_ticket", description: "Create a new ticket in HaloPSA", inputSchema: { type: "object", properties: { summary: { type: "string" }, details: { type: "string" }, client_id: { type: "number" }, user_id: { type: "number" }, team_id: { type: "number" }, agent_id: { type: "number" }, tickettype_id: { type: "number" }, priority_id: { type: "number" } }, required: ["summary"] } },
  { name: "update_ticket", description: "Update a ticket - add a note, change status, reassign, re-link to a different client/contact, or triage (set category/priority). HaloPSA has no separate 'triage' API action — triaging a ticket just means setting category_1 (and priority_id/team_id/agent_id) and moving it off its initial status in one call. IMPORTANT: note_is_private: false alone does NOT email the client - it only marks the note visible-in-portal. Every note this tool adds uses outcome_id 7 ('Private Note' in this tenant's Outcome list) unless send_email is also passed as true, and outcome 7 has hidesendemail set in HaloPSA, meaning it can never trigger an email regardless of hiddenfromuser. To actually send a client-facing reply by email, pass note_is_private: false AND send_email: true together. This tool CAN send a real, public, emailed reply - if the caller is a workflow that must hold every reply for human approval first (not yet decided this ticket is approved to send), use update_ticket_draft_only instead, which cannot send one no matter what arguments it's given. Pass verify: true to have this call re-check (with a couple of short built-in retries) that the note/field changes actually landed before returning - a `verified` field is added to the response with the result. Default (omitted/false) leaves the response exactly as it's always been, with no added delay - opt in only when you actually need the confirmation, e.g. on a ticket that might not be triaged yet in Halo (writes there can silently take a few extra seconds to become readable).", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, note: { type: "string" }, verify: { type: "boolean", description: "If true, re-check (with short built-in retries) that the requested field changes and/or note actually landed before returning, and include a `verified` field in the response. Default false: identical to this tool's behavior before this parameter existed, no added delay." }, note_is_private: { type: "boolean" }, send_email: { type: "boolean", description: "Set true together with note_is_private: false to actually email this note to the ticket's contact - uses outcome_id 16 ('Email User' in this tenant's Outcome list) instead of the default 'Private Note' outcome, which never emails regardless of note_is_private. Leave false/unset for anything that should stay internal-only or portal-visible-but-not-emailed; true is ignored (forced to a visible, emailed note) only in the sense that it also forces hiddenfromuser to false, since emailing a note the client can't see back in the portal isn't a coherent request." }, status_id: { type: "number" }, agent_id: { type: "number" }, team_id: { type: "number" }, client_id: { type: "number", description: "Re-link this ticket to a different client/company - e.g. correcting a ticket that came in against a generic/shared account (a voicemail line, a catch-all mailbox) once the real caller/client is identified. Set alongside user_id, which must belong to this client - or alongside site_id when there's no real contact to attach (an automated/system alert), since client_id and site_id have to be a consistent pair: real incident, ticket #22107 (Gold Mechanical) - client_id alone was corrected but site_id was left on the old client's site, so the ticket still displayed as 'Unknown' everywhere in Halo despite client_id being right." }, user_id: { type: "number", description: "Re-link this ticket to a different contact/end-user (find the ID with list_contacts/get_contact - use search_phonenumbers to match a caller's phone number to an existing contact). Must belong to the client given in client_id (or the ticket's current client if client_id is omitted)." }, site_id: { type: "number", description: "Re-link this ticket to a different site (physical location) under its client - use list_sites filtered by client_id to find valid site IDs. Set this alongside client_id whenever relinking a ticket that has no real contact to attach (an automated/system alert) - client_id and site_id must be a consistent pair or the ticket keeps displaying as its old client/site regardless of what client_id says." }, category_1: { type: "string", description: "Category, e.g. 'Infrastructure>Server' — use list_ticket_types/an existing ticket to see this tenant's category tree" }, priority_id: { type: "number", description: "Use list_priorities to find the ID" }, emailto: { type: "string", description: "Correct the ticket's own stored send-to address (HaloPSA's emailtolist field) - independent of, and not automatically kept in sync with, the linked contact's real email on file. Real incident, ticket #22067: a ticket relinked to the correct contact (user_id) still had a stale/wrong emailtolist from before the relink (a guessed company-domain address, not the contact's actual Gmail address on file), so a real client-facing reply went to the wrong address even though the contact record itself was right. Before sending a real reply, compare the ticket's emailtolist against get_contact's emailaddress for the currently-linked user_id - if they differ, set this to the contact's real address first. Pass the exact address(es) HaloPSA expects here (a single address, or semicolon-separated as seen in emailtolist on read)." } }, required: ["ticket_id"] } },
  { name: "update_ticket_draft_only", description: "Identical to update_ticket (same fields: status_id/agent_id/team_id/category_1/priority_id/client_id/site_id/user_id/note all work the same way) EXCEPT any note this tool writes is ALWAYS private and ALWAYS unemailed - note_is_private is forced true and send_email is forced false no matter what you pass, and passing send_email: true or note_is_private: false explicitly returns an error rather than silently sending. Use this instead of update_ticket for a ticket that is not yet approved to receive a real reply - e.g. a -RequireApproval workflow's private draft note (write your intended reply text into `note`, e.g. prefixed '[DRAFT PENDING APPROVAL]', and it will land privately regardless). Real incident: a workflow that relied purely on prompt instructions to hold replies for approval did not reliably hold them - some replies got sent for real anyway. This tool makes that structurally impossible instead of relying on instructions being followed. Always verifies its own write before returning (a couple of short built-in retries against Halo's own eventual-consistency delay - a write can report success and not be immediately readable back) and includes a `verified` field in the response ({confirmed, attempts, fields_confirmed, note_confirmed}) - no separate follow-up read call needed to check.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, note: { type: "string" }, status_id: { type: "number" }, agent_id: { type: "number" }, team_id: { type: "number" }, client_id: { type: "number" }, site_id: { type: "number" }, user_id: { type: "number" }, category_1: { type: "string" }, priority_id: { type: "number" }, emailto: { type: "string", description: "Correct the ticket's own stored send-to address (HaloPSA's emailtolist field) ahead of an eventual real send - see update_ticket's own emailto description for the real incident this fixes. Doesn't cause any email to go out on its own (this tool never sends real email, structurally)." } }, required: ["ticket_id"] } },
  { name: "escalate_emergency", description: "The one-call emergency path, safe to keep available while every other client-facing send is held for human approval: (1) emails the ticket's contact a FIXED, templated acknowledgment - greeting by first name, 'we can see <issue_summary>, we've identified this as a priority issue and are notifying our on-call engineer right now', standard sign-off - the caller supplies only the one short summary phrase (max 200 chars, no links, no line breaks), never the message; (2) pages whoever Halo's Shifts calendar has on call at that moment (their Halo email, plus a text to the Mobile Number on their agent record when one is set) as ONE hidden emailed action on this same ticket, addressed to the on-call address with the SMS gateway CC'd - the subject carries the ticket id, the client never sees it, no second ticket is created (recipients come from Halo's schedule, never from arguments). Nobody scheduled = nobody paged, by design: the audit note records it and on_call_alert.sent is false; (3) writes a private '[EMERGENCY ACK SENT]' audit note; (4) optionally sets status/agent/team in the same call. Once per ticket: refuses if an '[EMERGENCY ACK SENT]' note already exists. If the on-call page fails, the acknowledgment still stands and the response says on_call_alert.sent=false with the error, so the caller can flag it for a human instead. Use dry_run: true to see exactly what would be sent without sending.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, issue_summary: { type: "string", description: "Completes the sentence 'we can see ...' - e.g. 'this is affecting sign-ins to the phone system for your team at Springfield Nissan'. Max 200 chars, plain words, no URLs." }, client_name: { type: "string", description: "Client name for the on-call page (defaults to the ticket's client_name)" }, details_for_on_call: { type: "string", description: "Optional: what's been found so far, for the on-call email body only (max 1500 chars)" }, follow_up_status_id: { type: "number", description: "Status to set after sending (follow_up_status_name's id)" }, team_id: { type: "number" }, agent_id: { type: "number", description: "Usually 1 (Unassigned) - omit to leave assignment alone" }, dry_run: { type: "boolean" }, at: { type: "string", description: "dry_run/page_test only: evaluate the on-call schedule as of this ISO timestamp (UTC) instead of now, to preview who a page at that time would reach" }, page_test: { type: "boolean", description: "Test ONLY the on-call page: sends a clearly-marked TEST page to whoever Halo has on call right now (or at `at`) and touches no client ticket; nobody on call = nothing sent, sent=false. ticket_id and issue_summary are ignored. Use after changing on-call settings." } }, required: [] } },
  { name: "send_approved_draft", description: "FLOW A in one atomic call, so no step can be skipped (real incident, ticket #22390: the reply went out but the draft was never collapsed and the status notes were left behind). Given a ticket whose human-approved draft sits in a private '[DRAFT PENDING APPROVAL]' note, this: (1) optionally corrects the ticket's send-to address (emailto) first; (2) posts the draft's reply text - the lines after the marker, up to any '[INTENDED ...]' line - VERBATIM as a real public emailed reply; (3) collapses the draft note to '[APPROVED DRAFT]'; (4) deletes every '[PIPELINE NOTE]' this pipeline wrote on the ticket; (5) sets status/agent/team; (6) verifies the writes landed. It can only ever send text that already sits in a draft note a human approved - never text supplied in the call. Refuses if there isn't exactly one draft note (or the given draft_action_id isn't one), if the draft has no reply text, or if require_status_id is given and the ticket isn't in that status. dry_run: true shows exactly what would be sent and changed.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, draft_action_id: { type: "number", description: "The draft note's action id. Omit to auto-find the single [DRAFT PENDING APPROVAL] note (refuses if there are 0 or more than 1)." }, status_id: { type: "number", description: "Status to set after sending ([INTENDED STATUS]'s id)" }, agent_id: { type: "number", description: "1 to unassign; omit to leave assignment alone (a human who holds it keeps it)" }, team_id: { type: "number" }, emailto: { type: "string", description: "Correct the ticket's send-to address (emailtolist) before sending - only when the contact's real address differs from it" }, require_status_id: { type: "number", description: "Refuse unless the ticket is currently in this status (pass ai_approved_status_name's id)" }, dry_run: { type: "boolean" } }, required: ["ticket_id"] } },
  { name: "get_on_call", description: "Who is on call right now (or at `at`), read from Halo's own Shifts calendar: the agent whose On-call shift covers that moment, with the email (Halo agent record) and text address (the record's Mobile Number at the email-to-SMS service domain; none = email only) escalate_emergency would page, or nobody when no On-call shift covers that moment (there is no fallback address - the schedule is the only source). Read-only; use it to check the schedule before relying on it.", inputSchema: { type: "object", properties: { at: { type: "string", description: "Optional ISO timestamp (UTC, e.g. 2026-09-22T01:45:00Z) to evaluate instead of now" } }, required: [] } },
  { name: "halo_api_get", description: "Read-only escape hatch: GET any HaloPSA API path (e.g. '/Appointment', '/ShiftType', '/Agent/28') with optional query params, for data no dedicated tool covers. GET only - it cannot change anything. Not part of the Help Desk agent's allowlist; for humans and discovery.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Path under /api, starting with '/'" }, params: { type: "object", additionalProperties: { type: "string" }, description: "Query string parameters" } }, required: ["path"] } },
  { name: "delete_ticket_note", description: "Delete a stale pending draft note this pipeline previously wrote, using HaloPSA's real DELETE /Actions/{id} endpoint - e.g. before writing a revised '[DRAFT PENDING APPROVAL]' draft, so the ticket never accumulates more than one at a time. Deliberately narrow, not a general-purpose delete: this call fetches the action first and refuses (no delete performed) unless it belongs to the given ticket_id, is private (hiddenfromuser: true), and its note contains the exact literal '[DRAFT PENDING APPROVAL]' marker on its own line (not necessarily as the very first characters - a note that also records something else first, e.g. a contact relink, ahead of the marker still matches) - it cannot be used to remove a human's note, a real client-facing reply, or anything this pipeline didn't itself write as a pending draft. Also accepts this pipeline's own transient status notes - a private note whose text carries the literal '[PIPELINE NOTE]' marker on its own line AND whose actionby_application_id is 'Claude' (v2.12.2) - so FLOW A can clear its 'waiting on a human' notes once the ticket proceeds; a human's note can never match that. Real incident: this tool didn't exist for a long time because an earlier investigation found update_ticket has no edit/delete parameter and concluded (correctly, for that tool) that deleting a note wasn't possible at all - it never checked whether HaloPSA's own REST API has a dedicated delete endpoint, which it does (confirmed directly against HaloPSA's own API reference). Without this, a superseded draft was never removed - just left behind as a second, stale note - which piled up into a ticket carrying 3 separate '[DRAFT PENDING APPROVAL]' notes over several revision rounds, tripping FLOW A's own 'exactly one draft note or stop' safety check. Second real incident, ticket #22265: this check originally required the marker to be the very first characters of the note, which refused a legitimate delete because the resolver had recorded a contact relink in the same note ahead of the marker - relaxed to match the marker anywhere on its own line instead.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, action_id: { type: "number", description: "The id of the Action/note to delete, from get_ticket_time_entries' own action list." } }, required: ["ticket_id", "action_id"] } },
  { name: "mark_draft_approved", description: "Collapse a sent '[DRAFT PENDING APPROVAL]' note down to a short '[APPROVED DRAFT]' marker, in place - the full draft text is already redundant once the real reply has actually been sent (it's visible in that reply action itself), so this keeps the ticket's action history from carrying the same reply text twice. Same safety scoping as delete_ticket_note (fetches the action first and refuses - no edit performed - unless it belongs to the given ticket_id, is private, and its note contains the exact literal '[DRAFT PENDING APPROVAL]' marker on its own line, not necessarily as the very first characters), but edits the action's note in place via POST /Actions with its own id (HaloPSA's update-via-POST convention, the same one update_ticket already relies on for /Tickets) instead of deleting it outright - use this when the caller wants a visible trace that a draft existed and was approved, not zero trace at all (delete_ticket_note is still the right call for a superseded draft nobody approved).", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, action_id: { type: "number", description: "The id of the Action/note to collapse, from get_ticket_time_entries' own action list." } }, required: ["ticket_id", "action_id"] } },
  { name: "list_clients", description: "List clients/customers in HaloPSA", inputSchema: { type: "object", properties: { count: { type: "number" }, search: { type: "string" }, include_inactive: { type: "boolean" } } } },
  { name: "get_client", description: "Get full details for a single HaloPSA client by ID", inputSchema: { type: "object", properties: { client_id: { type: "number" } }, required: ["client_id"] } },
  { name: "list_contacts", description: "List end-user contacts in HaloPSA, optionally filtered by client", inputSchema: { type: "object", properties: { client_id: { type: "number" }, search: { type: "string" }, search_phonenumbers: { type: "boolean", description: "Match `search` against contacts' phone/mobile numbers instead of name/email - use this to identify a caller from a callback number (e.g. a voicemail transcript) against existing contacts, rather than name-matching alone." }, count: { type: "number" } } } },
  { name: "get_contact", description: "Get full details for a single contact/end-user by ID", inputSchema: { type: "object", properties: { contact_id: { type: "number" } }, required: ["contact_id"] } },
  { name: "create_contact", description: "Create a new end-user contact in HaloPSA and associate them with a client/company. HaloPSA requires a specific site, not just a client — use list_clients to find the client_id, then list_sites filtered by that client_id to find the site_id (most clients only have one site).", inputSchema: { type: "object", properties: { client_id: { type: "number", description: "The company/client this contact belongs to" }, site_id: { type: "number", description: "Required — the specific site under that client. Look it up with list_sites first." }, firstname: { type: "string" }, surname: { type: "string" }, name: { type: "string", description: "Full display name; if omitted, derived from firstname + surname" }, emailaddress: { type: "string" }, phonenumber: { type: "string" }, mobilenumber: { type: "string" }, title: { type: "string", description: "Job title" }, send_welcome_email: { type: "boolean", description: "Whether HaloPSA should email the new contact a portal welcome/login message" } }, required: ["client_id", "site_id"] } },
  { name: "list_sites", description: "List sites (physical locations) in HaloPSA, optionally filtered by client", inputSchema: { type: "object", properties: { client_id: { type: "number" }, search: { type: "string" }, count: { type: "number" } } } },
  { name: "get_site", description: "Get full details for a single site by ID", inputSchema: { type: "object", properties: { site_id: { type: "number" } }, required: ["site_id"] } },
  { name: "list_assets", description: "List assets/devices in HaloPSA", inputSchema: { type: "object", properties: { count: { type: "number" }, client_id: { type: "number" }, search: { type: "string" } } } },
  { name: "list_agents", description: "List agents (technicians/staff) in HaloPSA. Two separate categories are excluded by default: disabled agents (pass include_inactive) and API-only agents - integration/service identities with no interactive login, e.g. this MCP's own Halo application user (pass include_api_agents). These are independent flags on HaloPSA's own /Agent endpoint (includedisabled vs includeapiagents) - an API-only agent is not necessarily disabled, and vice versa.", inputSchema: { type: "object", properties: { count: { type: "number" }, include_inactive: { type: "boolean" }, include_api_agents: { type: "boolean" } } } },
  { name: "list_teams", description: "List all teams in HaloPSA - use this to resolve team names to IDs for ticket assignment", inputSchema: { type: "object", properties: { count: { type: "number" } } } },
  { name: "list_ticket_types", description: "List all ticket types in HaloPSA with their IDs", inputSchema: { type: "object", properties: {} } },
  { name: "list_statuses", description: "List all ticket statuses in HaloPSA with their IDs", inputSchema: { type: "object", properties: { ticket_type: { type: "number" } } } },
  { name: "list_priorities", description: "List all ticket priorities in HaloPSA with their IDs and SLA targets", inputSchema: { type: "object", properties: {} } },
  { name: "list_outcomes", description: "List valid Action outcome IDs in HaloPSA — required by update_ticket's note field (HaloPSA rejects a ticket note/action with no outcome_id set)", inputSchema: { type: "object", properties: { tickettype_id: { type: "number" } } } },
  { name: "list_slas", description: "List all SLA policies in HaloPSA with response and fix time targets", inputSchema: { type: "object", properties: { count: { type: "number" } } } },
  { name: "list_time_entries", description: "List ticket actions from HaloPSA (time entries/labor, but also notes, emails, and replies — this is the full action log, not billing-only)", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, client_id: { type: "number" }, agent_id: { type: "number" }, count: { type: "number" }, start_date: { type: "string" }, end_date: { type: "string" } } } },
  { name: "get_ticket_time_entries", description: "Get a ticket's full action log: labor/time entries, internal notes, and agent-to-client conversation (emails/replies) — this is also the way to see what a prior agent already told the client. The response also includes a computed `human_touch` field ({found: boolean, actions: [...]}) — every action where a real human agent (who_type: 1, and not an integration posting through a bound agent account - this pipeline's own 'Claude' and Huntress's alert intake are excluded, more via HUMAN_TOUCH_IGNORE_APP_IDS) did something, already filtered out of the full list for you. Use it to answer 'has a human ever touched this ticket' directly rather than re-scanning the full action list yourself — it's the same underlying data, just pre-filtered so a human action buried in a long list can't be missed. Optional as_of (ISO timestamp, Halo time) drops every action dated after it and computes human_touch over the rest - for judging a ticket as it stood at that moment (replays).", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, as_of: { type: "string", description: "Optional ISO timestamp (Halo time, e.g. 2026-09-17T12:30:00). Actions dated after it are dropped and human_touch is computed over what remains." } }, required: ["ticket_id"] } },
  { name: "list_invoices", description: "List invoices from HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, count: { type: "number" }, start_date: { type: "string" }, end_date: { type: "string" }, search: { type: "string" } } } },
  { name: "get_invoice", description: "Get full details of a single invoice by ID including line items", inputSchema: { type: "object", properties: { invoice_id: { type: "number" } }, required: ["invoice_id"] } },
  { name: "list_recurring_invoices", description: "List recurring invoices (MRR contracts) in HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, count: { type: "number" }, active_only: { type: "boolean" } } } },
  { name: "get_recurring_invoice", description: "Get full details of a recurring invoice/contract including line items and MRR", inputSchema: { type: "object", properties: { recurring_invoice_id: { type: "number" } }, required: ["recurring_invoice_id"] } },
  { name: "list_quotes", description: "List quotes/proposals in HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, count: { type: "number" }, search: { type: "string" } } } },
  { name: "get_quote", description: "Get full details of a single quote including line items and status", inputSchema: { type: "object", properties: { quote_id: { type: "number" } }, required: ["quote_id"] } },
  { name: "list_appointments", description: "List scheduled appointments and on-site visits in HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, agent_id: { type: "number" }, start_date: { type: "string" }, end_date: { type: "string" }, count: { type: "number" } } } },
  { name: "get_appointment", description: "Get full details of a single appointment by ID", inputSchema: { type: "object", properties: { appointment_id: { type: "number" } }, required: ["appointment_id"] } },
  { name: "list_kb_articles", description: "Search and list knowledge base articles in HaloPSA", inputSchema: { type: "object", properties: { search: { type: "string" }, count: { type: "number" } } } },
  { name: "get_kb_article", description: "Get the full content of a single knowledge base article by ID", inputSchema: { type: "object", properties: { article_id: { type: "number" } }, required: ["article_id"] } },
  { name: "list_opportunities", description: "List sales opportunities/pipeline in HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, count: { type: "number" }, search: { type: "string" } } } },
  { name: "get_opportunity", description: "Get full details of a single opportunity by ID", inputSchema: { type: "object", properties: { opportunity_id: { type: "number" } }, required: ["opportunity_id"] } },
  { name: "list_software_licences", description: "List software licence subscriptions tracked in HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, count: { type: "number" }, search: { type: "string" } } } },
  { name: "list_contracts", description: "List contracts (time bank, block hours, prepay) in HaloPSA", inputSchema: { type: "object", properties: { client_id: { type: "number" }, count: { type: "number" } } } },
  { name: "get_contract", description: "Get full details of a single contract including remaining hours/value", inputSchema: { type: "object", properties: { contract_id: { type: "number" } }, required: ["contract_id"] } },
];
async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": { const token = await getToken(env); return `Connected OK to ${env.HALO_BASE_URL} tenant:${env.HALO_TENANT} token:${token.substring(0, 20)}`; }
    case "list_tickets": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.open_only !== false) p.open_only = "true"; if (args.client_id) p.client_id = String(args.client_id); if (args.agent_id) p.agent_id = String(args.agent_id); if (args.team_id) p.team_id = String(args.team_id); if (args.status_id) p.status_id = String(args.status_id); if (args.pageinate) p.pageinate = "true"; if (args.page_no) p.page_no = String(args.page_no); if (args.page_size) p.page_size = String(args.page_size); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Tickets", p), null, 2); }
    case "get_ticket": return JSON.stringify(await haloGet(env, `/Tickets/${args.ticket_id}`), null, 2);
    case "get_ticket_brief": {
      const t = (await haloGet(env, `/Tickets/${args.ticket_id}`)) as any;
      return JSON.stringify(trimTicket(t, Number(args.max_details_chars ?? 6000)), null, 2);
    }
    case "get_ticket_history": {
      const count = Math.min(Math.max(Number(args.count ?? 100), 1), 200);
      const data = (await haloGet(env, "/Actions", { ticket_id: String(args.ticket_id), count: String(count) })) as any;
      const cut = applyAsOf(data.actions || [], args.as_of);
      const actions: any[] = cut.actions;
      const maxNote = Number(args.max_note_chars ?? 3000);
      return JSON.stringify({ ticket_id: args.ticket_id, record_count: data.record_count ?? actions.length, as_of: cut.applied, actions_hidden_after_as_of: cut.hidden, human_touch: computeHumanTouch(actions, env), actions: actions.map((a) => trimAction(a, maxNote)) }, null, 2);
    }
    case "create_ticket": { const payload: Record<string, unknown> = { summary: args.summary, details: args.details ?? "" }; if (args.client_id) payload.client_id = args.client_id; if (args.user_id) payload.user_id = args.user_id; if (args.team_id) payload.team_id = args.team_id; if (args.agent_id) payload.agent_id = args.agent_id; if (args.tickettype_id) payload.tickettype_id = args.tickettype_id; if (args.priority_id) payload.priority_id = args.priority_id; return JSON.stringify(await haloPost(env, "/Tickets", [payload]), null, 2); }
    case "update_ticket": {
      const results: Record<string, unknown> = {};
      const fieldPayload: Record<string, unknown> = { id: args.ticket_id };
      let hasFieldChange = false;
      if (args.status_id) { fieldPayload.status_id = args.status_id; hasFieldChange = true; }
      if (args.agent_id && await guardUnassign(env, args.ticket_id, args.agent_id, results)) { fieldPayload.agent_id = args.agent_id; hasFieldChange = true; }
      if (args.team_id) { fieldPayload.team_id = args.team_id; hasFieldChange = true; }
      if (args.category_1) { fieldPayload.category_1 = args.category_1; hasFieldChange = true; }
      if (args.priority_id) { fieldPayload.priority_id = args.priority_id; hasFieldChange = true; }
      if (args.client_id) { fieldPayload.client_id = args.client_id; hasFieldChange = true; }
      if (args.site_id) { fieldPayload.site_id = args.site_id; hasFieldChange = true; }
      if (args.user_id) { fieldPayload.user_id = args.user_id; hasFieldChange = true; }
      // emailto: real incident, ticket #22067 - the ticket's own emailtolist
      // field ("twilder@thompsonsales.com") was stale/wrong (a guessed
      // company-domain address, not the contact's real one) and didn't get
      // refreshed when the ticket was later manually relinked to the correct
      // contact (whose actual, only email on file is a personal Gmail
      // address) - HaloPSA's own contact record was right, but the ticket-
      // level send-to field never picked that up, and a real client-facing
      // reply went to the wrong, likely-nonexistent address as a result.
      // Lets a caller correct emailtolist directly, the same POST-with-id
      // convention as client_id/site_id/user_id above. Field name confirmed
      // from a live GET /Tickets/{id} response (the ticket object's own
      // "emailtolist" property) - not yet independently confirmed that this
      // same name is accepted on write, only that it's the correct read-side
      // name; verify: true (update_ticket) or this tool's own always-on
      // verify is the way to confirm this specific field actually lands.
      if (args.emailto) { fieldPayload.emailtolist = args.emailto; hasFieldChange = true; }
      if (hasFieldChange) results.ticket = await haloPost(env, "/Tickets", [fieldPayload]);
      // Notes are a separate resource in HaloPSA (POST /Actions) — nesting an
      // "actions" array inside a POST /Tickets payload is silently ignored by
      // the API (no error, no action created), so this must be a second call.
      // outcome_id is mandatory on every Action — HaloPSA rejects a note with none.
      //
      // REAL INCIDENT: this used to hardcode outcome_id: 7 ("Private Note" in
      // this tenant's Outcome list, confirmed via list_outcomes) for every
      // note regardless of hiddenfromuser, on the assumption that
      // hiddenfromuser alone controlled client-facing delivery. It doesn't -
      // list_outcomes shows outcome 7 has hidesendemail: true (HaloPSA hides
      // its own "send email" control entirely for that outcome), so a note
      // posted through it can never trigger an outbound email to the client
      // no matter what hiddenfromuser says. A real ticket (HelpDeskAgent's
      // #21702) confirmed this: a reply sent with hiddenfromuser: false via
      // outcome 7 recorded successfully in Halo but the client never
      // received anything.
      // Outcome 16 ("Email User" in the same tenant's Outcome list) has
      // hidesendemail: false and sendemail: 1 - it's the outcome type that
      // actually emails the ticket's contact. send_email: true now selects
      // that outcome instead of the default Private Note one. Emailing a
      // note the client can't even see in the portal isn't a coherent
      // request, so send_email: true also forces hiddenfromuser to false
      // regardless of what note_is_private says.
      if (args.note) {
        const sendEmail = args.send_email === true;
        // Pipeline marker notes ([PIPELINE NOTE], [DRAFT PENDING APPROVAL],
        // [NEEDS ...], [EMERGENCY ACK SENT], [APPROVED DRAFT]) are internal by
        // definition - force them private even when the caller forgot
        // note_is_private (real incident, ticket #22484: a [PIPELINE NOTE]
        // landed with hiddenfromuser false).
        const markerNote = /^\s*\[(PIPELINE NOTE|DRAFT PENDING APPROVAL|APPROVED DRAFT|EMERGENCY ACK SENT|NEEDS [A-Z ]+|INTENDED [A-Z ]+|CACHE:)/i.test(String(args.note));
        const hidden = sendEmail ? false : ((args.note_is_private ?? false) || markerNote);
        const outcomeId = sendEmail ? 16 : 7;
        const actionPayload: Record<string, unknown> = { ticket_id: args.ticket_id, note: args.note, note_html: noteToHtml(args.note as string), hiddenfromuser: hidden, outcome_id: outcomeId };
        // REAL INCIDENT, CONFIRMED DEAD END: every note/action created via
        // this OAuth client_credentials app is attributed to whichever agent
        // that app is bound to in Halo's own admin config ("Login Type:
        // Agent" on the API application). Two different attempts to override
        // this per-action from the request payload - an explicit
        // who_agentid field, then also plain agentid alongside it (in case
        // who_agentid was a read-only display field and agentid the real
        // writable column, matching the includedisabled/includeinactive
        // mismatch already found once in this file's list_agents) - were
        // both live-tested against real tickets and had zero effect on the
        // resulting attribution. There is no payload field that fixes this;
        // don't re-add one without new evidence it actually works. The only
        // real fixes are outside this API entirely: rebind the OAuth
        // application to a different Halo agent in Halo's own admin
        // settings, or rename that bound agent's account - both are human
        // decisions, not something this tool can do.
        results.action = await haloPost(env, "/Actions", [actionPayload]);
      }
      // Opt-in only (verify: true) - existing callers of this tool that
      // don't pass it see byte-for-byte the same response shape/timing as
      // before this existed. See verifyWrite's own comment above for why
      // this exists at all: a write can report success and still not be
      // immediately readable back, and confirming that costs real
      // wall-clock delay a caller may not always want to pay for.
      if (args.verify === true) {
        results.verified = await verifyWrite(env, args, hasFieldChange, !!args.note);
      }
      return JSON.stringify(results, null, 2);
    }
    case "update_ticket_draft_only": {
      // Structural safety net for an approval-hold workflow (see
      // HelpDeskAgent's resolver-prompt.md / -RequireApproval) - real
      // incident: a prompt-only "draft this privately, don't send it for
      // real yet" instruction was not reliably followed on every ticket,
      // especially by a cheaper/faster model under a long prompt - several
      // tickets got a real, emailed client-facing reply despite the run
      // requiring human sign-off first, because the only enforcement was
      // the model choosing to follow that instruction over other, more
      // concrete "reply now" instructions written elsewhere in the same
      // document. update_ticket itself can't just be removed from a
      // non-approved ticket's toolset - the approval workflow's own
      // draft/status/unassign bookkeeping needs some update_ticket-shaped
      // tool to work - so this is a separate tool, same shape, except a
      // note can only ever land private and unemailed, structurally,
      // regardless of what's passed. Loudly rejecting an explicit attempt
      // to override that (rather than silently downgrading it) means a
      // caller that does try to send for real finds out immediately, in
      // its own next turn, rather than believing it succeeded.
      if (args.send_email === true || args.note_is_private === false) {
        throw new Error("update_ticket_draft_only can never send a public or emailed reply - note_is_private is always forced true and send_email is always forced false, regardless of what's passed. This ticket has not been approved to receive a real reply yet; write it as a private draft note instead (e.g. prefixed '[DRAFT PENDING APPROVAL]') and hold it for human sign-off.");
      }
      const results: Record<string, unknown> = {};
      const fieldPayload: Record<string, unknown> = { id: args.ticket_id };
      let hasFieldChange = false;
      if (args.status_id) { fieldPayload.status_id = args.status_id; hasFieldChange = true; }
      if (args.agent_id && await guardUnassign(env, args.ticket_id, args.agent_id, results)) { fieldPayload.agent_id = args.agent_id; hasFieldChange = true; }
      if (args.team_id) { fieldPayload.team_id = args.team_id; hasFieldChange = true; }
      if (args.category_1) { fieldPayload.category_1 = args.category_1; hasFieldChange = true; }
      if (args.priority_id) { fieldPayload.priority_id = args.priority_id; hasFieldChange = true; }
      if (args.client_id) { fieldPayload.client_id = args.client_id; hasFieldChange = true; }
      if (args.site_id) { fieldPayload.site_id = args.site_id; hasFieldChange = true; }
      if (args.user_id) { fieldPayload.user_id = args.user_id; hasFieldChange = true; }
      // emailto: real incident, ticket #22067 - the ticket's own emailtolist
      // field ("twilder@thompsonsales.com") was stale/wrong (a guessed
      // company-domain address, not the contact's real one) and didn't get
      // refreshed when the ticket was later manually relinked to the correct
      // contact (whose actual, only email on file is a personal Gmail
      // address) - HaloPSA's own contact record was right, but the ticket-
      // level send-to field never picked that up, and a real client-facing
      // reply went to the wrong, likely-nonexistent address as a result.
      // Lets a caller correct emailtolist directly, the same POST-with-id
      // convention as client_id/site_id/user_id above. Field name confirmed
      // from a live GET /Tickets/{id} response (the ticket object's own
      // "emailtolist" property) - not yet independently confirmed that this
      // same name is accepted on write, only that it's the correct read-side
      // name; verify: true (update_ticket) or this tool's own always-on
      // verify is the way to confirm this specific field actually lands.
      if (args.emailto) { fieldPayload.emailtolist = args.emailto; hasFieldChange = true; }
      if (hasFieldChange) results.ticket = await haloPost(env, "/Tickets", [fieldPayload]);
      if (args.note) {
        // REAL INCIDENT, ticket #22231: FLOW A's approval send came out with
        // every paragraph break stripped to nothing - not just missing <br>,
        // but zero separation at all between sentences and the signature
        // block. Root cause, confirmed against a second action on the same
        // ticket: HaloPSA's GET /Actions reconstructs the plain `note` field
        // from `note_html` (tags stripped, no whitespace substituted)
        // whenever `note_html` is present on that action, rather than
        // returning the literal text originally written - a Halo AI Triage
        // note on the same ticket with no note_html set preserved its \r\n
        // perfectly on the same GET call. This tool writes the private
        // "[DRAFT PENDING APPROVAL]" note that FLOW A later reads back and
        // resends verbatim (see HelpDeskAgent's resolver-prompt.md/FLOW A
        // step 2), so setting note_html here silently corrupts that
        // round-trip - the draft comes back with no line breaks, and FLOW A
        // faithfully copies the already-mangled text into the real send.
        // This note is always private (hiddenfromuser forced true, never
        // emailed) and Halo's own ticket UI already renders bare `\n`
        // forgivingly, so note_html served no purpose here in the first
        // place - only omitted from this call, not from update_ticket's
        // (the actual client email still needs it, and reads fresh,
        // uncorrupted text at that point).
        const actionPayload: Record<string, unknown> = { ticket_id: args.ticket_id, note: args.note, hiddenfromuser: true, outcome_id: 7 };
        results.action = await haloPost(env, "/Actions", [actionPayload]);
      }
      // Always verified (unlike update_ticket's opt-in) - this tool exists
      // solely for HelpDeskAgent's approval-hold flow, which specifically
      // needs to know whether its draft note/status actually landed before
      // deciding whether the ticket is safely holding for human review or
      // needs a [CACHE: BLOCKED] instead. No other caller exists for this
      // tool to have its behavior change under.
      results.verified = await verifyWrite(env, args, hasFieldChange, !!args.note);
      return JSON.stringify(results, null, 2);
    }
    case "escalate_emergency": {
      const isPageTest = args.page_test === true;
      const ticketId = Number(args.ticket_id);
      if (!Number.isInteger(ticketId) || ticketId <= 0) throw new Error(isPageTest ? "escalate_emergency: page_test needs ticket_id = a scratch/test ticket of ours to hang the test page on (never a client's ticket)." : "escalate_emergency: ticket_id must be a positive integer.");
      const summary = isPageTest ? "TEST ONLY - verifying the on-call page from Allie; no action needed" : String(args.issue_summary ?? "").replace(/\s+/g, " ").trim();
      if (!summary) throw new Error("escalate_emergency: issue_summary is required.");
      if (summary.length > 200) throw new Error("escalate_emergency: issue_summary must be 200 characters or fewer - it completes one sentence, it is not the message.");
      if (/https?:\/\/|www\.|<[a-z\/]/i.test(summary)) throw new Error("escalate_emergency: issue_summary may not contain links or HTML.");
      const ticket = (await haloGet(env, `/Tickets/${ticketId}`)) as any;
      const history = isPageTest ? { actions: [] } : (await haloGet(env, "/Actions", { ticket_id: String(ticketId), count: "100" })) as any;
      const priorActions: any[] = history.actions || [];
      const already = priorActions.find((a: any) => typeof a.note === "string" && /\[EMERGENCY ACK SENT\]/.test(a.note));
      if (already) throw new Error(`escalate_emergency: ticket ${ticketId} already had its emergency acknowledgment sent (action ${already.id} at ${already.datetime}) - this runs once per ticket. Do not send another; if on-call still needs re-paging, say so in a private note for a human.`);
      const rawName = String(ticket.user_name ?? "").trim();
      const looksLikeEmail = /@/.test(rawName);
      const firstName = looksLikeEmail || !rawName || /^(general user|unknown)$/i.test(rawName) ? "there" : rawName.split(/\s+/)[0];
      const signature = env.EMERGENCY_ACK_SIGNATURE || "Here to help,\nAllie\nVirtual Service Coordinator\nAltec Solutions Group\nAllie is Altec's AI-powered virtual service coordinator. Responses are reviewed by our service team.";
      const ack = `Hi ${firstName},\n\nThank you for letting us know - we can see ${summary.replace(/[.!?]+$/, "")}. We've identified this as a priority issue and are notifying our on-call engineer right now.\n\n${signature}`;
      const clientName = isPageTest ? "TEST" : String(args.client_name ?? ticket.client_name ?? "Unknown client").trim();
      const details = args.details_for_on_call ? String(args.details_for_on_call).slice(0, 1500) : "";
      // `at` is a preview aid only: a real send always pages whoever is on call now.
      const previewOnly = args.dry_run === true || isPageTest;
      const atArg = previewOnly && args.at ? new Date(String(args.at)) : null;
      if (atArg && Number.isNaN(atArg.getTime())) throw new Error("escalate_emergency: `at` must be an ISO timestamp, e.g. 2026-09-22T01:45:00Z.");
      const onCallResolved = await resolveOnCall(env, atArg ?? new Date());
      const onCallEmail = onCallResolved.emailto;
      const onCallCc = onCallResolved.emailcc.join(";");
      const pageSubject = isPageTest ? `[TEST] Allie on-call page - no action needed` : `[EMERGENCY] ${clientName}: ${summary.slice(0, 90)} (Help Desk ticket #${ticketId})`;
      const onCallWho = { source: onCallResolved.source, at: onCallResolved.at, agents: onCallResolved.on_call.map((p) => ({ agent_id: p.agent_id, name: p.agent_name, email: p.email, mobile: p.mobile, sms: p.sms, shift: p.shift })), lookup_error: onCallResolved.error ?? null };
      const onCallLabel = onCallResolved.source === "halo" ? `${onCallResolved.on_call.filter((p) => p.email).map((p) => `${p.agent_name || `agent ${p.agent_id}`}${p.sms.length ? " (email + text)" : " (email only - no mobile number on their Halo record)"}`).join(", ")}, on call per Halo's schedule` : (onCallResolved.error ?? "nobody to page");
      const pageBody = [isPageTest ? `TEST PAGE - no action needed` : `EMERGENCY - ${clientName}`, `Ticket #${ticketId}${ticket.summary ? ` - ${String(ticket.summary).slice(0, 120)}` : ""}`, ``, summary, details ? `` : ``, details ? `Found so far: ${details}` : ``, ``, isPageTest ? `Sent automatically by Allie as a TEST of the on-call page.` : `Sent automatically by Allie. The client has been emailed a brief acknowledgment saying on-call is being notified.`].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
      if (args.dry_run === true) {
        return JSON.stringify({ dry_run: true, would_email_contact: ticket.emailtolist ?? null, acknowledgment: ack, on_call_alert: { would_page: onCallEmail !== null, hidden_action_on_ticket: ticketId, emailto: onCallEmail, emailcc: onCallCc, on_call: onCallWho, body: pageBody }, status_change: { status_id: args.follow_up_status_id ?? null, agent_id: args.agent_id ?? null, team_id: args.team_id ?? null } }, null, 2);
      }
      // 1. the templated acknowledgment, as a real emailed reply (outcome 16) - skipped for a page test
      const ackResult = isPageTest ? null : await haloPost(env, "/Actions", [{ ticket_id: ticketId, note: ack, note_html: noteToHtml(ack), hiddenfromuser: false, outcome_id: 16 }]);
      // 2. page on-call; a failure here never undoes step 1. Nobody scheduled =
      // nobody paged (no fallback) - the audit note and sent=false carry that.
      let onCall: Record<string, unknown> = { sent: false, via: "ticket", on_call: onCallWho, error: onCallResolved.error ?? "nobody to page" };
      if (onCallEmail) {
        // The page is a hidden action on the ticket itself: outcome 16 (Email
        // User) makes Halo send it, emailto/emailcc override the recipients so
        // it goes to on-call instead of the client, hiddenfromuser keeps it out
        // of the client's portal view. The note text is the audit trail.
        try {
          const pagePayload: Record<string, unknown> = { ticket_id: ticketId, note: pageBody, note_html: noteToHtml(pageBody), hiddenfromuser: true, outcome_id: 16, emailto: onCallEmail, emailsubject: pageSubject };
          if (onCallCc) pagePayload.emailcc = onCallCc;
          const posted = (await haloPost(env, "/Actions", [pagePayload])) as any;
          const postedAction = Array.isArray(posted) ? posted[0] : posted;
          onCall = { sent: true, via: "ticket", action_id: postedAction?.id ?? null, to: [onCallEmail].concat(onCallCc ? onCallCc.split(";") : []), on_call: onCallWho, email_status: postedAction?.email_status ?? null, dateemailed: postedAction?.dateemailed ?? null, emailto_recorded: postedAction?.emailto ?? null, hiddenfromuser: postedAction?.hiddenfromuser ?? null };
        } catch (err) {
          onCall = { sent: false, via: "ticket", on_call: onCallWho, error: (err as Error).message };
        }
      }
      if (isPageTest) return JSON.stringify({ page_test: true, on_call_alert: onCall }, null, 2);
      // 3. audit note
      const audit = `[EMERGENCY ACK SENT] ${new Date().toISOString()} - acknowledgment emailed to ${ticket.emailtolist ?? "(no address on ticket)"}; on-call ${onCall.sent ? `paged: ${onCallLabel} - sent to ${(onCall.to as string[] | undefined)?.join(", ") ?? ""}` : `NOT paged - ${onCall.error}`}. Summary: ${summary}`;
      await haloPost(env, "/Actions", [{ ticket_id: ticketId, note: audit, note_html: noteToHtml(audit), hiddenfromuser: true, outcome_id: 7 }]);
      // 4. optional status/assignment
      let ticketUpdate: unknown = null;
      const fieldPayload: Record<string, unknown> = { id: ticketId };
      let hasField = false;
      if (args.follow_up_status_id) { fieldPayload.status_id = args.follow_up_status_id; hasField = true; }
      if (args.agent_id !== undefined && args.agent_id !== null) { fieldPayload.agent_id = args.agent_id; hasField = true; }
      if (args.team_id) { fieldPayload.team_id = args.team_id; hasField = true; }
      if (hasField) ticketUpdate = await haloPost(env, "/Tickets", [fieldPayload]);
      return JSON.stringify({ acknowledgment_sent_to: ticket.emailtolist ?? null, acknowledgment: ack, ack_action: ackResult, on_call_alert: onCall, ticket_update: ticketUpdate }, null, 2);
    }
    case "send_approved_draft": {
      const ticketId = Number(args.ticket_id);
      if (!Number.isInteger(ticketId) || ticketId <= 0) throw new Error("send_approved_draft: ticket_id must be a positive integer.");
      const ticket = (await haloGet(env, `/Tickets/${ticketId}`)) as any;
      if (args.require_status_id !== undefined && args.require_status_id !== null && Number(ticket.status_id) !== Number(args.require_status_id)) {
        throw new Error(`send_approved_draft: ticket ${ticketId} is in status ${ticket.status_id}, not the required ${args.require_status_id} - a draft is only sent from the approved status. Nothing was sent.`);
      }
      const history = (await haloGet(env, "/Actions", { ticket_id: String(ticketId), count: "100" })) as any;
      const all: any[] = history.actions || [];
      const drafts = all.filter((a: any) => a.hiddenfromuser === true && typeof a.note === "string" && hasDraftMarker(a.note));
      let draft: any = null;
      if (args.draft_action_id) {
        draft = drafts.find((a: any) => Number(a.id) === Number(args.draft_action_id)) ?? null;
        if (!draft) throw new Error(`send_approved_draft: action ${args.draft_action_id} is not a private [DRAFT PENDING APPROVAL] note on ticket ${ticketId}. Nothing was sent.`);
      } else {
        if (drafts.length !== 1) throw new Error(`send_approved_draft: expected exactly one [DRAFT PENDING APPROVAL] note on ticket ${ticketId}, found ${drafts.length} (${drafts.map((a: any) => a.id).join(", ") || "none"}). Nothing was sent - flag this for a human.`);
        draft = drafts[0];
      }
      // Reply text: everything after the marker line, stopping at the first [INTENDED ...] line.
      const rawNote: string = String(draft.note ?? "");
      const lines = rawNote.split(/\r\n|\r|\n/);
      const markerIdx = lines.findIndex((l) => l.trim() === "[DRAFT PENDING APPROVAL]");
      if (markerIdx < 0) throw new Error(`send_approved_draft: draft ${draft.id} has no marker line. Nothing was sent.`);
      const bodyLines: string[] = [];
      for (const l of lines.slice(markerIdx + 1)) { if (/^\s*\[INTENDED /i.test(l)) break; bodyLines.push(l); }
      const replyText = bodyLines.join("\n").trim();
      if (!replyText) throw new Error(`send_approved_draft: draft ${draft.id} has no reply text after the marker. Nothing was sent.`);
      const pipelineNotes = all.filter((a: any) => a.hiddenfromuser === true && typeof a.note === "string" && hasPipelineNoteMarker(a.note) && String(a.actionby_application_id ?? "") === "Claude");
      const currentEmailTo = String(ticket.emailtolist ?? "");
      const emailFix = args.emailto && String(args.emailto).trim() && String(args.emailto).trim() !== currentEmailTo ? String(args.emailto).trim() : null;
      const fieldPayload: Record<string, unknown> = { id: ticketId };
      let hasField = false;
      if (args.status_id) { fieldPayload.status_id = args.status_id; hasField = true; }
      const guardNotes: Record<string, unknown> = {};
      if (args.agent_id !== undefined && args.agent_id !== null && await guardUnassign(env, ticketId, args.agent_id, guardNotes)) { fieldPayload.agent_id = args.agent_id; hasField = true; }
      if (args.team_id) { fieldPayload.team_id = args.team_id; hasField = true; }
      if (args.dry_run === true) {
        return JSON.stringify({ dry_run: true, draft_action_id: draft.id, would_send_to: emailFix ?? currentEmailTo, emailto_correction: emailFix, reply_text: replyText, would_collapse_draft: true, would_delete_pipeline_notes: pipelineNotes.map((a: any) => a.id), would_update: hasField ? fieldPayload : null }, null, 2);
      }
      const result: Record<string, unknown> = { ticket_id: ticketId, draft_action_id: draft.id, ...guardNotes };
      if (emailFix) { await haloPost(env, "/Tickets", [{ id: ticketId, emailtolist: emailFix }]); result.emailto_corrected_to = emailFix; }
      const sent = (await haloPost(env, "/Actions", [{ ticket_id: ticketId, note: replyText, note_html: noteToHtml(replyText), hiddenfromuser: false, outcome_id: 16 }])) as any;
      const sentAction = Array.isArray(sent) ? sent[0] : sent;
      result.sent_to = emailFix ?? currentEmailTo;
      result.reply_action_id = sentAction?.id ?? null;
      try {
        const shortNote = "[APPROVED DRAFT]";
        await haloPost(env, "/Actions", [{ id: draft.id, ticket_id: ticketId, note: shortNote, note_html: noteToHtml(shortNote), hiddenfromuser: true, outcome_id: 7 }]);
        result.draft_collapsed = true;
      } catch (err) { result.draft_collapsed = false; result.draft_collapse_error = (err as Error).message; }
      const deleted: number[] = []; const deleteErrors: string[] = [];
      for (const n of pipelineNotes) {
        try { await haloDelete(env, `/Actions/${n.id}`, { ticket_id: String(ticketId) }); deleted.push(Number(n.id)); }
        catch (err) { deleteErrors.push(`${n.id}: ${(err as Error).message}`); }
      }
      result.pipeline_notes_deleted = deleted; if (deleteErrors.length) result.pipeline_note_delete_errors = deleteErrors;
      if (hasField) result.ticket_update = await haloPost(env, "/Tickets", [fieldPayload]);
      result.verified = await verifyWrite(env, { ticket_id: ticketId, status_id: args.status_id, agent_id: args.agent_id, team_id: args.team_id, note: replyText }, hasField, true);
      return JSON.stringify(result, null, 2);
    }
    case "get_on_call": {
      const at = args.at ? new Date(String(args.at)) : new Date();
      if (Number.isNaN(at.getTime())) throw new Error("get_on_call: `at` must be an ISO timestamp, e.g. 2026-09-22T01:45:00Z.");
      const r = await resolveOnCall(env, at);
      return JSON.stringify({ at: r.at, source: r.source, would_page: r.emailto ? { emailto: r.emailto, emailcc: r.emailcc } : null, on_call: r.on_call, shift_type_id: Number(env.ON_CALL_SHIFT_TYPE_ID || 1), sms_domain: (env.ON_CALL_SMS_DOMAIN || "altec.text.email").replace(/^@/, ""), error: r.error ?? null, note: r.source === "halo" ? (r.on_call.some((p) => p.sms.length) ? "The scheduled on-call agent from Halo's Shifts calendar - email and text." : "The scheduled on-call agent from Halo's Shifts calendar - EMAIL ONLY: no Mobile Number on their Halo agent record.") : "Nobody has an On-call shift covering this moment in Halo. escalate_emergency would still acknowledge the client, but would page NOBODY (there is no fallback address) and record that on the ticket." }, null, 2);
    }
    case "halo_api_get": {
      const path = String(args.path ?? "");
      if (!path.startsWith("/") || path.includes("..")) throw new Error("halo_api_get: path must start with '/' and contain no '..'.");
      const params = (args.params && typeof args.params === "object") ? Object.fromEntries(Object.entries(args.params as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined;
      const data = await haloGet(env, path, params);
      const text = JSON.stringify(data, null, 2);
      return text.length > 60000 ? text.slice(0, 60000) + "\n... [truncated]" : text;
    }
    case "delete_ticket_note": {
      // Deliberately scoped to exactly one use case - superseding this
      // pipeline's own pending draft - rather than a general delete, since
      // an LLM-driven caller getting an action_id wrong (a stale ID, a
      // miscount, a hallucinated number) would otherwise be one call away
      // from permanently destroying a human's note or a real client-facing
      // reply, with no undo. Fetching the action first and checking its
      // real fields, rather than trusting the caller's claim about what it
      // is, is the same "verify before trusting" discipline update_ticket's
      // own verify path already uses elsewhere in this file.
      // GET /Actions/{id} requires ticket_id as a query param (confirmed
      // against HaloPSA's own API docs) - without it the call 400s before
      // any of the checks below even run, which is safe (fails closed, no
      // delete happens) but means this tool could never actually work.
      const action = (await haloGet(env, `/Actions/${args.action_id}`, { ticket_id: String(args.ticket_id) })) as any;
      if (!action || typeof action !== "object") {
        throw new Error(`delete_ticket_note: no action found with id ${args.action_id}.`);
      }
      if (Number(action.ticket_id) !== Number(args.ticket_id)) {
        throw new Error(`delete_ticket_note: action ${args.action_id} belongs to ticket ${action.ticket_id}, not ${args.ticket_id} - refusing to delete a note on the wrong ticket.`);
      }
      const note: string = typeof action.note === "string" ? action.note : "";
      const isOwnPipelineNote = hasPipelineNoteMarker(note) && String(action.actionby_application_id ?? "") === "Claude";
      // Our own [PIPELINE NOTE] is deletable even when it was posted without
      // hiddenfromuser (ticket #22484, 2026-09-22): it is this pipeline's text,
      // never a client's or a colleague's. Everything else must be private.
      if (action.hiddenfromuser !== true && !isOwnPipelineNote) {
        throw new Error(`delete_ticket_note: action ${args.action_id} is not a private note (hiddenfromuser is not true) - refusing to delete anything that could be a real, client-visible action.`);
      }
      if (!hasDraftMarker(note) && !isOwnPipelineNote) {
        throw new Error(`delete_ticket_note: action ${args.action_id}'s note contains neither the literal "[DRAFT PENDING APPROVAL]" marker nor a "[PIPELINE NOTE]" marker authored by this pipeline (actionby_application_id "Claude") on its own line - refusing to delete anything that isn't clearly this pipeline's own draft or status note.`);
      }
      // DELETE /Actions/{id} also requires ticket_id as a query param
      // (confirmed live: "ticket_id must be included when deleting an
      // Action.") - same required-param pattern as the GET fetch above.
      await haloDelete(env, `/Actions/${args.action_id}`, { ticket_id: String(args.ticket_id) });
      return JSON.stringify({ deleted: true, action_id: args.action_id, ticket_id: args.ticket_id }, null, 2);
    }
    case "mark_draft_approved": {
      // Same fetch-and-verify-first discipline as delete_ticket_note right
      // above - same reason: an LLM caller with a wrong action_id should
      // never be one call away from silently rewriting a human's note or a
      // real client-facing reply.
      const action = (await haloGet(env, `/Actions/${args.action_id}`, { ticket_id: String(args.ticket_id) })) as any;
      if (!action || typeof action !== "object") {
        throw new Error(`mark_draft_approved: no action found with id ${args.action_id}.`);
      }
      if (Number(action.ticket_id) !== Number(args.ticket_id)) {
        throw new Error(`mark_draft_approved: action ${args.action_id} belongs to ticket ${action.ticket_id}, not ${args.ticket_id} - refusing to edit a note on the wrong ticket.`);
      }
      if (action.hiddenfromuser !== true) {
        throw new Error(`mark_draft_approved: action ${args.action_id} is not a private note (hiddenfromuser is not true) - refusing to edit anything that could be a real, client-visible action.`);
      }
      const note: string = typeof action.note === "string" ? action.note : "";
      if (!hasDraftMarker(note)) {
        throw new Error(`mark_draft_approved: action ${args.action_id}'s note does not contain the literal "[DRAFT PENDING APPROVAL]" marker on its own line - refusing to edit anything that isn't clearly this pipeline's own pending draft.`);
      }
      // HaloPSA's update-via-POST convention (confirmed already in this file
      // for /Tickets - update_ticket's field-change branch POSTs a payload
      // containing the existing id rather than using a separate PUT verb):
      // POSTing to /Actions with the action's own id edits that action in
      // place instead of creating a new one. Not yet independently
      // re-verified specifically for /Actions from a live call - worth
      // confirming the first time this runs for real, the same way every
      // other not-yet-deployed MCP change this project ships gets flagged.
      const shortNote = "[APPROVED DRAFT]";
      await haloPost(env, "/Actions", [{ id: args.action_id, ticket_id: args.ticket_id, note: shortNote, note_html: noteToHtml(shortNote), hiddenfromuser: true, outcome_id: 7 }]);
      return JSON.stringify({ edited: true, action_id: args.action_id, ticket_id: args.ticket_id, note: shortNote }, null, 2);
    }
    case "list_clients": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.search) p.search = String(args.search); if (args.include_inactive) p.includeinactive = "true"; return JSON.stringify(await haloGet(env, "/Client", p), null, 2); }
    case "get_client": return JSON.stringify(await haloGet(env, `/Client/${args.client_id}`), null, 2);
    case "list_contacts": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); if (args.search_phonenumbers) p.search_phonenumbers = "true"; return JSON.stringify(await haloGet(env, "/Users", p), null, 2); }
    case "get_contact": return JSON.stringify(await haloGet(env, `/Users/${args.contact_id}`), null, 2);
    case "create_contact": {
      const name = args.name ?? [args.firstname, args.surname].filter(Boolean).join(" ");
      const payload: Record<string, unknown> = { client_id: args.client_id, name };
      if (args.site_id) payload.site_id = args.site_id;
      if (args.firstname) payload.firstname = args.firstname;
      if (args.surname) payload.surname = args.surname;
      if (args.emailaddress) payload.emailaddress = args.emailaddress;
      if (args.phonenumber) payload.phonenumber = args.phonenumber;
      if (args.mobilenumber) payload.mobilenumber = args.mobilenumber;
      if (args.title) payload.title = args.title;
      if (args.send_welcome_email) payload.sendwelcomeemail = args.send_welcome_email;
      return JSON.stringify(await haloPost(env, "/Users", [payload]), null, 2);
    }
    case "list_sites": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Site", p), null, 2); }
    case "get_site": return JSON.stringify(await haloGet(env, `/Site/${args.site_id}`), null, 2);
    case "list_assets": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Asset", p), null, 2); }
    case "list_agents": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.include_inactive) p.includedisabled = "true"; if (args.include_api_agents) p.includeapiagents = "true"; return JSON.stringify(await haloGet(env, "/Agent", p), null, 2); }
    case "list_teams": return JSON.stringify(await haloGet(env, "/Team", { count: String(args.count ?? 50) }), null, 2);
    case "list_ticket_types": return JSON.stringify(await haloGet(env, "/TicketType"), null, 2);
    case "list_statuses": { const p: Record<string, string> = {}; if (args.ticket_type) p.tickettype_id = String(args.ticket_type); return JSON.stringify(await haloGet(env, "/Status", p), null, 2); }
    case "list_priorities": return JSON.stringify(await haloGet(env, "/Priority"), null, 2);
    case "list_outcomes": { const p: Record<string, string> = {}; if (args.tickettype_id) p.tickettype_id = String(args.tickettype_id); return JSON.stringify(await haloGet(env, "/Outcome", p), null, 2); }
    case "list_slas": return JSON.stringify(await haloGet(env, "/SLA", { count: String(args.count ?? 50) }), null, 2);
    case "list_time_entries": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.ticket_id) p.ticket_id = String(args.ticket_id); if (args.client_id) p.client_id = String(args.client_id); if (args.agent_id) p.agent_id = String(args.agent_id); if (args.start_date) p.start_date = String(args.start_date); if (args.end_date) p.end_date = String(args.end_date); return JSON.stringify(await haloGet(env, "/Actions", p), null, 2); }
    case "get_ticket_time_entries": {
      const data = (await haloGet(env, "/Actions", { ticket_id: String(args.ticket_id), count: "100" })) as any;
      // Real incident: HelpDeskAgent's resolver has a bright-line rule -
      // "if any real human agent has EVER acted on this ticket, stop" -
      // that depends on it correctly scanning every action's who/who_type
      // field in a list that can run well past a dozen entries. Confirmed
      // live: the exact same ticket, same action list, was scanned
      // correctly on one pass and missed a clearly-present human action
      // (a status change, `who_type: 1`, a real agent name) on another
      // pass five minutes earlier - the RULE was never in question, the
      // scan itself was unreliable. What actually makes an action "human"
      // here is fully mechanical, not a judgment call: `who_type === 1`
      // (Halo's own agent/human flag, as opposed to 0 for system/rule/AI
      // automation or 2 for the client contact) and not this pipeline's
      // own identity (every note/action this pipeline itself writes is
      // tagged `actionby_application_id: "Claude"`, confirmed live,
      // regardless of which Halo agent account it's bound to). Computing
      // that once here and handing it over as a plain fact removes the
      // "did the model actually notice it" step as a source of error -
      // it does NOT decide what to do about it, resolver-prompt.md's own
      // ownership check still makes that call. The full `actions` array
      // is still returned completely unchanged below this new field, so
      // nothing that already reads this response's shape is affected.
      const cut = applyAsOf(data.actions || [], args.as_of);
      const actions: any[] = cut.actions;
      if (cut.applied) { data.actions = actions; data.as_of = cut.applied; data.actions_hidden_after_as_of = cut.hidden; }
      const humanActions = actions.filter((a: any) => isHumanAction(a, integrationAppIds(env)));
      data.human_touch = {
        found: humanActions.length > 0,
        actions: humanActions.map((a: any) => ({ id: a.id, who: a.who, who_agentid: a.who_agentid, datetime: a.datetime, outcome: a.outcome })),
      };
      return JSON.stringify(data, null, 2);
    }
    case "list_invoices": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.client_id) p.client_id = String(args.client_id); if (args.start_date) p.start_date = String(args.start_date); if (args.end_date) p.end_date = String(args.end_date); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Invoice", p), null, 2); }
    case "get_invoice": return JSON.stringify(await haloGet(env, `/Invoice/${args.invoice_id}`), null, 2);
    case "list_recurring_invoices": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); if (args.active_only !== false) p.active_only = "true"; return JSON.stringify(await haloGet(env, "/RecurringInvoice", p), null, 2); }
    case "get_recurring_invoice": return JSON.stringify(await haloGet(env, `/RecurringInvoice/${args.recurring_invoice_id}`), null, 2);
    case "list_quotes": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Quotation", p), null, 2); }
    case "get_quote": return JSON.stringify(await haloGet(env, `/Quotation/${args.quote_id}`), null, 2);
    case "list_appointments": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.client_id) p.client_id = String(args.client_id); if (args.agent_id) p.agent_id = String(args.agent_id); if (args.start_date) p.start_date = String(args.start_date); if (args.end_date) p.end_date = String(args.end_date); return JSON.stringify(await haloGet(env, "/Appointment", p), null, 2); }
    case "get_appointment": return JSON.stringify(await haloGet(env, `/Appointment/${args.appointment_id}`), null, 2);
    case "list_kb_articles": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/KBArticle", p), null, 2); }
    case "get_kb_article": return JSON.stringify(await haloGet(env, `/KBArticle/${args.article_id}`), null, 2);
    case "list_opportunities": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Opportunities", p), null, 2); }
    case "get_opportunity": return JSON.stringify(await haloGet(env, `/Opportunities/${args.opportunity_id}`), null, 2);
    case "list_software_licences": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/SoftwareLicence", p), null, 2); }
    case "list_contracts": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); return JSON.stringify(await haloGet(env, "/ClientContract", p), null, 2); }
    case "get_contract": return JSON.stringify(await haloGet(env, `/ClientContract/${args.contract_id}`), null, 2);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — real open-ticket visibility for the
// Tickets & SLA zone: open count, overdue, unassigned, age, and
// whether each ticket is waiting on us or on the client.
//
// FIELD NAMES CONFIRMED against live payloads, including two real
// bugs found via a round-trip with live data (not caught by field
// names alone):
//
//   1. UNASSIGNED: this tenant has a real Halo agent (agent_id 1)
//      whose actual configured name is literally "Unassigned" — a
//      placeholder/routing account, not a null value. Checking only
//      "is agent_id falsy" missed this entirely, since agent_id=1 is
//      truthy. Now also checks whether the RESOLVED AGENT NAME is
//      "unassigned" (case-insensitive).
//
//   2. PRIORITY: tickets don't carry a nested priority.name object —
//      only a numeric priority_id, and confusingly it's only
//      meaningful combined with sla_id (this tenant has 3 SLA
//      policies with different priority-1 labels: "Urgent",
//      "Critical", and a typo'd "Critial"). Resolved via a proper
//      GET /Priority lookup keyed on {sla_id}_{priority_id}, with a
//      priority_id-only fallback for the priority levels (2-4) that
//      are consistent across every SLA on this tenant.
//
// "waiting on client" heuristic (status name contains "customer",
// "client", or "pending") is confirmed working correctly — verified
// against a real response showing status_id 4 = "Waiting on client"
// resolving and matching as expected.
// ============================================================

// Some clients still surface in the wallboard's other zones (Meraki,
// Peplink, Pax8, Huntress, CIPP...) even after they've left, because the
// new provider hasn't pulled our API access yet. HaloPSA is the system of
// record for client status, so this is exposed in /status for the
// Dashboard to filter every zone against, not just tickets. GET /Client
// excludes inactive clients by default (confirmed against a live payload —
// 109/109 returned had inactive:false with no includeinactive param), so
// includeinactive=true is required to see them at all.
async function buildInactiveClients(env: Env): Promise<string[]> {
  const data = await haloGet(env, "/Client", { count: "1000", includeinactive: "true" });
  const clients: any[] = (data as any).clients || (Array.isArray(data) ? data : []);
  return clients.filter((c: any) => c.inactive).map((c: any) => c.name);
}

async function buildTicketStatus(env: Env) {
  const [ticketsData, statusesData, agentsData, prioritiesData, inactiveClients] = await Promise.all([
    haloGet(env, "/Tickets", { open_only: "true", count: "500", order: "datecreated", orderdesc: "true" }),
    haloGet(env, "/Status"),
    haloGet(env, "/Agent", { count: "200" }),
    haloGet(env, "/Priority"),
    buildInactiveClients(env).catch(() => [] as string[]), // non-fatal — a hiccup here shouldn't take down ticket stats
  ]);

  const inactiveClientNames = new Set(inactiveClients.map((n) => n.toLowerCase()));
  const ticketsUnfiltered: any[] = (ticketsData as any).tickets || ticketsData || [];
  const tickets = ticketsUnfiltered.filter((t) => !inactiveClientNames.has((t.client_name || "").toLowerCase()));
  const statuses: any[] = (statusesData as any).statuses || statusesData || [];
  const agents: any[] = (agentsData as any).agents || agentsData || [];
  const priorities: any[] = (prioritiesData as any).priorities || prioritiesData || [];

  const statusNameById = new Map(statuses.map((s: any) => [s.id, s.name]));
  const agentNameById = new Map(agents.map((a: any) => [a.id, a.name]));
  const priorityNameBySlaAndId = new Map(priorities.map((p: any) => [`${p.slaid}_${p.priorityid}`, p.name]));
  const priorityNameById = new Map(priorities.map((p: any) => [p.priorityid, p.name])); // fallback — consistent for levels 2-4 across every SLA on this tenant

  function resolveAgentName(t: any): string | null {
    if (!t.agent_id) return null;
    return agentNameById.get(t.agent_id) || `Agent #${t.agent_id}`;
  }
  function isUnassigned(t: any): boolean {
    const name = resolveAgentName(t);
    return !name || name.toLowerCase() === "unassigned";
  }
  function resolvePriorityName(t: any): string {
    return priorityNameBySlaAndId.get(`${t.sla_id}_${t.priority_id}`) || priorityNameById.get(t.priority_id) || "";
  }

  const ALERT_TYPE_IDS = new Set([21]); // "Alert" tickettype on this tenant — confirm via list_ticket_types if this changes

  const real = tickets.filter((t) => !ALERT_TYPE_IDS.has(t.tickettype_id));
  const alertNoise = tickets.filter((t) => ALERT_TYPE_IDS.has(t.tickettype_id));

  const now = Date.now();

  function isOnHold(t: any): boolean {
    // Catches both the explicit onhold flag AND any status whose name
    // contains "hold" (e.g. "On Hold", "SLA Hold", "On Hold - Parts") —
    // broader than just the boolean flag since this tenant may use
    // hold-style statuses that don't set onhold=true.
    if (t.onhold === true) return true;
    const name = (statusNameById.get(t.status_id) || "").toLowerCase();
    return name.includes("hold");
  }
  function isOverdue(t: any): boolean {
    if (t.excludefromsla || isOnHold(t)) return false; // held tickets are paused, not overdue
    const respond = t.respondbydate ? new Date(t.respondbydate).getTime() : null;
    const fix = t.fixbydate ? new Date(t.fixbydate).getTime() : null;
    return (respond !== null && respond < now) || (fix !== null && fix < now);
  }
  function nextDeadline(t: any): number | null {
    const respond = t.respondbydate ? new Date(t.respondbydate).getTime() : null;
    const fix = t.fixbydate ? new Date(t.fixbydate).getTime() : null;
    if (respond !== null && respond > now) return respond;
    if (fix !== null) return fix;
    return respond;
  }
  function isWaitingOnClient(t: any): boolean {
    const name = (statusNameById.get(t.status_id) || "").toLowerCase();
    return name.includes("customer") || name.includes("client") || name.includes("pending");
  }

  const overdue = real.filter(isOverdue);
  const unassigned = real.filter(isUnassigned);
  const waitingOnClient = real.filter(isWaitingOnClient);
  const waitingOnUs = real.filter((t) => !isWaitingOnClient(t) && !t.onhold && !isOnHold(t));

  const recentTickets = real.slice(0, 15).map((t) => {
    const deadline = nextDeadline(t);
    const agentName = resolveAgentName(t);
    return {
      id: t.id,
      client: t.client_name || "Unknown",
      summary: t.summary || "(no summary)",
      agent: agentName && agentName.toLowerCase() !== "unassigned" ? agentName : null,
      status: statusNameById.get(t.status_id) || `Status ${t.status_id}`,
      priority: resolvePriorityName(t),
      ageDays: typeof t.ticketage === "number" ? Math.round(t.ticketage * 10) / 10 : null,
      overdue: isOverdue(t),
      onHold: isOnHold(t),
      dueIn: deadline ? humanizeDelta(deadline - now) : "",
      waitingOnClient: isWaitingOnClient(t),
    };
  });

  return {
    updated: new Date().toISOString(),
    openCount: real.length,
    alertNoiseCount: alertNoise.length,
    overdueCount: overdue.length,
    unassignedCount: unassigned.length,
    waitingOnUsCount: waitingOnUs.length,
    waitingOnClientCount: waitingOnClient.length,
    onHoldCount: real.filter(isOnHold).length,
    recentTickets,
    inactiveClients,
  };
}

// HelpDeskAgent's own cheap pre-flight check, run from PowerShell via a
// plain HTTP GET (no Claude/LLM call at all) before deciding whether a
// scheduled cycle needs to invoke the classifier. Real incident: without
// this, every 15-minute cycle invoked the classifier LLM regardless of
// whether anything had actually changed, at real per-cycle cost even on
// the vast majority of cycles that found nothing. This route answers
// "is there anything worth a real check" using only cheap, count-only or
// single-ticket Halo calls - it never returns full ticket bodies for the
// unassigned/stuck-claimed buckets, only counts, and only fetches full
// detail for the small, explicitly-named tracked ticket set.
// Real incident: a single page_size:15/page 1 pull silently assumed Halo's
// /Tickets response is ordered newest-activity-first. Verified directly
// against a live tenant that it is NOT - it's ordered by ticket ID/creation
// date descending, which is not the same thing. A ticket with an older ID
// that just got a fresh client reply can have a newer last_update than
// several tickets "ahead" of it in that ordering, so a fixed single-page
// pull can miss the exact change this fingerprint exists to catch. Fixed by
// paging through the whole bucket (like stuck-claimed/Ready-for-AI already
// do) instead of trusting page 1 alone - capped at maxPages purely as a
// runaway-cost guard against an unbounded queue, not because paging itself
// is expensive: this all happens in one Worker invocation with no LLM
// involved, so extra pages cost a few extra Halo API round-trips, nothing
// more.
async function fetchAllTickets(env: Env, params: Record<string, string>, pageSize: number, maxPages: number): Promise<{ tickets: any[]; record_count: number; truncated: boolean }> {
  let all: any[] = [];
  let recordCount = 0;
  for (let page = 1; page <= maxPages; page++) {
    const data = (await haloGet(env, "/Tickets", { ...params, pageinate: "true", page_no: String(page), page_size: String(pageSize) })) as any;
    const tickets: any[] = data.tickets || [];
    recordCount = data.record_count ?? recordCount;
    all = all.concat(tickets);
    if (tickets.length < pageSize || all.length >= recordCount) break;
  }
  return { tickets: all, record_count: recordCount, truncated: all.length < recordCount };
}

async function buildHelpDeskGate(env: Env, teamId: string, agentId: string, trackedIds: string[]) {
  const [unassignedResult, stuckData, trackedResults] = await Promise.all([
    // Full paged sweep (capped) - see fetchAllTickets above for why page 1
    // alone isn't safe to rely on for this bucket.
    fetchAllTickets(env, { open_only: "true", team_id: teamId, agent_id: "1" }, 20, 5),
    haloGet(env, "/Tickets", { open_only: "true", team_id: teamId, agent_id: agentId, pageinate: "true", page_no: "1", page_size: "10" }),
    Promise.all(trackedIds.slice(0, 50).map(async (id) => {
      try {
        const t = (await haloGet(env, `/Tickets/${id}`)) as any;
        return { id: Number(id), found: true, last_action_date: t.lastactiondate ?? null, agent_id: t.agent_id ?? null, status_id: t.status_id ?? null };
      } catch {
        return { id: Number(id), found: false };
      }
    })),
  ]);
  const stuckTickets: any[] = (stuckData as any).tickets || [];
  return {
    unassigned_count: unassignedResult.record_count,
    // Slim projection, not full ticket bodies - just enough for the caller
    // to fingerprint "did this specific set of tickets change" the same way
    // it already does for the tracked list below.
    //
    // Real incident: this used to fingerprint on `last_update`, which is
    // Halo's "any field on this ticket record changed" timestamp - and Halo
    // recomputes time-based fields (slaholdtime, in particular) on any
    // on-hold ticket on its own, with zero human or agent activity. Every
    // status this pipeline's own held tickets sit in while awaiting review
    // (AI Waiting Approval, AI Approved, Waiting on client, ...) shows
    // `onhold: true`, so `last_update` on a genuinely untouched ticket kept
    // drifting anyway - confirmed live on a ticket whose `last_update` moved
    // 15 minutes after its last real action with nothing new in the action
    // log at all. That made this gate see "changed" on nearly every cycle
    // for any tracked ticket sitting on hold, defeating the entire point of
    // fingerprinting: one ticket alone (#22033) got reprocessed by the full
    // classifier+resolver roughly 28 times in a single day chasing a change
    // that never actually happened, at real per-cycle Sonnet cost each time.
    // `lastactiondate` only moves when a real Action (note/reply/status
    // change) is added - confirmed against the same ticket's data, where it
    // stayed constant across that entire drifting `last_update` window - so
    // it's what this fingerprint should have been comparing all along.
    unassigned: unassignedResult.tickets.map((t: any) => ({ id: t.id, last_action_date: t.lastactiondate ?? null, status_id: t.status_id ?? null })),
    // true if the bucket has more tickets than the 5-page/20-per-page cap
    // covered - a signal worth logging, not itself acted on: it means the
    // fingerprint below is only as complete as this cap allows.
    unassigned_truncated: unassignedResult.truncated,
    stuck_claimed_count: (stuckData as any).record_count ?? stuckTickets.length,
    stuck_claimed_ids: stuckTickets.map((t: any) => t.id),
    tracked: trackedResults,
  };
}

// HelpDeskAgent's deterministic classifier (cost program, increment 2): the
// classifier prompt's candidate-finding calls 1-6, done here as plain Halo
// REST calls with no LLM. Every bucket comes back as trimmed tickets, each
// with its most recent few trimmed actions (enough to answer "did a human
// touch this since our last note" / "is the latest entry a colleague's
// reply" mechanically). The exclusion rules themselves live in the
// PowerShell caller, next to the caches they depend on; this route only
// gathers.
async function enrichWithRecentActions(env: Env, tickets: any[], historyCount: number, maxNoteChars: number, maxDetailsChars: number) {
  const out: unknown[] = [];
  for (let i = 0; i < tickets.length; i += 8) {
    const batch = tickets.slice(i, i + 8);
    out.push(...(await Promise.all(batch.map(async (t: any) => {
      let actions: any[] = [];
      let actionCount: number | null = null;
      let actionsError: string | null = null;
      if (historyCount > 0) {
        try {
          const data = (await haloGet(env, "/Actions", { ticket_id: String(t.id), count: String(historyCount) })) as any;
          actions = data.actions || [];
          actionCount = data.record_count ?? actions.length;
        } catch (err) {
          actionsError = (err as Error).message;
        }
      }
      return {
        ticket: trimTicket(t, maxDetailsChars),
        action_count: actionCount,
        actions_error: actionsError,
        recent_actions: actions.map((a) => trimAction(a, maxNoteChars)),
        recent_human_touch: computeHumanTouch(actions, env),
      };
    }))));
  }
  return out;
}

async function buildHelpDeskTriage(env: Env, q: URLSearchParams) {
  const teamId = q.get("team_id")!;
  const agentId = q.get("agent_id")!;
  const trackedIds = (q.get("tracked_ids") || "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).slice(0, 50);
  const readyStatusId = q.get("ready_status_id");
  const waitingApprovalStatusId = q.get("waiting_approval_status_id");
  const approvedStatusId = q.get("approved_status_id");
  const historyCount = Math.min(Math.max(Number(q.get("history") || 6), 0), 25);
  const maxDetailsChars = Number(q.get("max_details_chars") || 1500);
  const maxNoteChars = Number(q.get("max_note_chars") || 800);

  const statusBucket = async (statusId: string | null) => {
    if (!statusId || !/^\d+$/.test(statusId)) return null;
    return fetchAllTickets(env, { open_only: "true", team_id: teamId, status_id: statusId }, 15, 10);
  };
  const [unassigned, stuck, ready, waitingApproval, approved, tracked] = await Promise.all([
    fetchAllTickets(env, { open_only: "true", team_id: teamId, agent_id: "1" }, 20, 5),
    fetchAllTickets(env, { open_only: "true", team_id: teamId, agent_id: agentId }, 15, 10),
    statusBucket(readyStatusId),
    statusBucket(waitingApprovalStatusId),
    statusBucket(approvedStatusId),
    Promise.all(trackedIds.map(async (id) => {
      try { return { id: Number(id), found: true, raw: await haloGet(env, `/Tickets/${id}`) as any }; }
      catch (err) { return { id: Number(id), found: false, error: (err as Error).message, raw: null }; }
    })),
  ]);
  const bucket = async (r: { tickets: any[]; record_count: number; truncated: boolean } | null) => r ? ({
    record_count: r.record_count, truncated: r.truncated,
    tickets: await enrichWithRecentActions(env, r.tickets, historyCount, maxNoteChars, maxDetailsChars),
  }) : null;
  const trackedFound = tracked.filter((t) => t.found).map((t) => t.raw);
  const trackedEnriched = await enrichWithRecentActions(env, trackedFound, historyCount, maxNoteChars, maxDetailsChars);
  return {
    generated: new Date().toISOString(),
    team_id: Number(teamId), agent_id: Number(agentId),
    unassigned: await bucket(unassigned),
    stuck_claimed: await bucket(stuck),
    ready_for_ai: await bucket(ready),
    waiting_approval: await bucket(waitingApproval),
    approved: await bucket(approved),
    tracked: {
      requested: trackedIds.map(Number),
      missing: tracked.filter((t) => !t.found).map((t) => ({ id: t.id, error: (t as any).error })),
      tickets: trackedEnriched,
    },
  };
}

function humanizeDelta(ms: number): string {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  if (h < 1) return Math.floor(abs / 60000) + "m";
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
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
    if (env.MCP_AUTH_TOKEN && url.pathname !== "/health") {
      const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
      }
    }
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", instance: env.HALO_BASE_URL }), { headers: JSON_HEADERS });
    if (url.pathname === "/status") {
      try {
        const status = await buildTicketStatus(env);
        return new Response(JSON.stringify(status), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
    }
    if (url.pathname === "/helpdesk-gate") {
      const teamId = url.searchParams.get("team_id");
      const agentId = url.searchParams.get("agent_id");
      if (!teamId || !agentId) return new Response(JSON.stringify({ error: "team_id and agent_id query params are required" }), { status: 400, headers: JSON_HEADERS });
      const trackedIds = (url.searchParams.get("tracked_ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
      try {
        const gate = await buildHelpDeskGate(env, teamId, agentId, trackedIds);
        return new Response(JSON.stringify(gate), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
    }
    // HelpDeskAgent's deterministic candidate feed (cost program, increment 1):
    // plain HTTP, no LLM. Given ticket IDs (from /helpdesk-gate, which already
    // knows which tickets are new or changed), return each one's trimmed brief,
    // its most recent few trimmed actions, and human_touch - everything the
    // classifier needs to tier a ticket and the resolver needs to start
    // without spending its first several turns re-fetching the same data.
    if (url.pathname === "/helpdesk-triage") {
      if (!url.searchParams.get("team_id") || !url.searchParams.get("agent_id")) return new Response(JSON.stringify({ error: "team_id and agent_id query params are required" }), { status: 400, headers: JSON_HEADERS });
      try {
        return new Response(JSON.stringify(await buildHelpDeskTriage(env, url.searchParams)), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
    }
    if (url.pathname === "/helpdesk-candidates") {
      const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).slice(0, 40);
      if (ids.length === 0) return new Response(JSON.stringify({ error: "ids query param (comma-separated ticket IDs) is required" }), { status: 400, headers: JSON_HEADERS });
      const historyCount = Math.min(Math.max(Number(url.searchParams.get("history") || 5), 0), 25);
      const maxDetailsChars = Number(url.searchParams.get("max_details_chars") || 6000);
      const maxNoteChars = Number(url.searchParams.get("max_note_chars") || 2000);
      try {
        const candidates: unknown[] = [];
        for (let i = 0; i < ids.length; i += 8) {
          const batch = ids.slice(i, i + 8);
          candidates.push(...(await Promise.all(batch.map((id) => buildCandidateBrief(env, id, historyCount, maxDetailsChars, maxNoteChars)))));
        }
        return new Response(JSON.stringify({ generated: new Date().toISOString(), count: candidates.length, candidates }), { headers: JSON_HEADERS });
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "HaloPSA MCP Server", version: "1.0.0" } } });
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
    return new Response("HaloPSA MCP Server - POST /mcp, GET /status, GET /helpdesk-gate, GET /helpdesk-triage, GET /helpdesk-candidates, GET /health", { status: 200, headers: CORS });
  },
};
