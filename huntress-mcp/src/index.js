/**
 * huntress-mcp
 *
 * Read-only MCP tools over the Huntress REST API (api.huntress.io/v1), plus a
 * read-only raw REST passthrough at /api/huntress/* for the wallboard. One
 * credential for everything: HTTP Basic with the API key and secret.
 *
 * SECRETS (Cloudflare Worker secrets):
 *   HUNTRESS_API_KEY     - Huntress portal: Admin > API Credentials (a user's
 *   HUNTRESS_API_SECRET    API credentials - see README, identities need them)
 *   MCP_AUTH_TOKEN       - optional inbound bearer token (repo standing rule)
 *
 * History (2026-11-12): until now /mcp relayed tools/list and tools/call to
 * Huntress's own hosted MCP server (api.huntress.io/v1/mcp) with Basic auth.
 * Huntress changed that server to accept only a signed-in user's OAuth token
 * (authorization_code + PKCE, scope act_as_user, no client-credentials grant,
 * no refresh token advertised), so every tool call failed with 401 "A valid
 * OAuth bearer token is required." The REST API still takes the API key. The
 * tools now call the REST API themselves.
 *
 * Tool definitions live in src/tools.json, generated from Huntress's own API
 * spec (spec/swagger_doc.json) by `npm run tools` - see scripts/build-tools.mjs.
 * Names match the ones Huntress's MCP used (mcp-gateway's readTools allowlist
 * keeps working). Every tool is a GET; nothing here isolates, uninstalls,
 * resolves or edits anything. huntress_api_get is the GET-only escape hatch.
 */

import TOOL_DEFS from "./tools.json";

const HUNTRESS_API = "https://api.huntress.io";
const MAX_CHARS = 60000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json",
};

// ─── Tools ───────────────────────────────────────────────────────────────────

const RAW_TOOL = {
  name: "huntress_api_get",
  description:
    "GET any Huntress REST API v1 path (read-only escape hatch for anything the named tools don't cover, e.g. " +
    "/siem/log_sources/misconfigured, /trials, /reseller/subscriptions, /accounts/{account_id}/agents). " +
    "Path is relative to https://api.huntress.io/v1 (a leading /v1 is accepted). Query parameters go in `params`. " +
    "Lists are paged: `limit` (1-500, default 10) and `page_token` from the previous response's pagination.next_page_token. " +
    "Response capped at 60,000 characters.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "e.g. /organizations or /incident_reports/123. Must start with '/'; no '..' or '?'." },
      params: { type: "object", description: "Query parameters, e.g. {\"limit\": 50, \"organization_id\": 123}. Arrays are sent comma-separated." },
    },
    required: ["path"],
  },
};

const TOOLS = [
  ...TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  RAW_TOOL,
];
const TOOL_BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// ─── Huntress REST ───────────────────────────────────────────────────────────

function basicAuth(env) {
  if (!env.HUNTRESS_API_KEY || !env.HUNTRESS_API_SECRET) {
    throw new Error("HUNTRESS_API_KEY and HUNTRESS_API_SECRET secrets are required (Worker > Settings > Variables and Secrets)");
  }
  return `Basic ${btoa(`${env.HUNTRESS_API_KEY}:${env.HUNTRESS_API_SECRET}`)}`;
}

function queryValue(v) {
  if (Array.isArray(v)) return v.map(String).join(",");
  return String(v);
}

async function huntressGet(env, path, query) {
  const url = new URL(HUNTRESS_API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, queryValue(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: basicAuth(env), Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Huntress API ${res.status} on GET ${url.pathname}${url.search}: ${text.substring(0, 500)}`);
  return text;
}

function out(text) {
  return text.length > MAX_CHARS
    ? text.substring(0, MAX_CHARS) + `\n... [truncated at ${MAX_CHARS} of ${text.length} chars; ask for a smaller limit or use page_token]`
    : text;
}

async function runTool(name, args, env) {
  args = args || {};

  if (name === RAW_TOOL.name) {
    let path = String(args.path || "");
    if (!path.startsWith("/")) throw new Error("path must start with '/'");
    if (path.includes("..") || path.includes("?")) throw new Error("path may not contain '..' or '?' - put query parameters in params");
    if (!/^\/v1(\/|$)/.test(path)) path = "/v1" + path;
    const params = args.params && typeof args.params === "object" ? args.params : {};
    return out(await huntressGet(env, path, params));
  }

  const def = TOOL_BY_NAME.get(name);
  if (!def) throw new Error(`Unknown tool: ${name}`);

  let path = def.path;
  for (const p of def.pathParams) {
    const v = args[p];
    if (v === undefined || v === null || v === "") throw new Error(`${p} is required`);
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
  }
  const query = {};
  for (const [arg, wire] of Object.entries(def.query)) {
    if (args[arg] !== undefined) query[wire] = args[arg];
  }
  return out(await huntressGet(env, path, query));
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

// Constant-time string compare for the inbound bearer check in fetch().
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Inbound auth (opt-in): once the MCP_AUTH_TOKEN secret is set on this
    // Worker, every route except OPTIONS and /health must carry
    // "Authorization: Bearer <that token>" - the same header the MCP client
    // registrations already send. Unset = unchanged behavior, so this code
    // deploys safely ahead of the secret. Same check as every TypeScript
    // Worker in this repo; see CLAUDE.md "Inbound auth".
    // Read-only wallboard routes stay open (Roger, 2026-09-25, "option 1"):
    // GET/HEAD on /health, /status and /licenses and the /api/huntress/ REST passthrough, which the wallboard
    // (rafouche/Dashboard, a static page) polls without a token. Every tool
    // and pipeline route needs the token once MCP_AUTH_TOKEN is set.
    const readMethod = request.method === "GET" || request.method === "HEAD";
    const publicRead = readMethod && (["/health", "/status", "/licenses"].includes(url.pathname) || url.pathname.startsWith("/api/huntress/"));
    if (env.MCP_AUTH_TOKEN && !publicRead) {
      const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
      }
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
    }

    // Streamable HTTP (MCP 2025-03-26): a server with no event stream of its own answers GET and DELETE on
    // /mcp with 405. The 200 text reply this route used to give was read by the AllieService client as a
    // stream that kept closing, retried 3-6 times every cycle (cipp-mcp log, 2026-10-26).
    if (url.pathname === "/mcp" && (request.method === "GET" || request.method === "DELETE")) return new Response(null, { status: 405, headers: { Allow: "POST" } });

    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, env);
    }

    if (url.pathname.startsWith("/api/huntress/")) {
      // The passthrough carries the account's full API credentials, so it
      // is read-only: the wallboard only ever reads (2026-09-25).
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(JSON.stringify({ error: "The REST passthrough is read-only (GET/HEAD)." }), { status: 405, headers: { ...JSON_HEADERS, Allow: "GET, HEAD" } });
      }
      return proxyRest(request, env, url);
    }

    return new Response(
      "huntress-mcp - POST /mcp | GET /health | /api/huntress/* (read-only REST passthrough)",
      { status: 200, headers: CORS_HEADERS }
    );
  },
};

// ─── MCP ─────────────────────────────────────────────────────────────────────

async function handleMcp(request, env) {
  // Read as text first so we can see what arrived if parsing fails
  let rawBody;
  try {
    rawBody = await request.text();
  } catch (err) {
    return jsonErr(null, -32700, `Could not read request body: ${err.message}`);
  }

  if (!rawBody || !rawBody.trim()) {
    return jsonErr(null, -32700, "Empty request body");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    return jsonErr(null, -32700, `Invalid JSON: ${err.message} (received: ${rawBody.substring(0, 120)})`);
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of messages) {
    const { id, method, params } = msg || {};
    if (id === undefined && method) continue; // notification, no reply needed

    try {
      if (method === "initialize") {
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "huntress-mcp", version: "2.0.0" },
          },
        });
      } else if (method === "ping") {
        responses.push({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        const text = await runTool(params?.name, params?.arguments, env);
        responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } else {
        responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
    }
  }

  if (responses.length === 0) return new Response(null, { status: 204, headers: CORS_HEADERS });
  const reply = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(reply), { headers: JSON_HEADERS });
}

// ─── Raw REST passthrough ─────────────────────────────────────────────────────

async function proxyRest(request, env, url) {
  const subpath = url.pathname.replace("/api/huntress/", "");
  const target = `https://api.huntress.io/v1/${subpath}${url.search}`;
  const headers = new Headers(request.headers);
  try {
    headers.set("Authorization", basicAuth(env));
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: JSON_HEADERS });
  }
  headers.delete("host");

  const res = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
  });
  const outHeaders = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => outHeaders.set(k, v));
  return new Response(res.body, { status: res.status, headers: outHeaders });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function jsonErr(id, code, message) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { status: 400, headers: JSON_HEADERS }
  );
}
