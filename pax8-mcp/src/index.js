/**
 * pax8-mcp gateway
 *
 * Passthrough — proxies /mcp JSON-RPC to Pax8's real MCP endpoint,
 * injecting OAuth2 Bearer token auth from your stored secrets. Also
 * exposes /api/pax8/* as a raw REST passthrough for the wallboard.
 *
 * SECRETS (wrangler secret put):
 *   PAX8_CLIENT_ID      — OAuth2 client ID from app.pax8.com > Partner Portal > Company > API
 *   PAX8_CLIENT_SECRET  — OAuth2 client secret from same location
 *
 * FIXED (round 2): the REST proxy was targeting /v2/{path}, which doesn't
 * exist on Pax8's API — confirmed against their own official reference
 * docs (devx.pax8.com/reference/findsubscriptions) that the real path is
 * /v1/subscriptions. The previous fix (token endpoint → login.pax8.com)
 * was correct and got auth working; this was the next layer down — auth
 * succeeded, then the proxied request 404'd against a path that was never
 * real, and that 404 passed straight through to the browser.
 *
 * Token endpoint: https://login.pax8.com/oauth/token
 * MCP endpoint:   https://mcp.pax8.com/v1/mcp
 * REST API base:  https://api.pax8.com/v1/
 */

const PAX8_MCP_URL = "https://mcp.pax8.com/v1/mcp";
const PAX8_TOKEN_URL = "https://login.pax8.com/oauth/token";
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, env);
    }

    if (url.pathname.startsWith("/api/pax8/")) {
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
  const token = await getToken(env);
  const res = await fetch(PAX8_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(rpcBody),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pax8 MCP returned ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// ─── Raw REST passthrough (separate OAuth2 credentials) ───────────────────────

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
    headers: { "Content-Type": "application/json" },
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
