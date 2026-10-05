// Builds src/catalog.json - a compact index of every 3CX XAPI operation and
// schema - from spec/swagger.yaml, the PBX's own OpenAPI spec.
//
//   npm run catalog
//
// To refresh it, replace spec/swagger.yaml with a newer copy (every PBX
// serves its own at https://<pbx>/xapi/v1/swagger.yaml, and 3CX publishes one
// at https://github.com/3cx/xapi-tutorial) and run the command above.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { load as yamlLoad } from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = yamlLoad(readFileSync(join(root, "spec", "swagger.yaml"), "utf8"));

const refName = (ref) => ref.split("/").pop();

// Short type names: string, int, num, bool, date-time, uuid, duration,
// binary, a schema name (Pbx.X), or T[] for arrays.
function typeOf(s) {
  if (!s) return "any";
  if (s.$ref) return refName(s.$ref);
  for (const k of ["allOf", "anyOf", "oneOf"]) {
    if (s[k]) {
      const named = s[k].find((x) => x.$ref);
      if (named) return refName(named.$ref);
      const typed = s[k].find((x) => x.type && x.type !== "object" && x.type !== "null");
      if (typed) return typeOf(typed);
    }
  }
  if (s.type === "array") return typeOf(s.items) + "[]";
  if (s.type === "integer") return "int";
  if (s.type === "number") return "num";
  if (s.type === "boolean") return "bool";
  if (s.type === "string") {
    if (s.format === "date-time") return "date-time";
    if (s.format === "uuid") return "uuid";
    if (s.format === "duration") return "duration";
    if (s.format === "date") return "date";
    if (s.format === "binary" || s.format === "base64url") return "binary";
    return "string";
  }
  if (s.type === "object") return "object";
  return "any";
}

const params = spec.components.parameters ?? {};
const resolveParam = (p) => (p.$ref ? params[refName(p.$ref)] : p);

function bodyShape(rb) {
  if (!rb) return undefined;
  if (rb.$ref) rb = spec.components.requestBodies[refName(rb.$ref)];
  const s = rb?.content?.["application/json"]?.schema;
  if (!s) return Object.keys(rb?.content ?? {})[0] ?? "body";
  if (s.$ref) return refName(s.$ref); // whole entity
  if (s.properties) {
    // Action parameters: OData binds the JSON body's keys by parameter name.
    const out = {};
    for (const [k, v] of Object.entries(s.properties)) out[k] = typeOf(v);
    return out;
  }
  return typeOf(s);
}

function responseShape(resp) {
  const ok = resp?.["200"] ?? resp?.["201"];
  if (!ok) return resp?.["204"] ? "none" : undefined;
  if (ok.$ref) return refName(ok.$ref).replace(/CollectionResponse$/, "[]");
  const s = ok.content?.["application/json"]?.schema;
  if (!s) return Object.keys(ok.content ?? {})[0];
  if (s.allOf) {
    const v = s.allOf.find((x) => x.properties?.value)?.properties.value;
    if (v) return typeOf(v);
  }
  if (s.properties?.value) return typeOf(s.properties.value);
  return typeOf(s);
}

const QUERY_LETTERS = { $top: "t", $skip: "k", $search: "s", $filter: "f", $count: "c", $orderby: "o", $select: "l", $expand: "e" };

const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ["get", "post", "patch", "put", "delete"]) {
    const op = item[method];
    if (!op) continue;
    const all = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(resolveParam).filter(Boolean);
    const pathParams = all.filter((p) => p.in === "path").map((p) => {
      const t = typeOf(p.schema);
      return p.schema?.nullable ? [p.name, t, 1] : [p.name, t];
    });
    const q = all.filter((p) => p.in === "query").map((p) => QUERY_LETTERS[p.name] ?? "").join("");
    const extraQuery = all.filter((p) => p.in === "query" && !QUERY_LETTERS[p.name]).map((p) => [p.name, typeOf(p.schema)]);
    const entry = { id: op.operationId, m: method.toUpperCase(), p: path, s: op.summary ?? "", tag: op.tags?.[0] ?? "" };
    const kind = op["x-ms-docs-operation-type"];
    if (kind && kind !== "operation") entry.k = kind;
    if (pathParams.length) entry.pp = pathParams;
    if (q) entry.q = q;
    if (extraQuery.length) entry.xq = extraQuery;
    const b = bodyShape(op.requestBody);
    if (b) entry.b = b;
    const r = responseShape(op.responses);
    if (r) entry.r = r;
    ops.push(entry);
  }
}

const schemas = {};
const enums = {};
for (const [name, s] of Object.entries(spec.components.schemas)) {
  if (!name.startsWith("Pbx.")) continue;
  if (s.enum) { enums[name] = s.enum; continue; }
  const out = {};
  let base;
  const parts = s.allOf ?? [s];
  for (const part of parts) {
    if (part.$ref) { base = refName(part.$ref); continue; }
    for (const [k, v] of Object.entries(part.properties ?? {})) out[k] = typeOf(v);
  }
  schemas[name] = base ? { base, props: out } : { props: out };
}

const catalog = { version: spec.info["x-pbx-version"] ?? spec.info.version, ops, schemas, enums };
writeFileSync(join(root, "src", "catalog.json"), JSON.stringify(catalog));
console.log(`catalog: PBX ${catalog.version}, ${ops.length} operations, ${Object.keys(schemas).length} schemas, ${Object.keys(enums).length} enums`);
