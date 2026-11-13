// Builds src/tools.json from Huntress's own API spec (spec/swagger_doc.json).
//
//   npm run tools
//
// Refresh the spec first when Huntress adds endpoints or filters:
//   curl -L https://api.huntress.io/docs -o spec/swagger_doc.json
// (/docs redirects to /v1/swagger_doc.json.)
//
// Every tool is a GET. Names are the ones Huntress's hosted MCP server used,
// so mcp-gateway's readTools allowlist and existing prompts keep working; the
// few without an old name follow the same pattern. Query parameters, enums,
// limits and descriptions come straight from the spec, so a tool can never
// send a filter Huntress does not document.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "spec/swagger_doc.json"), "utf8"));

// [tool name, spec path, extra description (optional)]
const MAP = [
  ["get_account", "/v1/account"],
  ["get_actor", "/v1/actor", "For an API key this shows only the account, whichever key it is; use list_identities to test identity access."],
  ["list_organizations", "/v1/organizations", "Organizations are Huntress's clients. Filter by exact name or key."],
  ["get_organization", "/v1/organizations/{id}"],
  ["list_agents", "/v1/agents", "Endpoint agents (computers). hostname is an exact match."],
  ["get_agent", "/v1/agents/{id}"],
  ["list_incident_reports", "/v1/incident_reports", "Each report carries its full investigative summary in `body`, so keep limit small."],
  ["get_incident_report", "/v1/incident_reports/{id}"],
  ["list_incident_report_comments", "/v1/incident_reports/{id}/comments"],
  ["list_remediations", "/v1/incident_reports/{incident_report_id}/remediations"],
  ["get_remediation", "/v1/incident_reports/{incident_report_id}/remediations/{remediation_id}"],
  ["list_escalations", "/v1/escalations"],
  ["get_escalation", "/v1/escalations/{id}"],
  ["list_signals", "/v1/signals"],
  ["get_signal", "/v1/signals/{id}"],
  ["list_reports", "/v1/reports"],
  ["get_report", "/v1/reports/{id}"],
  ["list_identities", "/v1/identities", "Huntress ITDR identities (Microsoft 365 / Google Workspace users)."],
  ["get_identity", "/v1/identities/{id}"],
  ["list_external_ports", "/v1/external_ports"],
  ["get_external_port", "/v1/external_ports/{id}"],
  ["list_platform_actions", "/v1/platform_actions"],
  ["get_platform_action", "/v1/platform_actions/{id}"],
  ["list_unwanted_access_rules", "/v1/unwanted_access_rules"],
  ["get_unwanted_access_rule", "/v1/unwanted_access_rules/{id}"],
  ["list_known_vpns", "/v1/known_vpns", "Values accepted by the `vpn` filter of list_unwanted_access_rules."],
  ["list_memberships", "/v1/memberships"],
  ["get_membership", "/v1/memberships/{id}"],
  ["list_remote_access_connections", "/v1/remote_access/connections"],
  ["list_siem_log_sources", "/v1/siem/log_sources"],
  ["get_siem_log_source", "/v1/siem/log_sources/{id}"],
  ["list_invoices", "/v1/invoices"],
  ["get_invoice", "/v1/invoices/{id}"],
];

const clean = (s, max = 400) => {
  const t = String(s || "").replace(/<[^>]+>/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
};

function schemaFor(p) {
  let out;
  if (p.type === "array") {
    out = { type: "array", items: { type: p.items?.type || "string" } };
    if (p.items?.enum) out.items.enum = p.items.enum;
  } else {
    out = { type: p.type || "string" };
    if (p.enum) out.enum = p.enum;
    if (p.minimum !== undefined) out.minimum = p.minimum;
    if (p.maximum !== undefined) out.maximum = p.maximum;
  }
  const d = clean(p.description);
  if (d) out.description = d;
  return out;
}

const tools = MAP.map(([name, path, extra]) => {
  const op = spec.paths[path]?.get;
  if (!op) throw new Error(`${name}: no GET ${path} in the spec`);
  const properties = {};
  const required = [];
  const query = {}; // tool argument name -> wire name
  const pathParams = [];
  for (const p of op.parameters || []) {
    if (p.in === "path") {
      pathParams.push(p.name);
      required.push(p.name);
      properties[p.name] = { type: p.type === "integer" ? "integer" : "string", description: `${p.name.replace(/_/g, " ")}` };
    } else if (p.in === "query") {
      // The spec names list_remediations' filters `types[]` / `statuses[]`,
      // but Huntress rejects those ("types provided are invalid") and accepts
      // `types=manual,containment` (checked live 2026-11-12 on incident
      // report 2611121). So the brackets are dropped on the wire too, and
      // index.js sends an array comma-separated.
      const arg = p.name.replace(/\[\]$/, "");
      query[arg] = arg;
      properties[arg] = schemaFor(p);
      if (p.required) required.push(arg);
    }
  }
  const description = [clean(op.summary, 100) + ".", clean(op.description, 500), extra || "", `GET ${path}.`]
    .filter(Boolean).join(" ").replace(/\.\./g, ".");
  const inputSchema = { type: "object", properties };
  if (required.length) inputSchema.required = required;
  return { name, description, path, pathParams, query, inputSchema };
});

writeFileSync(join(root, "src/tools.json"), JSON.stringify(tools, null, 1) + "\n");
console.log(`wrote ${tools.length} tools to src/tools.json`);
