/**
 * pax8-mcp
 *
 * MCP tools over the Pax8 Partner REST API (api.pax8.com), plus a read-only
 * raw REST passthrough at /api/pax8/* for the wallboard. One credential for
 * everything: an OAuth2 client-credentials token from api.pax8.com/v1/token.
 *
 * SECRETS (Cloudflare Worker secrets):
 *   PAX8_CLIENT_ID      - API client from app.pax8.com > Partner Portal > Company > API
 *   PAX8_CLIENT_SECRET  - same place
 *   MCP_AUTH_TOKEN      - optional inbound bearer token (repo standing rule)
 *
 * History (2026-11-12): until now /mcp was a relay to Pax8's own hosted MCP
 * server (mcp.pax8.com). The 2026-11-11 token fix (below) broke it, because
 * that server refuses REST API tokens. Roger: this Worker was meant to use the
 * API directly, since the API covers more than Pax8's MCP. The tools now call
 * the REST API themselves. Tool names and argument names match the ones Pax8's
 * MCP used (so mcp-gateway's readTools allowlist and existing prompts keep
 * working); the three that only existed on Pax8's MCP server
 * (get-pax8-help-documents, pax8-semantic-search-product, pax8-get-hitl-result)
 * are gone, and nothing here can order (no pax8-submit-order).
 *
 * Token endpoint (2026-11-11): Pax8 flagged this integration for minting
 * ~770 tokens/day from login.pax8.com/oauth/token, one per cold Worker
 * isolate. api.pax8.com/v1/token is the documented endpoint
 * (devx.pax8.com/docs/authentication); it caches server-side and returns the
 * same token to every caller until near its 24h expiry. Never go back to
 * login.pax8.com.
 *
 * Endpoints: devx.pax8.com/reference (read 2026-11-12). /v1 for companies,
 * contacts, products, subscriptions, usage, orders, invoices; /v2 for quotes
 * and the invoice line-item finance report. Lists are 0-based `page` + `size`
 * (max 200) except quotes, which use `limit`.
 */

const PAX8_API = "https://api.pax8.com";
const PAX8_TOKEN_URL = "https://api.pax8.com/v1/token";
const PAX8_AUDIENCE = "https://api.pax8.com";
const MAX_CHARS = 60000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
};
const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

// ─── Auth ────────────────────────────────────────────────────────────────────

let cachedToken = { token: null, expires: 0 };
let tokenInFlight = null;

async function getToken(env, force = false) {
  if (!force && cachedToken.token && cachedToken.expires > Date.now()) return cachedToken.token;
  if (tokenInFlight) return tokenInFlight;
  if (!env.PAX8_CLIENT_ID || !env.PAX8_CLIENT_SECRET) {
    throw new Error("PAX8_CLIENT_ID and PAX8_CLIENT_SECRET secrets are required");
  }
  tokenInFlight = (async () => {
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
    if (!res.ok) throw new Error(`Pax8 auth failed (${res.status}) at ${PAX8_TOKEN_URL}: ${(await res.text()).substring(0, 300)}`);
    const data = await res.json();
    cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
    return data.access_token;
  })();
  try {
    return await tokenInFlight;
  } finally {
    tokenInFlight = null;
  }
}

// GET a Pax8 API path ("/v1/..." or "/v2/..."). Never swallows errors: a
// failure throws the real status and response body (repo convention).
async function pax8Get(env, path, params) {
  const url = new URL(PAX8_API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  const send = (token) => fetch(url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  let res = await send(await getToken(env));
  // Token revoked or expired early: get a fresh one once and retry once.
  if (res.status === 401) res = await send(await getToken(env, true));
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url.pathname}${url.search} failed (${res.status}): ${text.substring(0, 500)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// ─── Argument helpers ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pick(args, ...names) {
  for (const n of names) if (args[n] !== undefined && args[n] !== null && args[n] !== "") return args[n];
  return undefined;
}

function required(args, label, ...names) {
  const v = pick(args, ...names);
  if (v === undefined) throw new Error(`${label} is required`);
  return String(v);
}

function seg(v) {
  return encodeURIComponent(String(v));
}

// page/size, also accepting offset/max (the argument names Pax8's MCP used
// on pax8-search-invoice-line-items).
function paging(args, defSize = 10) {
  const size = Math.min(Math.max(Number(pick(args, "size", "max") ?? defSize) || defSize, 1), 200);
  let page = Number(pick(args, "page") ?? 0) || 0;
  const offset = pick(args, "offset");
  if (offset !== undefined && pick(args, "page") === undefined) page = Math.floor(Number(offset) / size) || 0;
  return { page, size };
}

// "active" -> "Active", "nothing due" -> "Nothing Due"
function titleCase(v) {
  return v === undefined ? undefined : String(v).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const BILLING_TERMS = { monthly: "Monthly", annual: "Annual", "two-year": "2-Year", "2-year": "2-Year", "three-year": "3-Year", "3-year": "3-Year", "one-time": "One-Time", trial: "Trial", activation: "Activation" };
function billingTerm(v) {
  return v === undefined ? undefined : BILLING_TERMS[String(v).toLowerCase()] || String(v);
}

// Every company, cached for 5 minutes per isolate (49 companies on
// 2026-11-12: one call at size 200, paged in case that grows).
let companyCache = { at: 0, list: null };
async function allCompanies(env) {
  if (companyCache.list && Date.now() - companyCache.at < 300000) return companyCache.list;
  const list = [];
  for (let page = 0; page < 20; page++) {
    const r = await pax8Get(env, "/v1/companies", { page, size: 200 });
    list.push(...(r.content || []));
    if (!r.page || page + 1 >= r.page.totalPages) break;
  }
  companyCache = { at: Date.now(), list };
  return list;
}

function matchCompanies(list, name) {
  const q = String(name).trim().toLowerCase();
  const exact = list.filter((c) => (c.name || "").toLowerCase() === q);
  return exact.length ? exact : list.filter((c) => (c.name || "").toLowerCase().includes(q));
}

// companyId may be a UUID or a company name.
async function companyIdArg(env, args) {
  const v = pick(args, "companyId", "clientId", "company_id", "company");
  if (v === undefined) return undefined;
  if (UUID_RE.test(String(v))) return String(v);
  const hits = matchCompanies(await allCompanies(env), v);
  if (hits.length === 1) return hits[0].id;
  if (hits.length === 0) throw new Error(`No Pax8 company matches "${v}". Use pax8-list-companies to find it.`);
  throw new Error(`"${v}" matches ${hits.length} companies: ${hits.slice(0, 15).map((c) => `${c.name} (${c.id})`).join("; ")}. Pass the companyId.`);
}

function out(data) {
  const s = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return s.length > MAX_CHARS ? s.substring(0, MAX_CHARS) + `\n... [truncated at ${MAX_CHARS} of ${s.length} chars; ask for a smaller page]` : s;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const PAGE = { type: "number", description: "Page number, first page is 0" };
const SIZE = { type: "number", description: "Items per page (default 10, max 200)" };
const COMPANY = { type: "string", description: "Company (client) UUID, or the company's name" };

const TOOLS = [
  {
    name: "pax8-list-companies",
    description: "List Pax8 companies (clients) with their UUIDs. Filter by company_name (case-insensitive, partial match), status, city/country/state. Use the UUID as companyId in other pax8 tools.",
    inputSchema: { type: "object", properties: {
      company_name: { type: "string", description: "Part of the company name" },
      status: { type: "string", enum: ["active", "inactive", "deleted"] },
      city: { type: "string" }, country: { type: "string" }, stateOrProvince: { type: "string" },
      sort: { type: "string", enum: ["name", "city", "country", "stateOrProvince", "postalCode"] },
      order: { type: "string", enum: ["asc", "desc"] },
      page: PAGE, size: SIZE,
    } },
  },
  {
    name: "pax8-get-company-by-uuid",
    description: "Get one Pax8 company by UUID (or name), optionally with its contacts.",
    inputSchema: { type: "object", properties: { companyId: COMPANY, include_contacts: { type: "boolean", description: "Also return the company's contacts" } }, required: ["companyId"] },
  },
  {
    name: "pax8-list-company-contacts",
    description: "List a Pax8 company's contacts (name, email, phone, Admin/Billing/Technical roles).",
    inputSchema: { type: "object", properties: { companyId: COMPANY, page: PAGE, size: SIZE }, required: ["companyId"] },
  },
  {
    name: "pax8-list-products",
    description: "List/search the Pax8 product catalog. search matches name, vendor, SKU or ID.",
    inputSchema: { type: "object", properties: {
      search: { type: "string" }, vendorName: { type: "string" },
      sort: { type: "string", enum: ["name,asc", "name,desc", "vendor,asc", "vendor,desc"] },
      page: PAGE, size: SIZE,
    } },
  },
  {
    name: "pax8-lookup-product",
    description: "Look up products by UUID, SKU, product name and/or vendor (catalog search; there is no semantic search).",
    inputSchema: { type: "object", properties: {
      uuid: { type: "string", description: "Product UUID (returns that product)" },
      sku: { type: "string" }, productName: { type: "string" }, vendor: { type: "string" },
      page: PAGE, size: SIZE,
    } },
  },
  {
    name: "pax8-get-product-by-uuid",
    description: "Get one Pax8 product (with description) by its UUID.",
    inputSchema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
  },
  {
    name: "pax8-get-product-ordering-requirements",
    description: "What ordering a product needs: provisioning details (fields to fill in) and dependencies (commitment terms, required products).",
    inputSchema: { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] },
  },
  {
    name: "pax8-get-product-pricing-by-uuid",
    description: "Pricing for a product by billing/commitment term (partner buy rate, suggested retail). Pass companyId for that company's pricing.",
    inputSchema: { type: "object", properties: { productId: { type: "string" }, companyId: COMPANY }, required: ["productId"] },
  },
  {
    name: "pax8-list-subscriptions",
    description: "List subscriptions, filtered by company, product, status (default Active) and billing term. One row per subscription lineage (id = original id; currentSubscriptionId = active record).",
    inputSchema: { type: "object", properties: {
      companyId: COMPANY, productId: { type: "string" },
      status: { type: "string", enum: ["Active", "Cancelled", "PendingManual", "PendingAutomated", "PendingCancel", "WaitingForDetails", "Trial", "Converted", "PendingActivation", "Activated", "All"], description: "Default Active; All = no status filter" },
      billingTerm: { type: "string", enum: ["monthly", "annual", "two-year", "three-year", "one-time", "trial", "activation"] },
      sort: { type: "string", enum: ["quantity,asc", "quantity,desc", "startDate,asc", "startDate,desc", "endDate,asc", "endDate,desc", "createdDate,asc", "createdDate,desc", "billingStart,asc", "billingStart,desc", "price,asc", "price,desc"] },
      page: PAGE, size: SIZE,
    } },
  },
  {
    name: "pax8-get-subscription-by-uuid",
    description: "Get one subscription (any id in its lineage), optionally with its change history.",
    inputSchema: { type: "object", properties: { subscriptionId: { type: "string" }, include_history: { type: "boolean", description: "Also return the subscription's history (quantity/term changes)" } }, required: ["subscriptionId"] },
  },
  {
    name: "pax8-list-orders",
    description: "List Pax8 orders with their line items, optionally for one company. Scheduled (future-dated) orders are not included.",
    inputSchema: { type: "object", properties: { companyId: COMPANY, page: PAGE, size: SIZE } },
  },
  {
    name: "pax8-get-order-by-uuid",
    description: "Get one Pax8 order with its line items.",
    inputSchema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  {
    name: "pax8-list-quotes",
    description: "List Pax8 quotes. search matches quote ID, client name or amount; status filters (comma-separated allowed).",
    inputSchema: { type: "object", properties: {
      search: { type: "string" },
      status: { type: "string", description: "draft, assigned, sent, closed, declined, accepted, changes_requested, expired, pending (comma-separated for several)" },
      sort: { type: "string", enum: ["id,asc", "id,desc", "status,asc", "status,desc", "createdBy,asc", "createdBy,desc", "createdOn,asc", "createdOn,desc", "updatedOn,asc", "updatedOn,desc", "totals.initialTotal,asc", "totals.initialTotal,desc", "totals.recurringTotal,asc", "totals.recurringTotal,desc", "client.name,asc", "client.name,desc"] },
      account: { type: "string", enum: ["user", "partner"], description: "user = quotes of the API user (Pax8 default), partner = every quote of the partner" },
      page: PAGE, limit: { type: "number", description: "Quotes per page (default 10)" },
    } },
  },
  {
    name: "pax8-get-quote-by-uuid",
    description: "Get one Pax8 quote (client, line items, totals, status, expiry), optionally with its sections.",
    inputSchema: { type: "object", properties: { quoteId: { type: "string" }, include_sections: { type: "boolean" } }, required: ["quoteId"] },
  },
  {
    name: "pax8-list-invoices",
    description: "List Pax8 invoices (partner bills). Filter by company, status, invoice date or date range, due date, amounts.",
    inputSchema: { type: "object", properties: {
      companyId: COMPANY,
      status: { type: "string", enum: ["unpaid", "paid", "void", "carried", "nothing due", "credited"] },
      invoiceDate: { type: "string", description: "yyyy-MM-dd" },
      invoiceDateRangeStart: { type: "string", description: "yyyy-MM-dd" },
      invoiceDateRangeEnd: { type: "string", description: "yyyy-MM-dd" },
      dueDate: { type: "string", description: "yyyy-MM-dd" },
      total: { type: "number" }, balance: { type: "number" }, carriedBalance: { type: "number" },
      sort: { type: "string", enum: ["invoiceDate,asc", "invoiceDate,desc", "dueDate,asc", "dueDate,desc", "status,asc", "status,desc", "partnerName,asc", "partnerName,desc", "total,asc", "total,desc", "balance,asc", "balance,desc", "carriedBalance,asc", "carriedBalance,desc"] },
      page: PAGE, size: SIZE,
    } },
  },
  {
    name: "pax8-get-invoice-by-uuid",
    description: "Get one Pax8 invoice, optionally with a page of its line items (per client, product, subscription).",
    inputSchema: { type: "object", properties: {
      invoiceId: { type: "string" },
      include_items: { type: "boolean", description: "Also return line items" },
      page: { type: "number", description: "Line item page (0-based)" }, size: { type: "number", description: "Line items per page (default 50, max 200)" },
    }, required: ["invoiceId"] },
  },
  {
    name: "pax8-list-draft-invoice-items",
    description: "Charges on the upcoming (draft) invoice: next month by default (monthOffset 1) or the current month (0). Usage billed in arrears is not included.",
    inputSchema: { type: "object", properties: { companyId: COMPANY, monthOffset: { type: "number", enum: [0, 1] }, page: PAGE, size: SIZE } },
  },
  {
    name: "pax8-search-invoice-line-items",
    description: "Search invoice line items across invoices (Pax8 finance report): per client, vendor, product, charge type. Needs invoiceDate (yyyy-MM month or yyyy-MM-dd; line items are usually dated the 1st), or invoiceDateRangeStart+End, or invoiceNumber. Data from 2025-02 onward.",
    inputSchema: { type: "object", properties: {
      invoiceDate: { type: "string", description: "yyyy-MM or yyyy-MM-dd" },
      invoiceDateRangeStart: { type: "string" }, invoiceDateRangeEnd: { type: "string" },
      invoiceNumber: { type: "string" },
      q: { type: "string", description: "Free-text search" },
      vendorName: { type: "string" }, vendorId: { type: "string" },
      clientName: { type: "string" }, clientId: { type: "string" },
      productName: { type: "string" }, productId: { type: "string" },
      chargeType: { type: "string" }, term: { type: "string" }, purchaseOrderNumber: { type: "string" },
      facetField: { type: "array", items: { type: "string", enum: ["vendor", "product", "client", "partner", "charge_type", "billing_term", "invoice", "purchase_order_number", "row_type"] }, description: "Return totals grouped by these fields" },
      sort: { type: "string", description: "e.g. invoiceDate,desc" },
      page: PAGE, size: SIZE,
    } },
  },
  {
    name: "pax8-get-usage-summary",
    description: "Usage summaries (charges per resource group) for a usage-based subscription (e.g. Azure). Pass an item's id as usageSummaryId to pax8-get-detailed-usage-summary.",
    inputSchema: { type: "object", properties: {
      subscriptionId: { type: "string" }, companyId: COMPANY, resourceGroup: { type: "string" },
      sort: { type: "string", enum: ["resourceGroup,asc", "resourceGroup,desc"] },
      page: PAGE, size: SIZE,
    }, required: ["subscriptionId"] },
  },
  {
    name: "pax8-get-detailed-usage-summary",
    description: "Usage line items for one usage summary on one day (usageDate yyyy-MM-dd; call once per day).",
    inputSchema: { type: "object", properties: {
      usageSummaryId: { type: "string" }, usageDate: { type: "string", description: "yyyy-MM-dd" }, productId: { type: "string" },
      page: PAGE, size: SIZE,
    }, required: ["usageSummaryId", "usageDate"] },
  },
  {
    name: "pax8_api_get",
    description: "Read-only escape hatch: GET any Pax8 Partner API path, e.g. /companies/{id}/contacts or /v2/quotes/{id}/access-list. A path without /v1 or /v2 is under /v1. Query params as an object. 60K character cap.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, params: { type: "object" } }, required: ["path"] },
  },
];

async function runTool(name, args, env) {
  args = args || {};
  switch (name) {
    case "pax8-list-companies": {
      const { page, size } = paging(args);
      const status = titleCase(pick(args, "status"));
      const sortField = pick(args, "sort");
      const sort = sortField ? `${String(sortField).split(",")[0]},${pick(args, "order") || String(sortField).split(",")[1] || "asc"}` : undefined;
      const nameQ = pick(args, "company_name", "name", "search");
      if (nameQ === undefined) {
        return out(await pax8Get(env, "/v1/companies", { page, size, sort, status, city: args.city, country: args.country, stateOrProvince: args.stateOrProvince }));
      }
      // Pax8's /companies has no name search: filter the full list here.
      let hits = matchCompanies(await allCompanies(env), nameQ);
      if (status) hits = hits.filter((c) => c.status === status);
      for (const k of ["city", "country", "stateOrProvince"]) if (args[k]) hits = hits.filter((c) => (c.address?.[k] || "").toLowerCase() === String(args[k]).toLowerCase());
      return out({ content: hits.slice(page * size, page * size + size), page: { size, totalElements: hits.length, totalPages: Math.ceil(hits.length / size), number: page } });
    }
    case "pax8-get-company-by-uuid": {
      const id = await companyIdArg(env, { companyId: required(args, "companyId", "companyId", "uuid", "id", "company_name") });
      const company = await pax8Get(env, `/v1/companies/${seg(id)}`);
      if (!args.include_contacts) return out(company);
      return out({ ...company, contacts: (await pax8Get(env, `/v1/companies/${seg(id)}/contacts`, { size: 200 })).content });
    }
    case "pax8-list-company-contacts": {
      const id = await companyIdArg(env, args);
      if (!id) throw new Error("companyId is required");
      return out(await pax8Get(env, `/v1/companies/${seg(id)}/contacts`, paging(args)));
    }

    case "pax8-list-products":
      return out(await pax8Get(env, "/v1/products", { ...paging(args), search: pick(args, "search", "productName"), vendorName: pick(args, "vendorName", "vendor"), sort: args.sort }));
    case "pax8-lookup-product": {
      const uuid = pick(args, "uuid", "productId");
      if (uuid) return out(await pax8Get(env, `/v1/products/${seg(uuid)}`));
      const search = pick(args, "sku", "productName", "search");
      const vendorName = pick(args, "vendor", "vendorName");
      if (!search && !vendorName) throw new Error("Pass uuid, sku, productName or vendor");
      return out(await pax8Get(env, "/v1/products", { ...paging(args), search, vendorName }));
    }
    case "pax8-get-product-by-uuid":
      return out(await pax8Get(env, `/v1/products/${seg(required(args, "productId", "productId", "uuid", "id"))}`));
    case "pax8-get-product-ordering-requirements": {
      const id = seg(required(args, "productId", "productId", "uuid", "id"));
      const [provision, dependencies] = await Promise.all([
        pax8Get(env, `/v1/products/${id}/provision-details`),
        pax8Get(env, `/v1/products/${id}/dependencies`),
      ]);
      return out({ provisionDetails: provision?.content ?? provision, dependencies });
    }
    case "pax8-get-product-pricing-by-uuid": {
      const id = seg(required(args, "productId", "productId", "uuid", "id"));
      return out(await pax8Get(env, `/v1/products/${id}/pricing`, { companyId: await companyIdArg(env, args) }));
    }

    case "pax8-list-subscriptions": {
      let status = pick(args, "status") ?? "Active";
      if (String(status).toLowerCase() === "all") status = undefined;
      return out(await pax8Get(env, "/v1/subscriptions", {
        ...paging(args), sort: args.sort, status, billingTerm: billingTerm(pick(args, "billingTerm")),
        companyId: await companyIdArg(env, args), productId: pick(args, "productId"),
      }));
    }
    case "pax8-get-subscription-by-uuid": {
      const id = required(args, "subscriptionId", "subscriptionId", "uuid", "id");
      const sub = await pax8Get(env, `/v1/subscriptions/${seg(id)}`);
      if (!args.include_history) return out(sub);
      // History is keyed by the ORIGINAL id, which is the subscription's own id.
      const history = await pax8Get(env, `/v1/subscriptions/${seg(sub.id || id)}/history`);
      return out({ ...sub, history: history?.content ?? history });
    }

    case "pax8-list-orders":
      return out(await pax8Get(env, "/v1/orders", { ...paging(args), companyId: await companyIdArg(env, args) }));
    case "pax8-get-order-by-uuid":
      return out(await pax8Get(env, `/v1/orders/${seg(required(args, "orderId", "orderId", "uuid", "id"))}`));

    case "pax8-list-quotes": {
      const limit = Math.min(Math.max(Number(pick(args, "limit", "size") ?? 10) || 10, 1), 200);
      return out(await pax8Get(env, "/v2/quotes", { limit, page: Number(args.page ?? 0) || 0, search: args.search, status: args.status, sort: args.sort, account: args.account }));
    }
    case "pax8-get-quote-by-uuid": {
      const id = seg(required(args, "quoteId", "quoteId", "uuid", "id"));
      const quote = await pax8Get(env, `/v2/quotes/${id}`);
      if (!args.include_sections) return out(quote);
      return out({ ...quote, sections: (await pax8Get(env, `/v2/quotes/${id}/sections`))?.sections });
    }

    case "pax8-list-invoices":
      return out(await pax8Get(env, "/v1/invoices", {
        ...paging(args), sort: args.sort, status: titleCase(pick(args, "status")),
        invoiceDate: args.invoiceDate, invoiceDateRangeStart: args.invoiceDateRangeStart, invoiceDateRangeEnd: args.invoiceDateRangeEnd,
        dueDate: args.dueDate, total: args.total, balance: args.balance, carriedBalance: args.carriedBalance,
        companyId: await companyIdArg(env, args),
      }));
    case "pax8-get-invoice-by-uuid": {
      const id = seg(required(args, "invoiceId", "invoiceId", "uuid", "id"));
      const invoice = await pax8Get(env, `/v1/invoices/${id}`);
      if (!args.include_items) return out(invoice);
      return out({ ...invoice, items: await pax8Get(env, `/v1/invoices/${id}/items`, paging(args, 50)) });
    }
    case "pax8-list-draft-invoice-items":
      return out(await pax8Get(env, "/v1/invoices/draftItems", { ...paging(args), monthOffset: args.monthOffset, companyId: await companyIdArg(env, args) }));
    case "pax8-search-invoice-line-items": {
      if (!args.invoiceDate && !(args.invoiceDateRangeStart && args.invoiceDateRangeEnd) && !args.invoiceNumber && !args.invoiceId) {
        throw new Error("Pass invoiceDate (yyyy-MM or yyyy-MM-dd), invoiceDateRangeStart and invoiceDateRangeEnd, or invoiceNumber");
      }
      const params = { ...paging(args) };
      for (const k of ["invoiceDate", "invoiceDateRangeStart", "invoiceDateRangeEnd", "invoiceNumber", "invoiceId", "q", "vendorName", "vendorId", "clientName", "clientId", "productName", "productId", "chargeType", "term", "purchaseOrderNumber", "sort"]) params[k] = args[k];
      if (args.facetField) params["facet.field"] = Array.isArray(args.facetField) ? args.facetField : [args.facetField];
      return out(await pax8Get(env, "/v2/finance-reports/invoices", params));
    }

    case "pax8-get-usage-summary": {
      const id = seg(required(args, "subscriptionId", "subscriptionId", "uuid", "id"));
      return out(await pax8Get(env, `/v1/subscriptions/${id}/usage-summaries`, { ...paging(args), sort: args.sort, resourceGroup: args.resourceGroup, companyId: await companyIdArg(env, args) }));
    }
    case "pax8-get-detailed-usage-summary": {
      const id = seg(required(args, "usageSummaryId", "usageSummaryId", "uuid", "id"));
      return out(await pax8Get(env, `/v1/usage-summaries/${id}/usage-lines`, { ...paging(args), usageDate: required(args, "usageDate", "usageDate"), productId: args.productId }));
    }

    case "pax8_api_get": {
      let path = required(args, "path", "path");
      if (!path.startsWith("/") || path.includes("..") || path.includes("?")) throw new Error("path must start with '/' and contain no '..' or '?' (put query params in params)");
      if (!/^\/v[12]\//.test(path)) path = "/v1" + path;
      return out(await pax8Get(env, path, args.params || {}));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

    // Inbound auth (opt-in, repo standing rule "option 1", 2026-09-25): once
    // MCP_AUTH_TOKEN is set, every route needs "Authorization: Bearer <token>"
    // except GET/HEAD on /health and the read-only /api/pax8/ passthrough,
    // which the wallboard polls without a token.
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

    // No event stream here (2026-10-26 repo rule): GET/DELETE /mcp answer 405.
    if (url.pathname === "/mcp" && (request.method === "GET" || request.method === "DELETE")) {
      return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST" } });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      return handleMcp(request, env);
    }

    if (url.pathname.startsWith("/api/pax8/")) {
      // Carries the account's full API credentials, so read-only.
      if (!readMethod) {
        return new Response(JSON.stringify({ error: "The REST passthrough is read-only (GET/HEAD)." }), { status: 405, headers: { ...JSON_HEADERS, Allow: "GET, HEAD" } });
      }
      try {
        return await proxyRest(request, env, url);
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: JSON_HEADERS });
      }
    }

    return new Response("pax8-mcp - POST /mcp | GET /health | GET /api/pax8/* (read-only REST passthrough)", { status: 200, headers: CORS_HEADERS });
  },
};

async function handleMcp(request, env) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch (err) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${err.message}` } }), { status: 400, headers: JSON_HEADERS });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const { id, method, params } = msg || {};
    if (id === undefined || id === null) continue; // notification
    try {
      if (method === "initialize") {
        responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "pax8-mcp", version: "2.0.0" } } });
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

  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), { headers: JSON_HEADERS });
}

// ─── Raw REST passthrough for the wallboard (/api/pax8/<path> -> /v1/<path>) ─

async function proxyRest(request, env, url) {
  const target = `${PAX8_API}/v1/${url.pathname.replace("/api/pax8/", "")}${url.search}`;
  const send = (token) => fetch(target, { method: request.method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  let res = await send(await getToken(env));
  if (res.status === 401) res = await send(await getToken(env, true));
  const outHeaders = new Headers(res.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => outHeaders.set(k, v));
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
