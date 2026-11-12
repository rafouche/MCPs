import { SCOPE_WRITE, toolAllowed } from "./config.js";

var FORWARD_HEADERS_READ = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version"];
var FORWARD_HEADERS_WRITE = [...FORWARD_HEADERS_READ, "last-event-id"];
var RETURN_HEADERS = ["content-type", "mcp-session-id", "cache-control", "retry-after"];
var READ_METHODS = new Set(["initialize", "ping", "tools/list", "tools/call"]);
function audit(event) {
  console.log(JSON.stringify({ evt: "mcp", ts: (new Date()).toISOString(), ...event }));
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readModeRefusal(m, server) {
  if (m.method === void 0) {
    return "result" in m || "error" in m ? null : "Invalid message";
  }
  if (typeof m.method !== "string") return "Invalid method";
  if (m.method.startsWith("notifications/")) return null;
  if (!READ_METHODS.has(m.method)) return `Method not available through the read-only gateway: ${m.method}`;
  if (m.method === "tools/call" && !toolAllowed(server.readTools, m.params?.name)) {
    return `Unknown tool: ${String(m.params?.name ?? "")} (not available through the read-only gateway)`;
  }
  return null;
}
export async function proxyMcp(request, env, ctx, key, server) {
  const props = ctx.props;
  const writeMode = server.allowWrite === true && ctx.auth.scope.includes(SCOPE_WRITE);
  const mode = writeMode ? "write" : "read";
  const inUrl = new URL(request.url);
  if (inUrl.pathname !== `/${key}/mcp`) return new Response("Not found", { status: 404 });
  const allowedMethods = writeMode ? ["POST", "GET", "DELETE"] : ["POST", "DELETE"];
  if (!allowedMethods.includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: { Allow: allowedMethods.join(", ") } });
  }
  const secret = env[server.secret];
  const hasSecret = typeof secret === "string" && secret.length > 0;
  if (!hasSecret && server.noAuth !== true) {
    audit({ key, user: props.upn, outcome: "config_error", detail: `secret ${server.secret} not set` });
    return Response.json(rpcError(null, -32603, "Gateway is not configured for this server"), { status: 500 });
  }
  const upstreamAuth = hasSecret ? "secret" : "none";
  const headers = new Headers();
  for (const h of writeMode ? FORWARD_HEADERS_WRITE : FORWARD_HEADERS_READ) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (hasSecret) headers.set(server.authHeader || "Authorization", (server.authPrefix ?? "Bearer ") + secret);
  headers.set("X-MCP-Gateway-User", props.upn);
  let body;
  let messages = [];
  let isBatch = false;
  if (request.method === "POST") {
    let parsed;
    try {
      parsed = JSON.parse(await request.text());
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
    }
    isBatch = Array.isArray(parsed);
    const list = isBatch ? parsed : [parsed];
    if (list.length === 0 || !list.every(isPlainObject)) {
      return Response.json(rpcError(null, -32600, "Invalid request"), { status: 400 });
    }
    messages = list;
    const refusals = writeMode ? messages.map(() => null) : messages.map((m) => readModeRefusal(m, server));
    for (const [i, m] of messages.entries()) {
      if (typeof m.method !== "string" || m.method.startsWith("notifications/")) continue;
      audit({
        key,
        user: props.upn,
        client: ctx.auth.clientId,
        mode,
        upstreamAuth,
        method: m.method,
        tool: m.method === "tools/call" ? String(m.params?.name ?? "") : void 0,
        outcome: refusals[i] ? "blocked" : "forwarded"
      });
    }
    if (refusals.some((r) => r)) {
      const errors = messages.map((m, i) => ({ m, r: refusals[i] })).filter(({ m }) => m.id !== void 0 && m.method !== void 0).map(({ m, r }) => rpcError(m.id, r?.startsWith("Method") ? -32601 : -32602, r ?? "Request refused: batch contained a refused message"));
      if (!errors.length) return new Response(null, { status: 202 });
      return Response.json(isBatch ? errors : errors[0], { status: 200 });
    }
    body = JSON.stringify(parsed);
  } else {
    audit({ key, user: props.upn, client: ctx.auth.clientId, mode, upstreamAuth, method: `HTTP ${request.method}`, outcome: "forwarded" });
  }
  const upstreamRequest = new Request(server.upstream, { method: request.method, headers, body, redirect: "manual" });
  const binding = server.binding ? env[server.binding] : void 0;
  let res;
  try {
    res = binding ? await binding.fetch(upstreamRequest) : await fetch(upstreamRequest);
  } catch (err2) {
    audit({ key, user: props.upn, outcome: "upstream_unreachable", detail: String(err2) });
    return Response.json(rpcError(null, -32603, "Upstream MCP server unreachable"), { status: 502 });
  }
  if (res.status >= 300 && res.status < 400 || res.status === 401 || res.status === 403) {
    audit({ key, user: props.upn, outcome: "upstream_rejected", status: res.status });
    return Response.json(rpcError(null, -32603, "Upstream MCP server refused the gateway"), { status: 502 });
  }
  const outHeaders = new Headers();
  for (const h of RETURN_HEADERS) {
    const v = res.headers.get(h);
    if (v) outHeaders.set(h, v);
  }
  const needsFilter = !writeMode && messages.some((m) => m.method === "tools/list");
  if (!needsFilter) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: outHeaders });
  }
  if (!res.ok) {
    return Response.json(rpcError(null, -32603, "Upstream error"), { status: 502 });
  }
  const filter = ((m) => {
    if (isPlainObject(m) && isPlainObject(m.result) && Array.isArray(m.result.tools)) {
      m.result.tools = m.result.tools.filter((t) => toolAllowed(server.readTools, t?.name));
    }
    return m;
  });
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  let out;
  if (contentType.includes("text/event-stream")) {
    out = text.split(/\r\n|\r|\n/).map((line) => {
      if (line === "" || line.startsWith(":") || /^(event|id|retry):/.test(line)) return line;
      if (line.startsWith("data:")) {
        try {
          const parsed = JSON.parse(line.slice(5).trim());
          return "data: " + JSON.stringify(Array.isArray(parsed) ? parsed.map(filter) : filter(parsed));
        } catch {
        }
      }
      return "data: " + JSON.stringify(rpcError(null, -32603, "Unexpected upstream event dropped"));
    }).join("\n");
  } else {
    try {
      const parsed = JSON.parse(text);
      out = JSON.stringify(Array.isArray(parsed) ? parsed.map(filter) : filter(parsed));
    } catch {
      return Response.json(rpcError(null, -32603, "Unexpected upstream response"), { status: 502 });
    }
  }
  return new Response(out, { status: res.status, headers: outHeaders });
}

