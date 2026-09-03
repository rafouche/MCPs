export interface Env {
  MERAKI_API_KEY: string;
  MERAKI_BASE_URL: string;
}

async function merakiGet(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`${env.MERAKI_BASE_URL}/api/v1${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { "X-Cisco-Meraki-API-Key": env.MERAKI_API_KEY, "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function merakiPost(env: Env, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${env.MERAKI_BASE_URL}/api/v1${path}`, {
    method: "POST",
    headers: { "X-Cisco-Meraki-API-Key": env.MERAKI_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function merakiPut(env: Env, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${env.MERAKI_BASE_URL}/api/v1${path}`, {
    method: "PUT",
    headers: { "X-Cisco-Meraki-API-Key": env.MERAKI_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PUT ${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function merakiDelete(env: Env, path: string): Promise<unknown> {
  const res = await fetch(`${env.MERAKI_BASE_URL}/api/v1${path}`, {
    method: "DELETE",
    headers: { "X-Cisco-Meraki-API-Key": env.MERAKI_API_KEY },
  });
  if (!res.ok) throw new Error(`DELETE ${path} failed (${res.status}): ${await res.text()}`);
  return { success: true };
}

const TOOLS = [
  { name: "healthcheck", description: "Test connectivity to Meraki Dashboard API and verify API key", inputSchema: { type: "object", properties: {}, required: [] } },

  // Organizations
  { name: "list_organizations", description: "List all Meraki organizations accessible with this API key", inputSchema: { type: "object", properties: {} } },
  { name: "get_organization", description: "Get details of a single Meraki organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" } }, required: ["org_id"] } },
  { name: "get_org_license_overview", description: "Get license state and expiry summary for an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" } }, required: ["org_id"] } },
  { name: "list_org_admins", description: "List administrators for an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" } }, required: ["org_id"] } },

  // Networks
  { name: "list_networks", description: "List all networks in a Meraki organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, productTypes: { type: "string", description: "Filter by product type: appliance, switch, wireless, camera, cellularGateway" } }, required: ["org_id"] } },
  { name: "get_network", description: "Get details of a single network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },
  { name: "create_network", description: "Create a new network in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, name: { type: "string", description: "Network name" }, productTypes: { type: "array", items: { type: "string" }, description: "Product types: appliance, switch, wireless, camera, cellularGateway" }, timeZone: { type: "string", description: "Timezone e.g. America/Chicago" }, notes: { type: "string", description: "Optional notes" } }, required: ["org_id", "name", "productTypes"] } },
  { name: "update_network", description: "Update network name, timezone, or notes", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, name: { type: "string" }, timeZone: { type: "string" }, notes: { type: "string" } }, required: ["network_id"] } },
  { name: "delete_network", description: "Delete a network (must have no devices)", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },

  // Devices
  { name: "list_org_devices", description: "List all devices across all networks in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, productTypes: { type: "string", description: "Filter: appliance, switch, wireless, camera, cellularGateway" } }, required: ["org_id"] } },
  { name: "list_network_devices", description: "List devices in a specific network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },
  { name: "get_device", description: "Get details of a single device by serial number", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Device serial number e.g. Q234-ABCD-5678" } }, required: ["serial"] } },
  { name: "update_device", description: "Update device name, address, notes, or tags", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Device serial number" }, name: { type: "string" }, address: { type: "string" }, notes: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["serial"] } },
  { name: "get_device_uplink_info", description: "Get uplink (WAN) status and IP info for a device", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Device serial number" } }, required: ["serial"] } },
  { name: "reboot_device", description: "Reboot a Meraki device", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Device serial number" } }, required: ["serial"] } },
  { name: "list_org_device_statuses", description: "Get online/offline status for all devices in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, productTypes: { type: "string", description: "Filter by product type" } }, required: ["org_id"] } },

  // Clients
  { name: "list_network_clients", description: "List clients connected to a network in the last timespan", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, timespan: { type: "number", description: "Timespan in seconds (default 86400 = 24 hours, max 2592000 = 30 days)" }, perPage: { type: "number", description: "Results per page (default 100)" } }, required: ["network_id"] } },
  { name: "get_network_client", description: "Get details for a specific client by client ID or MAC address", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, client_id: { type: "string", description: "Client ID or MAC address" } }, required: ["network_id", "client_id"] } },

  // VLANs (MX Appliance)
  { name: "list_vlans", description: "List VLANs configured on an MX appliance network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID (must be appliance network)" } }, required: ["network_id"] } },
  { name: "get_vlan", description: "Get details of a specific VLAN", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, vlan_id: { type: "string", description: "VLAN ID number" } }, required: ["network_id", "vlan_id"] } },
  { name: "create_vlan", description: "Create a new VLAN on an MX appliance network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, id: { type: "string", description: "VLAN ID (1-4094)" }, name: { type: "string", description: "VLAN name" }, subnet: { type: "string", description: "Subnet e.g. 192.168.10.0/24" }, applianceIp: { type: "string", description: "MX IP on this VLAN e.g. 192.168.10.1" } }, required: ["network_id", "id", "name", "subnet", "applianceIp"] } },
  { name: "update_vlan", description: "Update a VLAN name, subnet, DNS, or DHCP settings", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, vlan_id: { type: "string", description: "VLAN ID" }, name: { type: "string" }, subnet: { type: "string" }, applianceIp: { type: "string" }, dnsNameservers: { type: "string", description: "DNS servers e.g. 8.8.8.8\n8.8.4.4" } }, required: ["network_id", "vlan_id"] } },
  { name: "delete_vlan", description: "Delete a VLAN from an MX appliance network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, vlan_id: { type: "string", description: "VLAN ID" } }, required: ["network_id", "vlan_id"] } },

  // SSIDs (Wireless)
  { name: "list_ssids", description: "List SSIDs configured on a wireless network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID (must be wireless network)" } }, required: ["network_id"] } },
  { name: "get_ssid", description: "Get details of a specific SSID", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, ssid_number: { type: "number", description: "SSID number (0-14)" } }, required: ["network_id", "ssid_number"] } },
  { name: "update_ssid", description: "Update SSID name, password, auth mode, or enabled state", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, ssid_number: { type: "number", description: "SSID number (0-14)" }, name: { type: "string" }, enabled: { type: "boolean" }, psk: { type: "string", description: "WPA password" }, authMode: { type: "string", description: "open, psk, 8021x-radius" } }, required: ["network_id", "ssid_number"] } },

  // Switch Ports
  { name: "list_switch_ports", description: "List all ports on a Meraki switch", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Switch serial number" } }, required: ["serial"] } },
  { name: "get_switch_port", description: "Get configuration of a specific switch port", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Switch serial number" }, port_id: { type: "string", description: "Port ID e.g. 1, 2, 3" } }, required: ["serial", "port_id"] } },
  { name: "update_switch_port", description: "Update switch port VLAN, name, PoE, or enabled state", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Switch serial number" }, port_id: { type: "string", description: "Port ID" }, name: { type: "string" }, enabled: { type: "boolean" }, vlan: { type: "number", description: "Access VLAN ID" }, voiceVlan: { type: "number", description: "Voice VLAN ID" }, poeEnabled: { type: "boolean" }, type: { type: "string", description: "access or trunk" } }, required: ["serial", "port_id"] } },

  // MX Firewall
  { name: "get_mx_l3_firewall_rules", description: "Get MX L3 outbound firewall rules for a network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },
  { name: "update_mx_l3_firewall_rules", description: "Replace all MX L3 outbound firewall rules for a network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, rules: { type: "array", description: "Array of rule objects with comment, policy, protocol, srcPort, srcCidr, destPort, destCidr, syslogEnabled", items: { type: "object" } }, syslogDefaultRule: { type: "boolean" } }, required: ["network_id", "rules"] } },

  // VPN
  { name: "get_org_vpn_statuses", description: "Get AutoVPN status for all MX appliances in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" } }, required: ["org_id"] } },
  { name: "get_network_site_to_site_vpn", description: "Get site-to-site VPN config for an MX network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },

  // Alerts & Events
  { name: "get_network_alerts_settings", description: "Get alert settings for a network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },
  { name: "list_network_events", description: "List events for a network (connectivity, auth, DHCP, etc.)", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, productType: { type: "string", description: "appliance, switch, wireless, camera, cellularGateway" }, includedEventTypes: { type: "string", description: "Comma-separated event types to include" }, perPage: { type: "number", description: "Results per page (default 100)" } }, required: ["network_id"] } },

  // Inventory
  { name: "list_org_inventory", description: "List all devices in org inventory (claimed but not necessarily in a network)", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, used: { type: "boolean", description: "true = assigned to network, false = unassigned" } }, required: ["org_id"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": { const data = await merakiGet(env, "/organizations"); return `Connected OK to ${env.MERAKI_BASE_URL} - ${JSON.stringify(data).substring(0, 100)}`; }

    // Organizations
    case "list_organizations": return JSON.stringify(await merakiGet(env, "/organizations"), null, 2);
    case "get_organization": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}`), null, 2);
    case "get_org_license_overview": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/licensing/coterm/licenses`), null, 2);
    case "list_org_admins": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/admins`), null, 2);

    // Networks
    case "list_networks": { const p: Record<string, string> = {}; if (args.productTypes) p.productTypes = String(args.productTypes); return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/networks`, p), null, 2); }
    case "get_network": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}`), null, 2);
    case "create_network": return JSON.stringify(await merakiPost(env, `/organizations/${args.org_id}/networks`, { name: args.name, productTypes: args.productTypes, timeZone: args.timeZone ?? "America/Chicago", notes: args.notes ?? "" }), null, 2);
    case "update_network": { const body: Record<string, unknown> = {}; if (args.name) body.name = args.name; if (args.timeZone) body.timeZone = args.timeZone; if (args.notes) body.notes = args.notes; return JSON.stringify(await merakiPut(env, `/networks/${args.network_id}`, body), null, 2); }
    case "delete_network": return JSON.stringify(await merakiDelete(env, `/networks/${args.network_id}`), null, 2);

    // Devices
    case "list_org_devices": { const p: Record<string, string> = {}; if (args.productTypes) p.productTypes = String(args.productTypes); return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/devices`, p), null, 2); }
    case "list_network_devices": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/devices`), null, 2);
    case "get_device": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}`), null, 2);
    case "update_device": { const body: Record<string, unknown> = {}; if (args.name) body.name = args.name; if (args.address) body.address = args.address; if (args.notes) body.notes = args.notes; if (args.tags) body.tags = args.tags; return JSON.stringify(await merakiPut(env, `/devices/${args.serial}`, body), null, 2); }
    case "get_device_uplink_info": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/appliance/uplinks/settings`), null, 2);
    case "reboot_device": return JSON.stringify(await merakiPost(env, `/devices/${args.serial}/reboot`), null, 2);
    case "list_org_device_statuses": { const p: Record<string, string> = {}; if (args.productTypes) p.productTypes = String(args.productTypes); return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/devices/statuses`, p), null, 2); }

    // Clients
    case "list_network_clients": { const p: Record<string, string> = { timespan: String(args.timespan ?? 86400), perPage: String(args.perPage ?? 100) }; return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/clients`, p), null, 2); }
    case "get_network_client": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/clients/${args.client_id}`), null, 2);

    // VLANs
    case "list_vlans": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/appliance/vlans`), null, 2);
    case "get_vlan": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/appliance/vlans/${args.vlan_id}`), null, 2);
    case "create_vlan": return JSON.stringify(await merakiPost(env, `/networks/${args.network_id}/appliance/vlans`, { id: args.id, name: args.name, subnet: args.subnet, applianceIp: args.applianceIp }), null, 2);
    case "update_vlan": { const body: Record<string, unknown> = {}; if (args.name) body.name = args.name; if (args.subnet) body.subnet = args.subnet; if (args.applianceIp) body.applianceIp = args.applianceIp; if (args.dnsNameservers) body.dnsNameservers = args.dnsNameservers; return JSON.stringify(await merakiPut(env, `/networks/${args.network_id}/appliance/vlans/${args.vlan_id}`, body), null, 2); }
    case "delete_vlan": return JSON.stringify(await merakiDelete(env, `/networks/${args.network_id}/appliance/vlans/${args.vlan_id}`), null, 2);

    // SSIDs
    case "list_ssids": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/wireless/ssids`), null, 2);
    case "get_ssid": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/wireless/ssids/${args.ssid_number}`), null, 2);
    case "update_ssid": { const body: Record<string, unknown> = {}; if (args.name !== undefined) body.name = args.name; if (args.enabled !== undefined) body.enabled = args.enabled; if (args.psk !== undefined) body.psk = args.psk; if (args.authMode !== undefined) body.authMode = args.authMode; return JSON.stringify(await merakiPut(env, `/networks/${args.network_id}/wireless/ssids/${args.ssid_number}`, body), null, 2); }

    // Switch Ports
    case "list_switch_ports": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/switch/ports`), null, 2);
    case "get_switch_port": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/switch/ports/${args.port_id}`), null, 2);
    case "update_switch_port": { const body: Record<string, unknown> = {}; if (args.name !== undefined) body.name = args.name; if (args.enabled !== undefined) body.enabled = args.enabled; if (args.vlan !== undefined) body.vlan = args.vlan; if (args.voiceVlan !== undefined) body.voiceVlan = args.voiceVlan; if (args.poeEnabled !== undefined) body.poeEnabled = args.poeEnabled; if (args.type !== undefined) body.type = args.type; return JSON.stringify(await merakiPut(env, `/devices/${args.serial}/switch/ports/${args.port_id}`, body), null, 2); }

    // Firewall
    case "get_mx_l3_firewall_rules": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/appliance/firewall/l3FirewallRules`), null, 2);
    case "update_mx_l3_firewall_rules": return JSON.stringify(await merakiPut(env, `/networks/${args.network_id}/appliance/firewall/l3FirewallRules`, { rules: args.rules, syslogDefaultRule: args.syslogDefaultRule ?? false }), null, 2);

    // VPN
    case "get_org_vpn_statuses": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/appliance/vpn/statuses`), null, 2);
    case "get_network_site_to_site_vpn": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/appliance/vpn/siteToSiteVpn`), null, 2);

    // Alerts & Events
    case "get_network_alerts_settings": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/alerts/settings`), null, 2);
    case "list_network_events": { const p: Record<string, string> = { perPage: String(args.perPage ?? 100) }; if (args.productType) p.productType = String(args.productType); if (args.includedEventTypes) p.includedEventTypes = String(args.includedEventTypes); return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/events`, p), null, 2); }

    // Inventory
    case "list_org_inventory": { const p: Record<string, string> = {}; if (args.used !== undefined) p.usedState = args.used ? "used" : "unused"; return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/inventory/devices`, p), null, 2); }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — per-org device health, for the
// wallboard's Network zone (merged there with Ninja firewall data).
//
// Fans out one /devices/statuses call per organization, in PARALLEL —
// confirmed live this was previously a sequential for-loop (one org
// awaited before the next started), which at ~11-15 orgs took 13-25+
// seconds total. That's dangerously close to the dashboard's own 30s
// poll interval, so a slow-but-eventually-successful response could
// race the next poll and produce exactly the "data flickers in and
// out" symptom this was reported as. Org count here is small enough
// that a plain Promise.all is nowhere near Cloudflare's per-invocation
// subrequest cap — no batching/concurrency-limiting needed at this scale.
// ============================================================

async function buildNetworkStatus(env: Env) {
  const orgs: any[] = (await merakiGet(env, "/organizations")) as any[];

  const networks = (await Promise.all(orgs.map(async (org) => {
    try {
      const statuses: any[] = (await merakiGet(env, `/organizations/${org.id}/devices/statuses`)) as any[];
      const offline = statuses.filter((d) => d.status === "offline" || d.status === "alerting");
      return {
        orgName: org.name,
        totalDevices: statuses.length,
        offlineCount: offline.length,
        offlineDevices: offline.map((d) => ({ name: d.name || d.serial, status: d.status })),
      };
    } catch {
      // Skip orgs that error (e.g. no devices/statuses permission) rather than failing the whole response.
      return null;
    }
  }))).filter((n): n is NonNullable<typeof n> => n !== null);

  return { updated: new Date().toISOString(), networks };
}

// ============================================================
// Wallboard /licenses route — org license expiration, for the
// wallboard's Business zone alongside Pax8 renewals.
//
// Reuses the same endpoint your existing get_org_license_overview
// tool calls (/organizations/{id}/licensing/coterm/licenses).
// Meraki's co-term licensing model gives one expirationDate for the
// whole org's license bundle, not per-device — that's confirmed
// against Meraki's own API docs, higher confidence than the CIPP/
// Halo field guesses earlier in this build.
// ============================================================

async function buildLicenseStatus(env: Env) {
  const orgs: any[] = (await merakiGet(env, "/organizations")) as any[];
  const now = Date.now();
  const in60Days = now + 60 * 24 * 3600 * 1000;

  // Same sequential-fan-out issue as buildNetworkStatus above — parallelized
  // for the same reason (this route is polled by the Business zone on the
  // same 30s cadence as /status is by the Network zone).
  const perOrg = await Promise.all(orgs.map(async (org) => {
    try {
      const overview: any = await merakiGet(env, `/organizations/${org.id}/licensing/coterm/licenses`);
      if (overview.expirationDate) {
        const t = new Date(overview.expirationDate).getTime();
        if (t >= now && t < in60Days) { // exclude already-lapsed dates — assumed cancelled/not renewing
          return {
            company: org.name,
            product: "Meraki License",
            renewalDate: new Date(overview.expirationDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
            source: "Meraki",
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }));
  const upcomingRenewals = perOrg.filter((r): r is NonNullable<typeof r> => r !== null);

  return { updated: new Date().toISOString(), upcomingRenewals };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", instance: env.MERAKI_BASE_URL }), { headers: JSON_HEADERS });
    if (url.pathname === "/status") {
      try {
        const status = await buildNetworkStatus(env);
        return new Response(JSON.stringify(status), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
    }
    if (url.pathname === "/licenses") {
      try {
        const status = await buildLicenseStatus(env);
        return new Response(JSON.stringify(status), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: JSON_HEADERS });
      }
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Meraki MCP Server", version: "1.0.0" } } });
          else if (method === "tools/list") responses.push({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          else if (method === "tools/call") { const text = await runTool(params?.name as string, (params?.arguments ?? {}) as Record<string, unknown>, env); responses.push({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } }); }
          else if (method === "ping") responses.push({ jsonrpc: "2.0", id, result: {} });
          else responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        } catch (err) { responses.push({ jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message } }); }
      }
      const out = responses.length === 0 ? null : responses.length === 1 ? responses[0] : responses;
      if (out === null) return new Response(null, { status: 204, headers: CORS });
      return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
    }
    return new Response("Meraki MCP Server - POST /mcp, GET /status, GET /licenses, GET /health", { status: 200, headers: CORS });
  },
};
