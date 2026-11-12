import {
  AuthorizationError,
  CimdFetchError,
  GrantType,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  authorizationErrorRedirect,
  insufficientScope,
} from "@cloudflare/workers-oauth-provider";
import { SCOPE_READ, SCOPE_WRITE, SCOPES_SUPPORTED, accessRefusal, intVar, issuer, redirectAllowed, resourceFor, serverForResource, servers } from "./config.js";
import { EntraGrantError, entraAuthorizeUrl, randomToken, redeemCode, refreshIdentity } from "./entra.js";
import { consentPage, errorPage } from "./pages.js";
import { proxyMcp } from "./proxy.js";

var built = null;
function build(env) {
  const sig = JSON.stringify([env.ISSUER, env.SERVERS, env.ALLOWED_REDIRECT_HOSTS, env.ACCESS_TOKEN_TTL, env.REFRESH_TOKEN_TTL]);
  if (built && built.sig === sig) return built;
  const srv = servers(env);
  const iss = issuer(env);
  const as = new OAuthAuthorizationServer({
    issuer: iss,
    resources: Object.keys(srv).map((k) => resourceFor(env, k)),
    scopesSupported: SCOPES_SUPPORTED,
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: intVar(env.ACCESS_TOKEN_TTL, 3600),
    refreshTokenTTL: intVar(env.REFRESH_TOKEN_TTL, 7 * 86400),
    clientRegistrationCallback: (({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || !uris.every((u) => redirectAllowed(env, String(u)))) {
        console.warn(JSON.stringify({ evt: "dcr_rejected", client_name: clientMetadata.client_name, redirect_uris: uris }));
        return { code: "invalid_redirect_uri", description: "No redirect URI is allowed by this gateway", status: 403 };
      }
    }),
    // Every gateway refresh re-asks Entra: a disabled account, revoked sessions or a removed role
    // ends access within one access-token lifetime instead of at the end of the grant.
    tokenExchangeCallback: (async ({ grantType, props, requestedScope, resource, env: e }) => {
      if (grantType !== GrantType.REFRESH_TOKEN) return;
      const p = props;
      if (!p.entraRt) throw new OAuthError("invalid_grant", { description: "Sign in again" });
      let id;
      try {
        id = await refreshIdentity(e, p.entraRt);
      } catch (error) {
        console.warn(JSON.stringify({ evt: "refresh_entra_failed", user: p.upn, detail: String(error) }));
        if (error instanceof EntraGrantError) throw new OAuthError("invalid_grant", { description: "Microsoft sign-in is no longer valid" });
        throw new OAuthError("temporarily_unavailable", { description: "Microsoft sign-in is unavailable", statusCode: 503 });
      }
      const canWrite = id.roles.includes(e.ROLE_WRITE);
      const refusal = id.oid !== p.oid ? "oid_changed" : accessRefusal(e, resource, id.roles);
      if (refusal) {
        console.warn(JSON.stringify({ evt: "refresh_denied", user: p.upn, reason: refusal }));
        throw new OAuthError("invalid_grant", { description: "Your account is no longer assigned to the Altec MCP Gateway" });
      }
      const newProps = { ...p, upn: id.upn, name: id.name, roles: id.roles, entraRt: id.refreshToken ?? p.entraRt };
      return { newProps, accessTokenScope: canWrite ? requestedScope : requestedScope.filter((s) => s !== SCOPE_WRITE) };
    }),
    onError: (({ code, status, description, internal }) => {
      console.warn(JSON.stringify({ evt: "oauth_error", code, status, description, internal }));
    })
  });
  const rs = new Map();
  for (const [key, cfg] of Object.entries(srv)) {
    rs.set(
      key,
      new OAuthResourceServer({
        resourceMetadata: {
          resource: resourceFor(env, key),
          authorization_servers: [iss],
          bearer_methods_supported: ["header"],
          resource_name: `Altec ${cfg.name}`
        },
        requiredScopes: [SCOPE_READ],
        validateToken: (e) => (resource, token) => as.validateToken(resource, token, e),
        handler: {
          fetch(request, e, ctx) {
            if (!ctx.auth.scope.includes(SCOPE_READ)) return insufficientScope(ctx.auth, [SCOPE_READ]);
            return proxyMcp(request, e, ctx, key, cfg);
          }
        }
      })
    );
  }
  built = { sig, as, rs };
  return built;
}
function serverName(env, resource) {
  return serverForResource(env, resource)?.cfg.name ?? "Altec tools";
}
function redirect(location, headers = new Headers()) {
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers });
}
function authError(env, error) {
  if (error instanceof AuthorizationError && error.redirectTo && error.redirectUri && redirectAllowed(env, error.redirectUri)) {
    return redirect(error.redirectTo);
  }
  if (error instanceof AuthorizationError) return errorPage("Sign-in could not continue", error.description);
  if (error instanceof CimdFetchError) return errorPage("App could not be verified", "The app's registration document could not be loaded.");
  throw error;
}
async function startEntra(env, oauth, authReq, headers) {
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const tx = await oauth.beginUpstream(authReq, { data: { verifier, nonce }, headers });
  return redirect(await entraAuthorizeUrl(env, tx.state, verifier, nonce), tx.headers);
}
async function authorize(request, env, b) {
  const oauth = b.as.getOAuthApi(env);
  const remember = env.CONSENT_SECRET ? { secret: env.CONSENT_SECRET, maxAgeSeconds: 30 * 86400 } : void 0;
  try {
    if (request.method === "GET") {
      const authReq = await oauth.parseAuthRequest(request);
      if (!redirectAllowed(env, authReq.redirectUri)) {
        console.warn(JSON.stringify({ evt: "redirect_blocked", client: authReq.clientId, redirect: authReq.redirectUri }));
        return errorPage("App not allowed", `Sign-in for ${new URL(authReq.redirectUri).hostname} is not enabled on the Altec gateway. Contact Altec to add it.`, 403);
      }
      if (remember && await oauth.isConsentRemembered(request, authReq, remember)) return startEntra(env, oauth, authReq);
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle, serverName(env, authReq.resource)), { headers: consent.headers });
    }
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, remember ? { remember } : void 0);
      return startEntra(env, oauth, approved.request, approved.headers);
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    return authError(env, error);
  }
}
async function callback(request, env, b) {
  const oauth = b.as.getOAuthApi(env);
  let resumed;
  try {
    resumed = await oauth.finishUpstream(request);
  } catch (error) {
    return authError(env, error);
  }
  const { request: original, data, headers } = resumed;
  const q = new URL(request.url).searchParams;
  const deny = ((reason, description) => {
    console.warn(JSON.stringify({ evt: "signin_denied", reason, client: original.clientId }));
    return redirect(authorizationErrorRedirect(original, "access_denied", description), headers);
  });
  if (q.get("error")) return deny(`entra:${q.get("error")}`, "Microsoft sign-in was cancelled or failed");
  const code = q.get("code");
  if (!code) return deny("no_code", "Microsoft sign-in returned no code");
  let id;
  try {
    id = await redeemCode(env, code, data.verifier, data.nonce);
  } catch (error) {
    console.error(JSON.stringify({ evt: "entra_redeem_failed", detail: String(error) }));
    return redirect(authorizationErrorRedirect(original, "server_error", "Microsoft sign-in could not be verified"), headers);
  }
  const canWrite = id.roles.includes(env.ROLE_WRITE);
  const refusal = accessRefusal(env, original.resource, id.roles);
  if (refusal) {
    const msg = refusal.startsWith("missing_server_role") ? `Your account is not assigned the role for ${serverName(env, original.resource)}` : "Your account is not assigned to the Altec MCP Gateway";
    return deny(`${refusal}:${id.upn}`, msg);
  }
  const scope = canWrite ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
  if (original.scope.includes("offline_access")) scope.push("offline_access");
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: id.oid,
    metadata: { upn: id.upn },
    scope,
    props: { oid: id.oid, upn: id.upn, name: id.name, roles: id.roles, entraRt: id.refreshToken }
  });
  console.log(JSON.stringify({ evt: "signin", user: id.upn, client: original.clientId, resource: original.resource, scope }));
  return redirect(redirectTo, headers);
}
async function admin(request, env, b) {
  if (!env.ADMIN_API_KEY) return new Response("Not found", { status: 404 });
  const presented = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const a = new TextEncoder().encode(presented);
  const k = new TextEncoder().encode(env.ADMIN_API_KEY);
  if (a.byteLength !== k.byteLength || !crypto.subtle.timingSafeEqual(a, k)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(request.url);
  const user = (url.searchParams.get("user") || "").toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(user)) return Response.json({ error: "user must be an Entra object ID (oid)" }, { status: 400 });
  const oauth = b.as.getOAuthApi(env);
  const grants = [];
  let cursor;
  do {
    const page = await oauth.listUserGrants(user, { cursor });
    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  if (url.pathname === "/admin/grants" && request.method === "GET") {
    return Response.json(grants.map((g) => ({ id: g.id, clientId: g.clientId, scope: g.scope, metadata: g.metadata, createdAt: g.createdAt, expiresAt: g.expiresAt })));
  }
  if (url.pathname === "/admin/revoke" && request.method === "POST") {
    for (const g of grants) await oauth.revokeGrant(g.id, user);
    console.log(JSON.stringify({ evt: "admin_revoke", user, count: grants.length }));
    return Response.json({ revoked: grants.length });
  }
  return new Response("Not found", { status: 404 });
}
export default {
  async fetch(request, env, ctx) {
    let b;
    try {
      b = build(env);
    } catch (error) {
      console.error(JSON.stringify({ evt: "config_error", detail: String(error) }));
      return new Response("Gateway misconfigured", { status: 500 });
    }
    const path = new URL(request.url).pathname;
    if (path === "/authorize") return authorize(request, env, b);
    if (path === "/callback") return callback(request, env, b);
    if (path.startsWith("/admin/")) return admin(request, env, b);
    if (path === "/" && request.method === "GET") {
      return Response.json({
        service: "Altec MCP Gateway",
        servers: Object.entries(servers(env)).map(([k, s]) => ({ name: s.name, url: resourceFor(env, k) }))
      });
    }
    const m = path.match(/^\/(?:\.well-known\/oauth-protected-resource\/)?([a-z0-9-]+)\/mcp(?:\/|$)/);
    const rs = m ? b.rs.get(m[1]) : void 0;
    if (rs) return rs.fetch(request, env, ctx);
    return b.as.fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    const result = await build(env).as.purgeExpiredData(env);
    console.log(JSON.stringify({ evt: "purge", ...result }));
  }
};
