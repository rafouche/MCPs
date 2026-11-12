export var b64url = {
  encode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - s.length % 4);
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
};
export function randomToken(bytes = 32) {
  return b64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));
}
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url.encode(digest);
}
export function authority(env) {
  return (env.ENTRA_AUTHORITY || "https://login.microsoftonline.com").replace(/\/+$/, "");
}
export function callbackUrl(env) {
  return `${String(env.ISSUER).replace(/\/+$/, "")}/callback`;
}
export async function entraAuthorizeUrl(env, state, verifier, nonce) {
  const u = new URL(`${authority(env)}/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize`);
  u.searchParams.set("client_id", env.ENTRA_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", callbackUrl(env));
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}
export var EntraGrantError = class extends Error {
};
export var SCOPE = "openid profile email offline_access";
export async function tokenRequest(env, params, nonce) {
  const res = await fetch(`${authority(env)}/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.ENTRA_CLIENT_ID, client_secret: env.ENTRA_CLIENT_SECRET, scope: SCOPE, ...params })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) {
    const msg = `Entra token request failed: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim();
    if (body.error === "invalid_grant" || body.error === "interaction_required") throw new EntraGrantError(msg);
    throw new Error(msg);
  }
  const claims = await verifyIdToken(env, body.id_token, nonce);
  const oid = String(claims.oid ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(oid)) throw new Error("ID token has no valid oid claim");
  return {
    oid: oid.toLowerCase(),
    upn: String(claims.preferred_username ?? claims.email ?? claims.upn ?? oid),
    name: String(claims.name ?? ""),
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
    refreshToken: body.refresh_token
  };
}
export function redeemCode(env, code, verifier, nonce) {
  return tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: callbackUrl(env), code_verifier: verifier }, nonce);
}
export function refreshIdentity(env, refreshToken) {
  return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}
export var jwksCache = null;
export var JWKS_TTL_MS = 6 * 60 * 60 * 1e3;
export async function loadJwks(env, force = false) {
  const url = `${authority(env)}/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`;
  if (!force && jwksCache && jwksCache.url === url && Date.now() - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { url, keys, at: Date.now() };
  return keys;
}
export async function verifyIdToken(env, jwt, nonce) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed ID token");
  const header = JSON.parse(new TextDecoder().decode(b64url.decode(parts[0])));
  if (header.alg !== "RS256" || !header.kid) throw new Error(`Unexpected ID token alg/kid: ${header.alg}`);
  let jwk = (await loadJwks(env)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await loadJwks(env, true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("ID token signing key not found");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok2 = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64url.decode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok2) throw new Error("ID token signature invalid");
  const c = JSON.parse(new TextDecoder().decode(b64url.decode(parts[1])));
  const now = Math.floor(Date.now() / 1e3);
  const expectedIss = `${authority(env)}/${env.ENTRA_TENANT_ID}/v2.0`;
  if (c.iss !== expectedIss) throw new Error(`ID token issuer mismatch: ${c.iss}`);
  if (c.aud !== env.ENTRA_CLIENT_ID) throw new Error("ID token audience mismatch");
  if (String(c.tid ?? "").toLowerCase() !== env.ENTRA_TENANT_ID.toLowerCase()) throw new Error("ID token tenant mismatch");
  if (typeof c.exp !== "number" || c.exp < now - 300) throw new Error("ID token expired");
  if (typeof c.nbf === "number" && c.nbf > now + 300) throw new Error("ID token not yet valid");
  if (nonce !== void 0 && c.nonce !== nonce) throw new Error("ID token nonce mismatch");
  return c;
}

