export interface Env {
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
async function haloPost(env: Env, path: string, body: unknown): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.HALO_BASE_URL}/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}
const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to HaloPSA and verify credentials are working", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "list_tickets", description: "List tickets from HaloPSA with optional filters. Without agent_id, this is an account-wide list capped at `count` (default 20) - large counts return full ticket bodies per row and can exceed the caller's own response-size limit well before reaching the true end of the open-ticket backlog, so a ticket with no recent activity can silently fall outside the window even though it's genuinely open. Pass agent_id (e.g. the real Halo 'Unassigned' agent, or a specific agent) to filter server-side instead of relying on count/recency. If even one agent's ticket count is still too large for one response, use pageinate/page_no/page_size (HaloPSA's own paging - page_size max 100 per HaloPSA's docs, but this MCP server's own response-size limit will likely force something smaller in practice) instead of `count` to walk through them in bounded pages - the response's own record_count field is the true total match count regardless of how many rows this particular page returned, so it tells you when you've reached the end.", inputSchema: { type: "object", properties: { count: { type: "number" }, open_only: { type: "boolean" }, client_id: { type: "number" }, agent_id: { type: "number", description: "Filter to tickets currently assigned to this single agent ID (HaloPSA's own /Tickets agent_id filter) - use this instead of a large count to reliably find a specific agent's tickets regardless of how recently they were touched." }, pageinate: { type: "boolean", description: "Enable HaloPSA's own pagination instead of the plain count cutoff - use together with page_no/page_size." }, page_no: { type: "number", description: "Page number to return (1-based) when pageinate is true." }, page_size: { type: "number", description: "Rows per page when pageinate is true. HaloPSA caps this at 100, but this MCP server's response-size limit will often force a smaller value in practice - start small (e.g. 15-20) and only raise it if the response doesn't get truncated." }, search: { type: "string" } } } },
  { name: "get_ticket", description: "Get full details of a single HaloPSA ticket by ID", inputSchema: { type: "object", properties: { ticket_id: { type: "number" } }, required: ["ticket_id"] } },
  { name: "create_ticket", description: "Create a new ticket in HaloPSA", inputSchema: { type: "object", properties: { summary: { type: "string" }, details: { type: "string" }, client_id: { type: "number" }, user_id: { type: "number" }, team_id: { type: "number" }, agent_id: { type: "number" }, tickettype_id: { type: "number" }, priority_id: { type: "number" } }, required: ["summary"] } },
  { name: "update_ticket", description: "Update a ticket - add a note, change status, reassign, or triage (set category/priority). HaloPSA has no separate 'triage' API action — triaging a ticket just means setting category_1 (and priority_id/team_id/agent_id) and moving it off its initial status in one call.", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, note: { type: "string" }, note_is_private: { type: "boolean" }, status_id: { type: "number" }, agent_id: { type: "number" }, team_id: { type: "number" }, category_1: { type: "string", description: "Category, e.g. 'Infrastructure>Server' — use list_ticket_types/an existing ticket to see this tenant's category tree" }, priority_id: { type: "number", description: "Use list_priorities to find the ID" } }, required: ["ticket_id"] } },
  { name: "list_clients", description: "List clients/customers in HaloPSA", inputSchema: { type: "object", properties: { count: { type: "number" }, search: { type: "string" }, include_inactive: { type: "boolean" } } } },
  { name: "get_client", description: "Get full details for a single HaloPSA client by ID", inputSchema: { type: "object", properties: { client_id: { type: "number" } }, required: ["client_id"] } },
  { name: "list_contacts", description: "List end-user contacts in HaloPSA, optionally filtered by client", inputSchema: { type: "object", properties: { client_id: { type: "number" }, search: { type: "string" }, count: { type: "number" } } } },
  { name: "get_contact", description: "Get full details for a single contact/end-user by ID", inputSchema: { type: "object", properties: { contact_id: { type: "number" } }, required: ["contact_id"] } },
  { name: "create_contact", description: "Create a new end-user contact in HaloPSA and associate them with a client/company. HaloPSA requires a specific site, not just a client — use list_clients to find the client_id, then list_sites filtered by that client_id to find the site_id (most clients only have one site).", inputSchema: { type: "object", properties: { client_id: { type: "number", description: "The company/client this contact belongs to" }, site_id: { type: "number", description: "Required — the specific site under that client. Look it up with list_sites first." }, firstname: { type: "string" }, surname: { type: "string" }, name: { type: "string", description: "Full display name; if omitted, derived from firstname + surname" }, emailaddress: { type: "string" }, phonenumber: { type: "string" }, mobilenumber: { type: "string" }, title: { type: "string", description: "Job title" }, send_welcome_email: { type: "boolean", description: "Whether HaloPSA should email the new contact a portal welcome/login message" } }, required: ["client_id", "site_id"] } },
  { name: "list_sites", description: "List sites (physical locations) in HaloPSA, optionally filtered by client", inputSchema: { type: "object", properties: { client_id: { type: "number" }, search: { type: "string" }, count: { type: "number" } } } },
  { name: "get_site", description: "Get full details for a single site by ID", inputSchema: { type: "object", properties: { site_id: { type: "number" } }, required: ["site_id"] } },
  { name: "list_assets", description: "List assets/devices in HaloPSA", inputSchema: { type: "object", properties: { count: { type: "number" }, client_id: { type: "number" }, search: { type: "string" } } } },
  { name: "list_agents", description: "List agents (technicians/staff) in HaloPSA", inputSchema: { type: "object", properties: { count: { type: "number" } } } },
  { name: "list_teams", description: "List all teams in HaloPSA - use this to resolve team names to IDs for ticket assignment", inputSchema: { type: "object", properties: { count: { type: "number" } } } },
  { name: "list_ticket_types", description: "List all ticket types in HaloPSA with their IDs", inputSchema: { type: "object", properties: {} } },
  { name: "list_statuses", description: "List all ticket statuses in HaloPSA with their IDs", inputSchema: { type: "object", properties: { ticket_type: { type: "number" } } } },
  { name: "list_priorities", description: "List all ticket priorities in HaloPSA with their IDs and SLA targets", inputSchema: { type: "object", properties: {} } },
  { name: "list_outcomes", description: "List valid Action outcome IDs in HaloPSA — required by update_ticket's note field (HaloPSA rejects a ticket note/action with no outcome_id set)", inputSchema: { type: "object", properties: { tickettype_id: { type: "number" } } } },
  { name: "list_slas", description: "List all SLA policies in HaloPSA with response and fix time targets", inputSchema: { type: "object", properties: { count: { type: "number" } } } },
  { name: "list_time_entries", description: "List ticket actions from HaloPSA (time entries/labor, but also notes, emails, and replies — this is the full action log, not billing-only)", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, client_id: { type: "number" }, agent_id: { type: "number" }, count: { type: "number" }, start_date: { type: "string" }, end_date: { type: "string" } } } },
  { name: "get_ticket_time_entries", description: "Get a ticket's full action log: labor/time entries, internal notes, and agent-to-client conversation (emails/replies) — this is also the way to see what a prior agent already told the client", inputSchema: { type: "object", properties: { ticket_id: { type: "number" } }, required: ["ticket_id"] } },
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
    case "list_tickets": { const p: Record<string, string> = { count: String(args.count ?? 20) }; if (args.open_only !== false) p.open_only = "true"; if (args.client_id) p.client_id = String(args.client_id); if (args.agent_id) p.agent_id = String(args.agent_id); if (args.pageinate) p.pageinate = "true"; if (args.page_no) p.page_no = String(args.page_no); if (args.page_size) p.page_size = String(args.page_size); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Tickets", p), null, 2); }
    case "get_ticket": return JSON.stringify(await haloGet(env, `/Tickets/${args.ticket_id}`), null, 2);
    case "create_ticket": { const payload: Record<string, unknown> = { summary: args.summary, details: args.details ?? "" }; if (args.client_id) payload.client_id = args.client_id; if (args.user_id) payload.user_id = args.user_id; if (args.team_id) payload.team_id = args.team_id; if (args.agent_id) payload.agent_id = args.agent_id; if (args.tickettype_id) payload.tickettype_id = args.tickettype_id; if (args.priority_id) payload.priority_id = args.priority_id; return JSON.stringify(await haloPost(env, "/Tickets", [payload]), null, 2); }
    case "update_ticket": {
      const results: Record<string, unknown> = {};
      const fieldPayload: Record<string, unknown> = { id: args.ticket_id };
      let hasFieldChange = false;
      if (args.status_id) { fieldPayload.status_id = args.status_id; hasFieldChange = true; }
      if (args.agent_id) { fieldPayload.agent_id = args.agent_id; hasFieldChange = true; }
      if (args.team_id) { fieldPayload.team_id = args.team_id; hasFieldChange = true; }
      if (args.category_1) { fieldPayload.category_1 = args.category_1; hasFieldChange = true; }
      if (args.priority_id) { fieldPayload.priority_id = args.priority_id; hasFieldChange = true; }
      if (hasFieldChange) results.ticket = await haloPost(env, "/Tickets", [fieldPayload]);
      // Notes are a separate resource in HaloPSA (POST /Actions) — nesting an
      // "actions" array inside a POST /Tickets payload is silently ignored by
      // the API (no error, no action created), so this must be a second call.
      // outcome_id is mandatory on every Action — HaloPSA rejects a note with none.
      // 7 = "Private Note" in this tenant's Outcome list (list_outcomes); visibility
      // to the client is controlled separately via hiddenfromuser, not this field.
      if (args.note) results.action = await haloPost(env, "/Actions", [{ ticket_id: args.ticket_id, note: args.note, hiddenfromuser: args.note_is_private ?? false, outcome_id: 7 }]);
      return JSON.stringify(results, null, 2);
    }
    case "list_clients": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.search) p.search = String(args.search); if (args.include_inactive) p.includeinactive = "true"; return JSON.stringify(await haloGet(env, "/Client", p), null, 2); }
    case "get_client": return JSON.stringify(await haloGet(env, `/Client/${args.client_id}`), null, 2);
    case "list_contacts": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.client_id) p.client_id = String(args.client_id); if (args.search) p.search = String(args.search); return JSON.stringify(await haloGet(env, "/Users", p), null, 2); }
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
    case "list_agents": return JSON.stringify(await haloGet(env, "/Agent", { count: String(args.count ?? 50) }), null, 2);
    case "list_teams": return JSON.stringify(await haloGet(env, "/Team", { count: String(args.count ?? 50) }), null, 2);
    case "list_ticket_types": return JSON.stringify(await haloGet(env, "/TicketType"), null, 2);
    case "list_statuses": { const p: Record<string, string> = {}; if (args.ticket_type) p.tickettype_id = String(args.ticket_type); return JSON.stringify(await haloGet(env, "/Status", p), null, 2); }
    case "list_priorities": return JSON.stringify(await haloGet(env, "/Priority"), null, 2);
    case "list_outcomes": { const p: Record<string, string> = {}; if (args.tickettype_id) p.tickettype_id = String(args.tickettype_id); return JSON.stringify(await haloGet(env, "/Outcome", p), null, 2); }
    case "list_slas": return JSON.stringify(await haloGet(env, "/SLA", { count: String(args.count ?? 50) }), null, 2);
    case "list_time_entries": { const p: Record<string, string> = { count: String(args.count ?? 50) }; if (args.ticket_id) p.ticket_id = String(args.ticket_id); if (args.client_id) p.client_id = String(args.client_id); if (args.agent_id) p.agent_id = String(args.agent_id); if (args.start_date) p.start_date = String(args.start_date); if (args.end_date) p.end_date = String(args.end_date); return JSON.stringify(await haloGet(env, "/Actions", p), null, 2); }
    case "get_ticket_time_entries": return JSON.stringify(await haloGet(env, "/Actions", { ticket_id: String(args.ticket_id), count: "100" }), null, 2);
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

function humanizeDelta(ms: number): string {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  if (h < 1) return Math.floor(abs / 60000) + "m";
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", instance: env.HALO_BASE_URL }), { headers: JSON_HEADERS });
    if (url.pathname === "/status") {
      try {
        const status = await buildTicketStatus(env);
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
    return new Response("HaloPSA MCP Server - POST /mcp, GET /status, GET /health", { status: 200, headers: CORS });
  },
};
