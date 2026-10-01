/**
 * gchannel-mcp - multi-tenant Google Workspace for an MSP, the Google
 * counterpart of cipp-mcp: one MCP server that sees every client tenant.
 *
 * Two kinds of tenant, both reached with ONE service account key
 * (GOOGLE_SERVICE_ACCOUNT_JSON) through domain-wide delegation (DWD):
 *
 *  1. Channel Partner customers. The service account impersonates a super
 *     admin of the reseller domain (GOOGLE_RESELLER_ADMIN_EMAIL). The Cloud
 *     Channel API (CHANNEL_ACCOUNT_ID) lists the customers; each customer's
 *     Admin SDK is then called as that reseller admin with
 *     customer=<cloudIdentityId>, which is how a reseller admin manages a
 *     customer's console.
 *
 *  2. Standalone tenants (not in the Partner portal, but we hold admin).
 *     Listed in the GOOGLE_TENANTS secret (JSON array, see README). Each
 *     tenant's own Admin console authorizes the SAME service account client
 *     ID for DWD, and calls impersonate that tenant's adminEmail. A tenant
 *     entry may carry its own serviceAccountJson instead.
 *
 * Every tenant tool takes `tenant`: a domain, a Google customer ID (C0...),
 * or a name as shown by list_tenants. Standalone entries win over Channel
 * customers on a match.
 *
 * Channel/billing access is read-only on purpose: no tool orders, changes or
 * cancels an entitlement - that moves money and belongs in the Partner Sales
 * Console. Workspace writes are limited to user/group housekeeping.
 *
 * Tokens are requested per call with only the scopes that call needs, so a
 * standalone tenant that has authorized a subset of the scopes still works
 * for the tools inside that subset.
 *
 * Fails closed like hudu-mcp: /mcp answers 503 until MCP_AUTH_TOKEN and
 * GOOGLE_SERVICE_ACCOUNT_JSON are set.
 */

export interface Env {
  MCP_AUTH_TOKEN?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_RESELLER_ADMIN_EMAIL?: string; // super admin in the reseller domain (Channel side)
  CHANNEL_ACCOUNT_ID?: string; // Partner Sales Console > Settings > Account ID (no "accounts/" prefix)
  GOOGLE_TENANTS?: string; // JSON array of StandaloneTenant
}

type Args = Record<string, unknown>;

interface ServiceAccountKey {
  client_email: string;
  client_id?: string;
  private_key: string;
}

interface StandaloneTenant {
  name?: string;
  domain: string;
  adminEmail: string;
  customerId?: string;
  serviceAccountJson?: string | ServiceAccountKey;
}

interface ChannelCustomer {
  name: string; // accounts/{account}/customers/{customer}
  orgDisplayName?: string;
  domain?: string;
  cloudIdentityId?: string;
  channelPartnerId?: string;
  cloudIdentityInfo?: { primaryDomain?: string; customerType?: string; adminConsoleUri?: string };
}

// Resolved tenant: who to impersonate and which customer to address.
interface TenantCtx {
  source: "channel" | "standalone";
  label: string;
  domain: string;
  customerId?: string; // real Google customer ID when known
  subject: string;
  sa: ServiceAccountKey;
}

// ─── Scopes ───────────────────────────────────────────────────────────────────

const G = "https://www.googleapis.com/auth/";
const S = {
  order: [G + "apps.order"],
  user: [G + "admin.directory.user"],
  userRead: [G + "admin.directory.user.readonly"],
  userSecurity: [G + "admin.directory.user.security"],
  group: [G + "admin.directory.group"],
  groupRead: [G + "admin.directory.group.readonly"],
  orgunitRead: [G + "admin.directory.orgunit.readonly"],
  domainRead: [G + "admin.directory.domain.readonly"],
  customerRead: [G + "admin.directory.customer.readonly"],
  chromeRead: [G + "admin.directory.device.chromeos.readonly"],
  mobileRead: [G + "admin.directory.device.mobile.readonly"],
  roleRead: [G + "admin.directory.rolemanagement.readonly"],
  audit: [G + "admin.reports.audit.readonly"],
  usage: [G + "admin.reports.usage.readonly"],
  licensing: [G + "apps.licensing"],
  alerts: [G + "apps.alerts"],
};

const CHANNEL = "https://cloudchannel.googleapis.com/v1";
const RESELLER = "https://reseller.googleapis.com/apps/reseller/v1";
const DIR = "https://admin.googleapis.com/admin/directory/v1";
const RPT = "https://admin.googleapis.com/admin/reports/v1";
const LIC = "https://licensing.googleapis.com/apps/licensing/v1";
const ALERTS = "https://alertcenter.googleapis.com/v1beta1";

// ─── Google auth (service account JWT -> access token, cached per isolate) ────

const tokenCache = new Map<string, { token: string; exp: number }>();

function b64url(s: string | Uint8Array): string {
  const str = typeof s === "string" ? s : String.fromCharCode(...s);
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function parseSa(raw: string | ServiceAccountKey, what: string): ServiceAccountKey {
  let sa: ServiceAccountKey;
  try { sa = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new Error(`${what} is not valid JSON.`); }
  if (!sa?.client_email || !sa?.private_key) throw new Error(`${what} is missing client_email or private_key.`);
  return sa;
}

async function getToken(sa: ServiceAccountKey, subject: string, scopes: string[]): Promise<string> {
  const key = `${sa.client_email}|${subject}|${scopes.join(" ")}`;
  const hit = tokenCache.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: sa.client_email, sub: subject, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signingInput = `${header}.${payload}`;
  const pem = sa.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const keyData = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", keyData.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput)));
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    // unauthorized_client almost always means the DWD entry for this client ID
    // in that tenant's Admin console lacks one of the requested scopes.
    throw new Error(`Google token for ${subject} failed (${res.status}): ${text} - scopes requested: ${scopes.join(" ")}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache.set(key, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

async function gReq(sa: ServiceAccountKey, subject: string, scopes: string[], method: string, url: string, params?: Record<string, unknown>, body?: unknown): Promise<unknown> {
  const token = await getToken(sa, subject, scopes);
  const u = new URL(url);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(u.toString(), {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    lastErr = `${method} ${u.pathname}${u.search} failed (${res.status}): ${(await res.text()).slice(0, 1500)}`;
    if (![429, 500, 502, 503, 504].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(lastErr);
}

// ─── Tenant resolution ────────────────────────────────────────────────────────

function mainSa(env: Env): ServiceAccountKey {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON secret is not set.");
  return parseSa(env.GOOGLE_SERVICE_ACCOUNT_JSON, "GOOGLE_SERVICE_ACCOUNT_JSON");
}

function standaloneTenants(env: Env): StandaloneTenant[] {
  if (!env.GOOGLE_TENANTS) return [];
  let list: unknown = env.GOOGLE_TENANTS;
  try { if (typeof list === "string") list = JSON.parse(list); } catch { throw new Error("GOOGLE_TENANTS secret is not valid JSON (expected an array)."); }
  if (!Array.isArray(list)) throw new Error("GOOGLE_TENANTS must be a JSON array.");
  return list as StandaloneTenant[];
}

function channelConfigured(env: Env): boolean {
  return Boolean(env.CHANNEL_ACCOUNT_ID && env.GOOGLE_RESELLER_ADMIN_EMAIL);
}

function channelAccount(env: Env): string {
  if (!channelConfigured(env)) throw new Error("Channel side not configured: set CHANNEL_ACCOUNT_ID and GOOGLE_RESELLER_ADMIN_EMAIL.");
  return `accounts/${env.CHANNEL_ACCOUNT_ID!.replace(/^accounts\//, "")}`;
}

function channelGet(env: Env, path: string, params?: Record<string, unknown>): Promise<unknown> {
  return gReq(mainSa(env), env.GOOGLE_RESELLER_ADMIN_EMAIL!, S.order, "GET", `${CHANNEL}/${path.replace(/^\//, "")}`, params);
}

let customerCache: { at: number; list: ChannelCustomer[] } | null = null;

async function allChannelCustomers(env: Env, refresh = false): Promise<ChannelCustomer[]> {
  if (!refresh && customerCache && Date.now() - customerCache.at < 5 * 60_000) return customerCache.list;
  const acct = channelAccount(env);
  const list: ChannelCustomer[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = (await channelGet(env, `${acct}/customers`, { pageSize: 50, pageToken })) as { customers?: ChannelCustomer[]; nextPageToken?: string };
    list.push(...(page.customers ?? []));
    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }
  customerCache = { at: Date.now(), list };
  return list;
}

function channelDomain(c: ChannelCustomer): string {
  return c.domain ?? c.cloudIdentityInfo?.primaryDomain ?? "";
}

async function resolveTenant(env: Env, tenant: unknown): Promise<TenantCtx> {
  const q = String(tenant ?? "").trim();
  if (!q) throw new Error("tenant is required (domain, customer ID C0..., or name from list_tenants).");
  const ql = q.toLowerCase();

  for (const t of standaloneTenants(env)) {
    if ([t.domain, t.name, t.customerId].some((v) => v && v.toLowerCase() === ql)) {
      if (!t.adminEmail || !t.domain) throw new Error(`GOOGLE_TENANTS entry "${t.name ?? t.domain}" needs domain and adminEmail.`);
      return {
        source: "standalone",
        label: t.name ?? t.domain,
        domain: t.domain,
        customerId: t.customerId,
        subject: t.adminEmail,
        sa: t.serviceAccountJson ? parseSa(t.serviceAccountJson, `serviceAccountJson for ${t.domain}`) : mainSa(env),
      };
    }
  }

  if (channelConfigured(env)) {
    const match = (list: ChannelCustomer[]) =>
      list.find((c) =>
        [channelDomain(c), c.cloudIdentityId, c.orgDisplayName, c.name, c.name.split("/").pop()].some((v) => v && v.toLowerCase() === ql));
    let c = match(await allChannelCustomers(env));
    if (!c) c = match(await allChannelCustomers(env, true)); // a customer added in the last 5 minutes
    if (c) {
      if (!c.cloudIdentityId) throw new Error(`Channel customer ${c.orgDisplayName ?? c.name} has no Cloud Identity / Workspace account (cloudIdentityId is empty), so it has no Admin console to query.`);
      return { source: "channel", label: c.orgDisplayName ?? channelDomain(c), domain: channelDomain(c), customerId: c.cloudIdentityId, subject: env.GOOGLE_RESELLER_ADMIN_EMAIL!, sa: mainSa(env) };
    }
  }

  throw new Error(`No tenant matches "${q}". Run list_tenants to see what this server can reach.`);
}

// Directory API customer key: real ID when known, else the impersonated admin's own customer.
const dirCustomer = (t: TenantCtx) => t.customerId ?? "my_customer";
const tReq = (t: TenantCtx, scopes: string[], method: string, url: string, params?: Record<string, unknown>, body?: unknown) =>
  gReq(t.sa, t.subject, scopes, method, url, params, body);
const enc = encodeURIComponent;
const out = (v: unknown) => JSON.stringify(v, null, 2);

// ─── Output trimming ──────────────────────────────────────────────────────────

interface GUser {
  id?: string; primaryEmail?: string; name?: { fullName?: string }; suspended?: boolean; archived?: boolean;
  isAdmin?: boolean; isDelegatedAdmin?: boolean; isEnrolledIn2Sv?: boolean; isEnforcedIn2Sv?: boolean;
  lastLoginTime?: string; creationTime?: string; orgUnitPath?: string;
}

function trimUser(u: GUser) {
  return {
    id: u.id, primaryEmail: u.primaryEmail, name: u.name?.fullName, suspended: u.suspended, archived: u.archived,
    isAdmin: u.isAdmin, isDelegatedAdmin: u.isDelegatedAdmin, isEnrolledIn2Sv: u.isEnrolledIn2Sv, isEnforcedIn2Sv: u.isEnforcedIn2Sv,
    lastLoginTime: u.lastLoginTime, creationTime: u.creationTime, orgUnitPath: u.orgUnitPath,
  };
}

function trimCustomer(c: ChannelCustomer) {
  return { source: "channel", name: c.orgDisplayName, domain: channelDomain(c), customerId: c.cloudIdentityId, channelCustomer: c.name, channelPartnerId: c.channelPartnerId, customerType: c.cloudIdentityInfo?.customerType };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TENANT = { type: "string", description: "Client tenant: primary domain, Google customer ID (C0...), or name as shown by list_tenants" };
const PAGE = { pageToken: { type: "string", description: "nextPageToken from a previous call" } };

const TOOLS = [
  { name: "healthcheck", description: "Check configuration and connectivity: service account, Channel API access, and the standalone tenant list. Pass tenant to also test that tenant's Admin SDK access.", inputSchema: { type: "object", properties: { tenant: TENANT } } },
  { name: "list_tenants", description: "List every Google tenant this server can reach: Channel Partner customers plus standalone tenants from GOOGLE_TENANTS. Use the domain or customerId from here as `tenant` in other tools.", inputSchema: { type: "object", properties: { refresh: { type: "boolean", description: "Bypass the 5-minute Channel customer cache" } } } },

  // Channel (read-only)
  { name: "channel_get_customer", description: "Get the full Channel API customer record (org info, contacts, Cloud Identity info) for a Channel Partner customer.", inputSchema: { type: "object", properties: { tenant: TENANT }, required: ["tenant"] } },
  { name: "channel_list_entitlements", description: "List a Channel customer's entitlements (what products/SKUs they have, seat counts, plan, renewal, provisioning state). Read-only.", inputSchema: { type: "object", properties: { tenant: TENANT, ...PAGE }, required: ["tenant"] } },
  { name: "reseller_list_subscriptions", description: "List a Channel customer's Google Workspace subscriptions via the Reseller API (plan, seats, renewal settings, status, trial info). Read-only.", inputSchema: { type: "object", properties: { tenant: TENANT, ...PAGE }, required: ["tenant"] } },
  { name: "channel_api_get", description: "GET any Cloud Channel API v1 path as the reseller admin, for anything without a dedicated tool (e.g. offers, SKUs, channel partner links, entitlement changes history). Path is relative to https://cloudchannel.googleapis.com/v1/; '{account}' is replaced with accounts/<CHANNEL_ACCOUNT_ID>. Example: '{account}/customers/abc123/entitlements'.", inputSchema: { type: "object", properties: { path: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, required: ["path"] } },

  // Tenant info
  { name: "get_customer_info", description: "Get a tenant's Workspace customer record (customer ID, primary domain, org name, address, phone, alternate email, creation time).", inputSchema: { type: "object", properties: { tenant: TENANT }, required: ["tenant"] } },
  { name: "list_domains", description: "List a tenant's verified domains and domain aliases.", inputSchema: { type: "object", properties: { tenant: TENANT }, required: ["tenant"] } },

  // Users
  { name: "list_users", description: "List users in a tenant (compact rows: email, name, suspended, admin, 2SV, last login, OU). Set full=true for raw Google records.", inputSchema: { type: "object", properties: { tenant: TENANT, query: { type: "string", description: "Directory search e.g. 'isSuspended=false', 'orgUnitPath=/Sales', 'name:John'" }, maxResults: { type: "number", description: "1-500, default 100" }, orderBy: { type: "string", description: "email, familyName or givenName" }, full: { type: "boolean" }, ...PAGE }, required: ["tenant"] } },
  { name: "get_user", description: "Get a single user's full record.", inputSchema: { type: "object", properties: { tenant: TENANT, userKey: { type: "string", description: "Email or user ID" } }, required: ["tenant", "userKey"] } },
  { name: "create_user", description: "Create a user in a tenant.", inputSchema: { type: "object", properties: { tenant: TENANT, primaryEmail: { type: "string" }, givenName: { type: "string" }, familyName: { type: "string" }, password: { type: "string", description: "Initial password, 8+ characters" }, changePasswordAtNextLogin: { type: "boolean", description: "Default true" }, orgUnitPath: { type: "string", description: "Default /" } }, required: ["tenant", "primaryEmail", "givenName", "familyName", "password"] } },
  { name: "update_user", description: "Update a user: suspend/unsuspend, move OU, rename, reset password. Only the fields you pass are changed.", inputSchema: { type: "object", properties: { tenant: TENANT, userKey: { type: "string" }, suspended: { type: "boolean" }, orgUnitPath: { type: "string" }, givenName: { type: "string" }, familyName: { type: "string" }, password: { type: "string" }, changePasswordAtNextLogin: { type: "boolean" } }, required: ["tenant", "userKey"] } },
  { name: "sign_out_user", description: "Sign a user out of all web and device sessions and reset their sign-in cookies (use for a compromised account, alongside a password reset).", inputSchema: { type: "object", properties: { tenant: TENANT, userKey: { type: "string" } }, required: ["tenant", "userKey"] } },
  { name: "get_2sv_report", description: "2-Step Verification report for a tenant: counts of active users enrolled/enforced, and the list of active users NOT enrolled. Like CIPP's MFA report.", inputSchema: { type: "object", properties: { tenant: TENANT }, required: ["tenant"] } },
  { name: "list_admins", description: "List a tenant's super admins and delegated admins, plus admin role assignments.", inputSchema: { type: "object", properties: { tenant: TENANT }, required: ["tenant"] } },

  // Groups
  { name: "list_groups", description: "List groups in a tenant.", inputSchema: { type: "object", properties: { tenant: TENANT, query: { type: "string" }, userKey: { type: "string", description: "Only groups this user belongs to" }, maxResults: { type: "number", description: "1-200, default 100" }, ...PAGE }, required: ["tenant"] } },
  { name: "list_group_members", description: "List members of a group.", inputSchema: { type: "object", properties: { tenant: TENANT, groupKey: { type: "string", description: "Group email or ID" }, maxResults: { type: "number", description: "1-200, default 200" }, ...PAGE }, required: ["tenant", "groupKey"] } },
  { name: "add_group_member", description: "Add a member to a group.", inputSchema: { type: "object", properties: { tenant: TENANT, groupKey: { type: "string" }, email: { type: "string" }, role: { type: "string", description: "MEMBER (default), MANAGER or OWNER" } }, required: ["tenant", "groupKey", "email"] } },
  { name: "remove_group_member", description: "Remove a member from a group.", inputSchema: { type: "object", properties: { tenant: TENANT, groupKey: { type: "string" }, memberKey: { type: "string", description: "Member email or ID" } }, required: ["tenant", "groupKey", "memberKey"] } },

  // Org units & devices
  { name: "list_org_units", description: "List a tenant's organizational units.", inputSchema: { type: "object", properties: { tenant: TENANT, orgUnitPath: { type: "string", description: "Parent OU, default /" } }, required: ["tenant"] } },
  { name: "list_chromeos_devices", description: "List ChromeOS devices in a tenant.", inputSchema: { type: "object", properties: { tenant: TENANT, query: { type: "string", description: "e.g. status:provisioned" }, maxResults: { type: "number", description: "Default 100" }, ...PAGE }, required: ["tenant"] } },
  { name: "list_mobile_devices", description: "List managed mobile devices in a tenant.", inputSchema: { type: "object", properties: { tenant: TENANT, query: { type: "string" }, maxResults: { type: "number", description: "Default 100" }, ...PAGE }, required: ["tenant"] } },

  // Licensing
  { name: "list_license_assignments", description: "List license assignments in a tenant for a product (default Google-Apps = Workspace), optionally one SKU (e.g. 1010020027 Business Starter, 1010020028 Business Standard, 1010020025 Business Plus).", inputSchema: { type: "object", properties: { tenant: TENANT, productId: { type: "string", description: "Default Google-Apps" }, skuId: { type: "string" }, maxResults: { type: "number", description: "Default 100, max 1000" }, ...PAGE }, required: ["tenant"] } },

  // Reports & alerts
  { name: "get_login_activity", description: "Login audit events for a tenant (successful/failed logins, suspicious logins, 2SV events).", inputSchema: { type: "object", properties: { tenant: TENANT, userKey: { type: "string", description: "User email or 'all' (default)" }, eventName: { type: "string", description: "e.g. login_failure, suspicious_login, login_success" }, startTime: { type: "string", description: "RFC3339" }, endTime: { type: "string", description: "RFC3339" }, maxResults: { type: "number", description: "Default 50, max 1000" }, ...PAGE }, required: ["tenant"] } },
  { name: "get_admin_activity", description: "Admin console audit events for a tenant (who changed what).", inputSchema: { type: "object", properties: { tenant: TENANT, userKey: { type: "string", description: "Admin email or 'all' (default)" }, eventName: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, maxResults: { type: "number", description: "Default 50" }, ...PAGE }, required: ["tenant"] } },
  { name: "list_alerts", description: "List Google Alert Center alerts for a tenant (phishing, suspicious login, device compromised, DLP, Google Operations).", inputSchema: { type: "object", properties: { tenant: TENANT, filter: { type: "string", description: "Alert Center filter, e.g. createTime >= \"2026-09-01T00:00:00Z\"" }, pageSize: { type: "number", description: "Default 50" }, ...PAGE }, required: ["tenant"] } },

  // Generic
  { name: "google_api_get", description: "GET any Google admin API path in a tenant, for anything without a dedicated tool. api picks base URL and scope: directory (admin/directory/v1), reports (admin/reports/v1), licensing (apps/licensing/v1), alertcenter (v1beta1). '{customer}' in the path is replaced with the tenant's customer ID. Example: api=directory, path='/customer/{customer}/roles'.", inputSchema: { type: "object", properties: { tenant: TENANT, api: { type: "string", enum: ["directory", "reports", "licensing", "alertcenter"] }, path: { type: "string" }, params: { type: "object", additionalProperties: { type: "string" } } }, required: ["tenant", "api", "path"] } },
];

// ─── Tool implementation ──────────────────────────────────────────────────────

async function runTool(name: string, args: Args, env: Env): Promise<string> {
  if (name === "healthcheck") {
    const report: Record<string, unknown> = {};
    const sa = mainSa(env);
    report.serviceAccount = { client_email: sa.client_email, client_id: sa.client_id };
    try { report.standaloneTenants = standaloneTenants(env).map((t) => t.domain); } catch (e) { report.standaloneTenants = `ERROR: ${(e as Error).message}`; }
    if (channelConfigured(env)) {
      try { report.channelCustomers = (await allChannelCustomers(env, true)).length; } catch (e) { report.channel = `ERROR: ${(e as Error).message}`; }
    } else report.channel = "not configured (CHANNEL_ACCOUNT_ID / GOOGLE_RESELLER_ADMIN_EMAIL unset)";
    if (args.tenant) {
      try {
        const t = await resolveTenant(env, args.tenant);
        const r = (await tReq(t, S.userRead, "GET", `${DIR}/users`, { customer: dirCustomer(t), maxResults: 1 })) as { users?: unknown[] };
        report.tenant = { label: t.label, source: t.source, customerId: t.customerId, impersonating: t.subject, directoryOk: true, sampleUsers: r.users?.length ?? 0 };
      } catch (e) { report.tenant = `ERROR: ${(e as Error).message}`; }
    }
    return out(report);
  }

  if (name === "list_tenants") {
    const rows: unknown[] = standaloneTenants(env).map((t) => ({ source: "standalone", name: t.name ?? t.domain, domain: t.domain, customerId: t.customerId, adminEmail: t.adminEmail }));
    if (channelConfigured(env)) rows.push(...(await allChannelCustomers(env, Boolean(args.refresh))).map(trimCustomer));
    return out({ count: rows.length, tenants: rows });
  }

  if (name === "channel_api_get") {
    const path = String(args.path ?? "").replace("{account}", channelAccount(env));
    return out(await channelGet(env, path, args.params as Args | undefined));
  }

  const t = await resolveTenant(env, args.tenant);
  const cust = dirCustomer(t);

  switch (name) {
    // Channel
    case "channel_get_customer":
    case "channel_list_entitlements":
    case "reseller_list_subscriptions": {
      if (t.source !== "channel") throw new Error(`${t.label} is a standalone tenant, not a Channel Partner customer - no Channel/Reseller records exist for it.`);
      const c = (await allChannelCustomers(env)).find((x) => x.cloudIdentityId === t.customerId)!;
      if (name === "channel_get_customer") return out(await channelGet(env, c.name));
      if (name === "channel_list_entitlements") return out(await channelGet(env, `${c.name}/entitlements`, { pageSize: 100, pageToken: args.pageToken }));
      return out(await tReq(t, S.order, "GET", `${RESELLER}/subscriptions`, { customerId: t.customerId, maxResults: 100, pageToken: args.pageToken }));
    }

    // Tenant info
    case "get_customer_info": return out(await tReq(t, S.customerRead, "GET", `${DIR}/customers/${enc(cust)}`));
    case "list_domains": return out(await tReq(t, S.domainRead, "GET", `${DIR}/customer/${enc(cust)}/domains`));

    // Users
    case "list_users": {
      const r = (await tReq(t, S.userRead, "GET", `${DIR}/users`, { customer: cust, query: args.query, maxResults: args.maxResults ?? 100, orderBy: args.orderBy, pageToken: args.pageToken })) as { users?: GUser[]; nextPageToken?: string };
      if (args.full) return out(r);
      return out({ tenant: t.label, count: r.users?.length ?? 0, nextPageToken: r.nextPageToken, users: (r.users ?? []).map(trimUser) });
    }
    case "get_user": return out(await tReq(t, S.userRead, "GET", `${DIR}/users/${enc(String(args.userKey))}`));
    case "create_user":
      return out(trimUser((await tReq(t, S.user, "POST", `${DIR}/users`, undefined, {
        primaryEmail: args.primaryEmail,
        name: { givenName: args.givenName, familyName: args.familyName },
        password: args.password,
        changePasswordAtNextLogin: args.changePasswordAtNextLogin ?? true,
        orgUnitPath: args.orgUnitPath ?? "/",
      })) as GUser));
    case "update_user": {
      const body: Args = {};
      if (args.suspended !== undefined) body.suspended = args.suspended;
      if (args.orgUnitPath) body.orgUnitPath = args.orgUnitPath;
      if (args.givenName || args.familyName) {
        const n: Args = {};
        if (args.givenName) n.givenName = args.givenName;
        if (args.familyName) n.familyName = args.familyName;
        body.name = n;
      }
      if (args.password) body.password = args.password;
      if (args.changePasswordAtNextLogin !== undefined) body.changePasswordAtNextLogin = args.changePasswordAtNextLogin;
      if (!Object.keys(body).length) throw new Error("update_user: nothing to change.");
      return out(trimUser((await tReq(t, S.user, "PATCH", `${DIR}/users/${enc(String(args.userKey))}`, undefined, body)) as GUser));
    }
    case "sign_out_user":
      await tReq(t, S.userSecurity, "POST", `${DIR}/users/${enc(String(args.userKey))}/signOut`);
      return `Signed ${args.userKey} out of all sessions in ${t.label}.`;
    case "get_2sv_report": {
      const users: GUser[] = [];
      let pageToken: string | undefined;
      for (let i = 0; i < 40; i++) {
        const r = (await tReq(t, S.userRead, "GET", `${DIR}/users`, { customer: cust, query: "isSuspended=false", maxResults: 500, pageToken })) as { users?: GUser[]; nextPageToken?: string };
        users.push(...(r.users ?? []));
        pageToken = r.nextPageToken;
        if (!pageToken) break;
      }
      const active = users.filter((u) => !u.archived);
      const notEnrolled = active.filter((u) => !u.isEnrolledIn2Sv);
      return out({
        tenant: t.label, activeUsers: active.length,
        enrolled: active.length - notEnrolled.length,
        enforced: active.filter((u) => u.isEnforcedIn2Sv).length,
        truncated: Boolean(pageToken),
        notEnrolled: notEnrolled.map((u) => ({ primaryEmail: u.primaryEmail, name: u.name?.fullName, isAdmin: u.isAdmin, isEnforcedIn2Sv: u.isEnforcedIn2Sv, lastLoginTime: u.lastLoginTime })),
      });
    }
    case "list_admins": {
      const [supers, delegated] = await Promise.all([
        tReq(t, S.userRead, "GET", `${DIR}/users`, { customer: cust, query: "isAdmin=true", maxResults: 500 }),
        tReq(t, S.userRead, "GET", `${DIR}/users`, { customer: cust, query: "isDelegatedAdmin=true", maxResults: 500 }),
      ]) as Array<{ users?: GUser[] }>;
      let roleAssignments: unknown;
      try { roleAssignments = await tReq(t, S.roleRead, "GET", `${DIR}/customer/${enc(cust)}/roleassignments`, { maxResults: 200 }); }
      catch (e) { roleAssignments = `unavailable: ${(e as Error).message}`; }
      return out({ tenant: t.label, superAdmins: (supers.users ?? []).map(trimUser), delegatedAdmins: (delegated.users ?? []).map(trimUser), roleAssignments });
    }

    // Groups
    case "list_groups":
      return out(await tReq(t, S.groupRead, "GET", `${DIR}/groups`, args.userKey
        ? { userKey: args.userKey, maxResults: args.maxResults ?? 100, pageToken: args.pageToken }
        : { customer: cust, query: args.query, maxResults: args.maxResults ?? 100, pageToken: args.pageToken }));
    case "list_group_members": return out(await tReq(t, S.groupRead, "GET", `${DIR}/groups/${enc(String(args.groupKey))}/members`, { maxResults: args.maxResults ?? 200, pageToken: args.pageToken }));
    case "add_group_member": return out(await tReq(t, S.group, "POST", `${DIR}/groups/${enc(String(args.groupKey))}/members`, undefined, { email: args.email, role: args.role ?? "MEMBER" }));
    case "remove_group_member":
      await tReq(t, S.group, "DELETE", `${DIR}/groups/${enc(String(args.groupKey))}/members/${enc(String(args.memberKey))}`);
      return `Removed ${args.memberKey} from ${args.groupKey} in ${t.label}.`;

    // Org units & devices
    case "list_org_units": return out(await tReq(t, S.orgunitRead, "GET", `${DIR}/customer/${enc(cust)}/orgunits`, { orgUnitPath: args.orgUnitPath ?? "/", type: "all" }));
    case "list_chromeos_devices": return out(await tReq(t, S.chromeRead, "GET", `${DIR}/customer/${enc(cust)}/devices/chromeos`, { query: args.query, maxResults: args.maxResults ?? 100, pageToken: args.pageToken, projection: "BASIC" }));
    case "list_mobile_devices": return out(await tReq(t, S.mobileRead, "GET", `${DIR}/customer/${enc(cust)}/devices/mobile`, { query: args.query, maxResults: args.maxResults ?? 100, pageToken: args.pageToken, projection: "BASIC" }));

    // Licensing - customerId may be the real ID or the primary domain.
    case "list_license_assignments": {
      const product = enc(String(args.productId ?? "Google-Apps"));
      const path = args.skuId ? `/product/${product}/sku/${enc(String(args.skuId))}/users` : `/product/${product}/users`;
      return out(await tReq(t, S.licensing, "GET", `${LIC}${path}`, { customerId: t.customerId ?? t.domain, maxResults: args.maxResults ?? 100, pageToken: args.pageToken }));
    }

    // Reports & alerts - customerId omitted for standalone tenants with no known ID (defaults to the admin's own customer).
    case "get_login_activity":
    case "get_admin_activity": {
      const app = name === "get_login_activity" ? "login" : "admin";
      return out(await tReq(t, S.audit, "GET", `${RPT}/activity/users/${enc(String(args.userKey ?? "all"))}/applications/${app}`, {
        customerId: t.customerId, eventName: args.eventName, startTime: args.startTime, endTime: args.endTime, maxResults: args.maxResults ?? 50, pageToken: args.pageToken,
      }));
    }
    case "list_alerts": return out(await tReq(t, S.alerts, "GET", `${ALERTS}/alerts`, { customerId: t.customerId, filter: args.filter, pageSize: args.pageSize ?? 50, pageToken: args.pageToken, orderBy: "createTime desc" }));

    // Generic
    case "google_api_get": {
      const apis: Record<string, { base: string; scopes: string[] }> = {
        directory: { base: DIR, scopes: S.userRead }, // overridden below by path
        reports: { base: RPT, scopes: [...S.audit, ...S.usage] },
        licensing: { base: LIC, scopes: S.licensing },
        alertcenter: { base: ALERTS, scopes: S.alerts },
      };
      const a = apis[String(args.api)];
      if (!a) throw new Error("api must be one of directory, reports, licensing, alertcenter.");
      const path = "/" + String(args.path ?? "").replace(/^\//, "").replace(/\{customer\}/g, enc(cust));
      let scopes = a.scopes;
      if (args.api === "directory") {
        // Pick the narrowest read scope for the Directory resource being read.
        const p = path.toLowerCase();
        scopes = p.includes("/groups") ? S.groupRead
          : p.includes("/orgunits") ? S.orgunitRead
          : p.includes("/domains") ? S.domainRead
          : p.includes("/devices/chromeos") ? S.chromeRead
          : p.includes("/devices/mobile") ? S.mobileRead
          : p.includes("/roles") || p.includes("/roleassignments") || p.includes("/privileges") ? S.roleRead
          : /^\/customers\//.test(p) ? S.customerRead
          : /\/(tokens|asps|verificationcodes)/.test(p) ? S.userSecurity
          : S.userRead;
      }
      return out(await tReq(t, scopes, "GET", `${a.base}${path}`, args.params as Args | undefined));
    }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Worker entry point ───────────────────────────────────────────────────────

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

function timingSafeEqual(a: string, b: string): boolean {
  const e = new TextEncoder();
  const x = e.encode(a);
  const y = e.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", configured: Boolean(env.MCP_AUTH_TOKEN && env.GOOGLE_SERVICE_ACCOUNT_JSON), channel: channelConfigured(env), standalone: Boolean(env.GOOGLE_TENANTS) }), { headers: JSON_HEADERS });
    }
    // Fail closed: this Worker reaches every client's Google tenant.
    if (!env.MCP_AUTH_TOKEN || !env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return new Response(JSON.stringify({ error: "gchannel-mcp is not configured: set the MCP_AUTH_TOKEN and GOOGLE_SERVICE_ACCOUNT_JSON secrets." }), { status: 503, headers: JSON_HEADERS });
    }
    const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      let body: unknown;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers: JSON_HEADERS }); }
      const messages = Array.isArray(body) ? body : [body];
      const responses: unknown[] = [];
      for (const msg of messages as Array<{ jsonrpc: string; id?: unknown; method: string; params?: Record<string, unknown> }>) {
        const { id, method, params } = msg;
        if (id === undefined) continue;
        try {
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Google Channel Partner MCP Server", version: "1.0.0" } } });
          else if (method === "tools/list") responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          else if (method === "tools/call") { const text = await runTool(params?.name as string, (params?.arguments ?? {}) as Args, env); responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }); }
          else if (method === "ping") responses.push({ jsonrpc: "2.0", id, result: {} });
          else responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        } catch (err) { responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }); }
      }
      const outBody = responses.length === 0 ? null : responses.length === 1 ? responses[0] : responses;
      if (outBody === null) return new Response(null, { status: 204, headers: CORS });
      return new Response(JSON.stringify(outBody), { headers: JSON_HEADERS });
    }
    return new Response("Google Channel Partner MCP Server - POST /mcp, GET /health", { status: 200, headers: CORS });
  },
};
