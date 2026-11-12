import servers_default from "../servers.json";

export var SCOPE_READ = "mcp:read";
export var SCOPE_WRITE = "mcp:write";
export var SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE, "offline_access"];
export function serverForResource(env, resource) {
  for (const [key, cfg] of Object.entries(servers(env))) if (resourceFor(env, key) === resource) return { key, cfg };
  return null;
}
export function accessRefusal(env, resource, roles) {
  if (!(roles.includes(env.ROLE_WRITE) || roles.includes(env.ROLE_READ))) return "no_gateway_role";
  const s = serverForResource(env, resource);
  if (!s) return "unknown_resource";
  if (s.cfg.roles?.length && !s.cfg.roles.some((r) => roles.includes(r))) return `missing_server_role:${s.key}`;
  return null;
}
export var KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function issuer(env) {
  return String(env.ISSUER || "").replace(/\/+$/, "");
}
export function resourceFor(env, key) {
  return `${issuer(env)}/${key}/mcp`;
}
export function servers(env) {
  const s = env.SERVERS && typeof env.SERVERS === "object" ? env.SERVERS : servers_default.servers;
  if (!s || typeof s !== "object") throw new Error('No servers configured (servers.json "servers" or SERVERS var)');
  for (const [key, cfg] of Object.entries(s)) {
    if (!KEY_PATTERN.test(key)) throw new Error(`SERVERS key "${key}" must match ${KEY_PATTERN}`);
    if (!cfg.upstream || !cfg.secret || !Array.isArray(cfg.readTools)) {
      throw new Error(`SERVERS.${key} needs upstream, secret and readTools`);
    }
  }
  return s;
}
export function intVar(value, fallback) {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export function toolAllowed(patterns, name) {
  if (typeof name !== "string" || !name) return false;
  return patterns.some((p) => {
    const re = new RegExp("^" + p.split("*").map(escapeRegex).join(".*") + "$");
    return re.test(name);
  });
}
export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function redirectAllowed(env, redirectUri) {
  let u;
  try {
    u = new URL(redirectUri);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (loopback) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:") return false;
  const allowed = (env.ALLOWED_REDIRECT_HOSTS || []).map((h) => h.toLowerCase());
  return allowed.includes(host);
}

