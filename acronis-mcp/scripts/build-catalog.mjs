// Builds src/catalog.json from Acronis's own OpenAPI specs in spec/ (downloaded
// from developer.acronis.com/doc/<api>/<version>/reference/openapi.json, the
// links on developer.acronis.com/doc/outbound/apis/api-library/index.html).
// Run: npm run catalog   (re-download spec/*.json first to pick up new endpoints)
//
// Every operation is listed (writes too, so a search shows they exist), with
// the path as acronis_api_get takes it (relative to {dc}/api, or /fc/... for
// File Sync & Share), its summary and its parameters.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const specDir = path.join(root, "spec");
const short = (s, n) => (s ? String(s).replace(/\s+/g, " ").trim().slice(0, n) : undefined);

function resolve(spec, x) {
  for (let i = 0; x && x.$ref && i < 10; i++) {
    x = x.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
  }
  return x;
}

function typeOf(spec, schema) {
  const s = resolve(spec, schema) || {};
  if (s.type === "array") return `${typeOf(spec, s.items)}[]`;
  return s.type || (s.oneOf || s.anyOf ? "mixed" : "object");
}

const apis = [];
const ops = [];
for (const file of fs.readdirSync(specDir).filter((f) => f.endsWith(".json")).sort()) {
  const spec = JSON.parse(fs.readFileSync(path.join(specDir, file), "utf8"));
  const api = file.replace(/\.json$/, "");
  // Server URL is e.g. https://dev-cloud.acronis.com/api/alert_manager/v1 or .../fc/api/v1
  const server = new URL(spec.servers?.[0]?.url || "https://x/api").pathname.replace(/\/$/, "");
  const prefix = server.startsWith("/api") ? server.slice(4) : server; // acronis_api_get adds /api itself
  let count = 0;
  for (const [p, item] of Object.entries(spec.paths || {})) {
    const shared = item.parameters || [];
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const params = [...shared, ...(op.parameters || [])].map((x) => resolve(spec, x)).filter((x) => x && x.in !== "header" && x.in !== "cookie").map((x) => {
        const sch = resolve(spec, x.schema) || {};
        const en = sch.enum || resolve(spec, sch.items)?.enum;
        return [x.name, x.in, x.required ? 1 : 0, typeOf(spec, x.schema), short(x.description, 160), en ? en.slice(0, 25) : undefined];
      });
      ops.push({ a: api, m: method.toUpperCase(), p: prefix + p, s: short(op.summary || op.operationId, 120), d: short(op.description, 400), q: params });
      count++;
    }
  }
  apis.push({ api, title: spec.info?.title, version: spec.info?.version, base: prefix || "/", operations: count });
}

const out = { built: new Date().toISOString().slice(0, 10), source: "developer.acronis.com API library", apis, ops };
fs.writeFileSync(path.join(root, "src", "catalog.json"), JSON.stringify(out));
console.log(`${ops.length} operations (${ops.filter((o) => o.m === "GET").length} GET) from ${apis.length} APIs -> src/catalog.json (${Math.round(JSON.stringify(out).length / 1024)} KB)`);
