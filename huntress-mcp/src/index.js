/**
 * huntress-mcp gateway
 *
 * Passthrough — proxies /mcp JSON-RPC to Huntress's real MCP endpoint,
 * injecting Basic auth from your stored secrets.
 *
 * SECRETS (wrangler secret put):
 *   HUNTRESS_API_KEY     — from Huntress portal: Admin > API Credentials
 *   HUNTRESS_API_SECRET  — from same location
 */

const HUNTRESS_MCP_URL = "https://api.huntress.io/v1/mcp";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json",
};

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

    if (url.pathname.startsWith("/api/huntress/")) {
      return proxyRest(request, env, url);
    }

    return new Response(
      "huntress-mcp gateway — POST /mcp | GET /health | /api/huntress/* (REST passthrough)",
      { status: 200, headers: CORS_HEADERS }
    );
  },
};

// ─── MCP passthrough ─────────────────────────────────────────────────────────

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
            serverInfo: { name: "huntress-mcp-gateway", version: "1.0.0" },
          },
        });
      } else if (method === "ping") {
        responses.push({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list" || method === "tools/call") {
        const vendorResult = await callHuntressMcp(env, { jsonrpc: "2.0", id: 1, method, params });
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

async function callHuntressMcp(env, rpcBody) {
  if (!env.HUNTRESS_API_KEY || !env.HUNTRESS_API_SECRET) {
    throw new Error("HUNTRESS_API_KEY and HUNTRESS_API_SECRET secrets are required — run: wrangler secret put HUNTRESS_API_KEY");
  }
  const creds = btoa(`${env.HUNTRESS_API_KEY}:${env.HUNTRESS_API_SECRET}`);
  const res = await fetch(HUNTRESS_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Basic ${creds}`,
    },
    body: JSON.stringify(rpcBody),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Huntress MCP returned ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

// ─── Raw REST passthrough ─────────────────────────────────────────────────────

async function proxyRest(request, env, url) {
  const subpath = url.pathname.replace("/api/huntress/", "");
  const target = `https://api.huntress.io/v1/${subpath}${url.search}`;
  const headers = new Headers(request.headers);
  const creds = btoa(`${env.HUNTRESS_API_KEY}:${env.HUNTRESS_API_SECRET}`);
  headers.set("Authorization", `Basic ${creds}`);
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
