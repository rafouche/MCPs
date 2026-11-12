/**
 * pax8-mcp gateway
 *
 * Passthrough: relays /mcp JSON-RPC to Pax8's hosted MCP server and exposes
 * /api/pax8/* as a read-only raw REST passthrough for the wallboard. The two
 * paths use DIFFERENT credentials, because Pax8's MCP server does not accept
 * REST API tokens.
 *
 * SECRETS (wrangler secret put):
 *   PAX8_MCP_TOKEN      — /mcp. Pax8's MCP token, generated at
 *                         app.pax8.com/integrations/mcp ("Pax8 token (legacy)"
 *                         on devx.pax8.com/docs/mcp-server), sent as the
 *                         x-pax8-mcp-token header. Nothing is minted for it.
 *   PAX8_CLIENT_ID      — /api/pax8/*. OAuth2 client from app.pax8.com >
 *   PAX8_CLIENT_SECRET    Partner Portal > Company > API.
 *
 * /mcp auth (2026-11-12): mcp.pax8.com/v1/mcp takes either the
 * x-pax8-mcp-token header, or "Authorization: Bearer" with a token from its
 * OWN OAuth server (issuer https://mcp.pax8.com/v1, grants authorization_code
 * and refresh_token only, so a person has to sign in; see
 * mcp.pax8.com/v1/.well-known/oauth-authorization-server). A client_credentials
 * token from api.pax8.com/v1/token is refused with 401 "Invalid JWT:
 * Unexpected 'iss' value"; that is what broke /mcp after the 2026-11-11 fix
 * below. The unattended option is the MCP token header. Do not point /mcp
 * back at a login.pax8.com token to "fix" it.
 *
 * REST token endpoint (2026-11-11): Pax8 flagged this integration (client ID
 * hrUIlCVE3KNaWwnoGaqbdq2CaJ7HtWpK) for minting ~770 tokens/day directly
 * against their identity provider at login.pax8.com/oauth/token. That
 * endpoint was never Pax8's documented one (devx.pax8.com/docs/authentication
 * only documents api.pax8.com/v1/token, same JSON body shape: audience/
 * grant_type/client_id/client_secret) — the in-memory `restToken` cache
 * below only lives for one Worker isolate, so every cold isolate at every
 * edge PoP minted its own fresh token straight from the IdP. Pax8's own
 * /v1/token endpoint caches server-side and returns the same token to every
 * caller until it's near its 24h expiry, so switching the URL alone fixes
 * this regardless of how many isolates call it; the local cache stays too,
 * since Pax8's docs say "you should not need to request a new access token
 * before every request" either way.
 *
 * MCP endpoint:        https://mcp.pax8.com/v1/mcp
 * REST token endpoint: https://api.pax8.com/v1/token
 * REST API base:       https://api.pax8.com/v1/
 */

const PAX8_MCP_URL = "https://mcp.pax8.com/v1/mcp";
const PAX8_TOKEN_URL = "https://api.pax8.com/v1/token";
const PAX8_AUDIENCE = "https://api.pax8.com";
const PAX8_REST_BASE = "https://api.pax8.com/v1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json",
};

let restToken = { token: null, expires: 0 };

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

    // Inbound auth (opt-in, same as the other Workers): once the
    // MCP_AUTH_TOKEN secret is set, every route needs
    // "Authorization: Bearer <token>" except the read-only wallboard routes
    // (Roger, 2026-09-25, "option 1"): GET/HEAD on /health and the
    // /api/pax8/ REST passthrough, which the wallboard polls without a token.
    const readMethod = request.method === "GET" || request.method === "HEAD";
    const publicRead = readMethod && (url.pathname === "/health" || url.pathname.startsWith("/api/pax8/"));
    if (env.MCP_AUTH_TOKEN && !publicRead) {
      const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
      }
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, env);
    }

    if (url.pathname.startsWith("/api/pax8/")) {
      // The passthrough carries the Pax8 account's full API credentials
      // (orders included), so it is read-only: the wallboard only reads.
      // Before 2026-09-25 it forwarded any method with no auth at all.
      if (!readMethod) {
        return new Response(JSON.stringify({ error: "The REST passthrough is read-only (GET/HEAD)." }), { status: 405, headers: { ...JSON_HEADERS, Allow: "GET, HEAD" } });
      }
      // Wrapped in try/catch now — an auth failure here previously
      // crashed as an unhandled error instead of returning a readable
      // JSON message, which is what made this bug hard to diagnose.
      try {
        return await proxyRest(request, env, url);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: JSON_HEADERS });
      }
    }

    return new Response(
      "pax8-mcp gateway — POST /mcp | GET /health | /api/pax8/* (REST passthrough)",
      { status: 200, headers: CORS_HEADERS }
    );
  },
};

// ─── MCP passthrough ─────────────────────────────────────────────────────────

async function handleMcp(request, env) {
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
    const { id, method, params } = msg;
    if (id === undefined && method) continue; // notification, no reply needed

    try {
      if (method === "initialize") {
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "pax8-mcp-gateway", version: "1.0.0" },
          },
        });
      } else if (method === "ping") {
        responses.push({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list" || method === "tools/call") {
        const vendorResult = await callPax8Mcp(env, { jsonrpc: "2.0", id: 1, method, params });
        if (vendorResult.error) {
          responses.push({ jsonrpc: "2.0", id, error: vendorResult.error });
        } else {
          responses.push({ jsonrpc: "2.0", id, result: vendorResult.result });
        }
      } else {
        responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: err.message } });
    }
  }

  if (responses.length === 0) return new Response(null, { status: 204, headers: CORS_HEADERS });
  const out = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
}

async function callPax8Mcp(env, rpcBody) {
  if (!env.PAX8_MCP_TOKEN) {
    throw new Error("PAX8_MCP_TOKEN secret is required for /mcp (generate it at app.pax8.com/integrations/mcp, then: wrangler secret put PAX8_MCP_TOKEN)");
  }
  const res = await fetch(PAX8_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "x-pax8-mcp-token": env.PAX8_MCP_TOKEN,
    },
    body: JSON.stringify(rpcBody),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Pax8 MCP returned ${res.status}: ${text.substring(0, 300)}`);
  }
  // A Streamable HTTP server may answer as an event stream: take the
  // JSON-RPC response to this request out of its data: lines.
  if ((res.headers.get("Content-Type") || "").includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.id === rpcBody.id && (msg.result !== undefined || msg.error !== undefined)) return msg;
      } catch { /* not JSON; keep looking */ }
    }
    throw new Error(`Pax8 MCP sent an event stream with no response to this request: ${text.substring(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Pax8 MCP returned non-JSON (${res.status}): ${text.substring(0, 300)}`);
  }
}

// ─── Raw REST passthrough (OAuth2 client credentials, /api/pax8/* only) ──────

async function proxyRest(request, env, url) {
  const subpath = url.pathname.replace("/api/pax8/", "");
  const target = `${PAX8_REST_BASE}/${subpath}${url.search}`;

  const token = await getToken(env);
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
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

async function getToken(env) {
  if (restToken.token && restToken.expires > Date.now()) return restToken.token;
  if (!env.PAX8_CLIENT_ID || !env.PAX8_CLIENT_SECRET) {
    throw new Error("PAX8_CLIENT_ID and PAX8_CLIENT_SECRET secrets are required — run: wrangler secret put PAX8_CLIENT_ID");
  }
  const res = await fetch(PAX8_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.PAX8_CLIENT_ID,
      client_secret: env.PAX8_CLIENT_SECRET,
      audience: PAX8_AUDIENCE,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pax8 auth failed (${res.status}) at ${PAX8_TOKEN_URL}: ${text.substring(0, 200)}`);
  }
  const data = await res.json();
  restToken = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
  return data.access_token;
}

function jsonErr(id, code, message) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
    { status: 400, headers: JSON_HEADERS }
  );
}
