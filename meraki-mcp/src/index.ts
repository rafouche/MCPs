export interface Env {
  MCP_AUTH_TOKEN?: string; // optional inbound bearer token - see the check at the top of fetch()
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  { name: "run_throughput_test", description: "Run a live WAN throughput (speed) test on an MX appliance and wait for the result - for troubleshooting a client's 'internet is slow' complaint at the firewall level. Confirmed against Meraki's official Live Tools API: POST /devices/{serial}/liveTools/throughputTest queues an async job (the test itself runs ~10s device-side), then this tool polls the job's own status URL every 5 seconds until status is 'complete' or 'failed', or maxWaitSeconds elapses. Meraki rate-limits this endpoint to one request per 5 seconds per device - the poll interval already respects that, don't call this again for the same device sooner than that if you retry. Returns the full job object once complete (status/result/error) - result.speeds.downstream is the download figure in Mbps, per Meraki's schema. Only works on MX/Z-series appliances with Live Tools support, not switches or APs - use list_org_devices/get_device to confirm the model first if unsure.", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Device serial number (must be an MX/Z-series appliance)" }, maxWaitSeconds: { type: "number", description: "How long to poll before giving up and returning the job's last-seen status instead of a completed result (default 45, capped at 90 - the test itself only takes ~10s, this is mostly buffer for queueing/scheduling delay)." } }, required: ["serial"] } },
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

  // Camera - device settings
  { name: "get_camera_video_settings", description: "Get video/RTSP settings for a Meraki camera (external RTSP enabled, RTSP URL)", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "update_camera_video_settings", description: "Update video/RTSP settings for a Meraki camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, externalRtspEnabled: { type: "boolean", description: "Enable external RTSP streaming" } }, required: ["serial"] } },
  { name: "get_camera_quality_retention", description: "Get quality and retention settings for a Meraki camera (resolution, motion-based retention, quality profile)", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "update_camera_quality_retention", description: "Update quality and retention settings for a Meraki camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, profileId: { type: "string", description: "Quality/retention profile ID to assign" }, motionBasedRetentionEnabled: { type: "boolean" }, resolution: { type: "string", description: "e.g. 1280x720, 1920x1080" }, motionDetectorVersion: { type: "number", description: "1 or 2" } }, required: ["serial"] } },
  { name: "get_camera_sense", description: "Get MV Sense (people/vehicle detection) settings for a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "update_camera_sense", description: "Update MV Sense settings for a camera (enable detection, set webhook, audio detection)", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, senseEnabled: { type: "boolean" }, mqttBrokerId: { type: "string" }, audioDetection: { type: "object", description: "e.g. { enabled: true }" } }, required: ["serial"] } },
  { name: "get_camera_sense_object_detection_models", description: "List MV Sense object detection models available on a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "get_camera_wireless_profiles", description: "Get wireless profile assignment for a wireless-capable camera (MV2)", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "update_camera_wireless_profiles", description: "Assign wireless profiles (identity/remote) to a wireless-capable camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, ids: { type: "object", description: "e.g. { identity: { id: \"...\" } }" } }, required: ["serial", "ids"] } },
  { name: "get_camera_custom_analytics", description: "Get custom analytics (third-party workload) settings for a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "update_camera_custom_analytics", description: "Update custom analytics settings for a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, enabled: { type: "boolean" }, artifactId: { type: "string" }, parameters: { type: "array", items: { type: "object" } } }, required: ["serial"] } },

  // Camera - live/snapshot/analytics
  { name: "generate_camera_snapshot", description: "Generate a still-image snapshot from a camera at a given (or current) timestamp - returns a URL to the image", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, timestamp: { type: "string", description: "ISO 8601 timestamp; omit for current snapshot" }, fullframe: { type: "boolean", description: "Request full sensor frame rather than dewarped view" } }, required: ["serial"] } },
  { name: "get_camera_video_link", description: "Get a live/embeddable video link for a camera, optionally at a given timestamp", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, timestamp: { type: "string", description: "ISO 8601 timestamp for historical video; omit for live" } }, required: ["serial"] } },
  { name: "get_camera_analytics_live", description: "Get live-state MV Sense analytics (current zone occupancy) for a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "get_camera_analytics_overview", description: "Get MV Sense analytics overview (object counts over a timespan) for a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, timespan: { type: "number", description: "Timespan in seconds" }, objectType: { type: "string", description: "person or vehicle" } }, required: ["serial"] } },
  { name: "get_camera_analytics_recent", description: "Get recent MV Sense analytics detection events for a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, objectType: { type: "string", description: "person or vehicle" } }, required: ["serial"] } },
  { name: "list_camera_analytics_zones", description: "List MV Sense analytics zones configured on a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" } }, required: ["serial"] } },
  { name: "get_camera_analytics_zone_history", description: "Get historical MV Sense analytics data for a specific zone on a camera", inputSchema: { type: "object", properties: { serial: { type: "string", description: "Camera serial number" }, zone_id: { type: "string", description: "Analytics zone ID" }, timespan: { type: "number", description: "Timespan in seconds" }, resolution: { type: "number", description: "Data resolution in seconds" }, objectType: { type: "string", description: "person or vehicle" } }, required: ["serial", "zone_id"] } },

  // Camera - network-level
  { name: "list_camera_schedules", description: "List recording schedules available for cameras in a network", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID (camera network)" } }, required: ["network_id"] } },
  { name: "list_network_camera_wireless_profiles", description: "List network-wide wireless profiles for cameras", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },
  { name: "get_network_camera_wireless_profile", description: "Get a single network camera wireless profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, profile_id: { type: "string", description: "Wireless profile ID" } }, required: ["network_id", "profile_id"] } },
  { name: "create_network_camera_wireless_profile", description: "Create a network camera wireless profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, name: { type: "string" }, ssid: { type: "object", description: "e.g. { name, authMode, encryptionMode, psk, ... }" } }, required: ["network_id", "name"] } },
  { name: "update_network_camera_wireless_profile", description: "Update a network camera wireless profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, profile_id: { type: "string", description: "Wireless profile ID" }, name: { type: "string" }, ssid: { type: "object" } }, required: ["network_id", "profile_id"] } },
  { name: "delete_network_camera_wireless_profile", description: "Delete a network camera wireless profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, profile_id: { type: "string", description: "Wireless profile ID" } }, required: ["network_id", "profile_id"] } },
  { name: "list_network_camera_quality_retention_profiles", description: "List network-wide camera quality and retention profiles", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" } }, required: ["network_id"] } },
  { name: "get_network_camera_quality_retention_profile", description: "Get a single network camera quality and retention profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, profile_id: { type: "string", description: "Quality/retention profile ID" } }, required: ["network_id", "profile_id"] } },
  { name: "create_network_camera_quality_retention_profile", description: "Create a network camera quality and retention profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, name: { type: "string" }, motionBasedRetentionEnabled: { type: "boolean" }, resolution: { type: "string" } }, required: ["network_id", "name"] } },
  { name: "update_network_camera_quality_retention_profile", description: "Update a network camera quality and retention profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, profile_id: { type: "string", description: "Quality/retention profile ID" }, name: { type: "string" }, motionBasedRetentionEnabled: { type: "boolean" }, resolution: { type: "string" } }, required: ["network_id", "profile_id"] } },
  { name: "delete_network_camera_quality_retention_profile", description: "Delete a network camera quality and retention profile", inputSchema: { type: "object", properties: { network_id: { type: "string", description: "Network ID" }, profile_id: { type: "string", description: "Quality/retention profile ID" } }, required: ["network_id", "profile_id"] } },

  // Camera - organization-level
  { name: "get_org_camera_onboarding_statuses", description: "Get onboarding status (e.g. cloud/local storage migration) for cameras in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, serials: { type: "array", items: { type: "string" }, description: "Optional list of camera serials to filter" }, networkIds: { type: "array", items: { type: "string" } } }, required: ["org_id"] } },
  { name: "list_org_camera_permissions", description: "List camera role-based permission scopes for an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" } }, required: ["org_id"] } },
  { name: "get_org_camera_permission", description: "Get a single camera permission scope", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, permission_id: { type: "string", description: "Permission scope ID" } }, required: ["org_id", "permission_id"] } },
  { name: "list_org_camera_roles", description: "List camera roles defined in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" } }, required: ["org_id"] } },
  { name: "get_org_camera_role", description: "Get a single camera role", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, role_id: { type: "string", description: "Role ID" } }, required: ["org_id", "role_id"] } },
  { name: "get_org_camera_boundaries_areas_by_device", description: "Get MV Sense area-boundary configuration for all cameras in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, serials: { type: "array", items: { type: "string" } }, networkIds: { type: "array", items: { type: "string" } } }, required: ["org_id"] } },
  { name: "get_org_camera_boundaries_lines_by_device", description: "Get MV Sense line-crossing boundary configuration for all cameras in an organization", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, serials: { type: "array", items: { type: "string" } }, networkIds: { type: "array", items: { type: "string" } } }, required: ["org_id"] } },
  { name: "get_org_camera_detections_history", description: "Get historical MV Sense detection counts across an organization, bucketed by boundary and time interval", inputSchema: { type: "object", properties: { org_id: { type: "string", description: "Organization ID" }, ranges: { type: "array", items: { type: "object" }, description: "Required array of { startTime, endTime, interval } range objects per Meraki's API" } }, required: ["org_id", "ranges"] } },
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
    case "run_throughput_test": {
      const job = await merakiPost(env, `/devices/${args.serial}/liveTools/throughputTest`, {}) as any;
      const maxWaitMs = Math.min(Number(args.maxWaitSeconds ?? 45), 90) * 1000;
      const deadline = Date.now() + maxWaitMs;
      // job.url is the documented way to poll ("GET this url to check the
      // status of your throughput test request") - it's already a full,
      // absolute URL per Meraki's own API docs, so this polls it directly
      // rather than re-deriving a path through merakiGet's own base-URL
      // prefixing.
      let latest = job;
      while (latest.status !== "complete" && latest.status !== "failed" && Date.now() < deadline) {
        await sleep(5000);
        const res = await fetch(job.url, { headers: { "X-Cisco-Meraki-API-Key": env.MERAKI_API_KEY, "Content-Type": "application/json" } });
        if (!res.ok) throw new Error(`GET throughput test status failed (${res.status}): ${await res.text()}`);
        latest = await res.json();
      }
      return JSON.stringify(latest, null, 2);
    }
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

    // Camera - device settings
    case "get_camera_video_settings": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/video/settings`), null, 2);
    case "update_camera_video_settings": { const body: Record<string, unknown> = {}; if (args.externalRtspEnabled !== undefined) body.externalRtspEnabled = args.externalRtspEnabled; return JSON.stringify(await merakiPut(env, `/devices/${args.serial}/camera/video/settings`, body), null, 2); }
    case "get_camera_quality_retention": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/qualityAndRetentionSettings`), null, 2);
    case "update_camera_quality_retention": { const body: Record<string, unknown> = {}; if (args.profileId !== undefined) body.profileId = args.profileId; if (args.motionBasedRetentionEnabled !== undefined) body.motionBasedRetentionEnabled = args.motionBasedRetentionEnabled; if (args.resolution !== undefined) body.resolution = args.resolution; if (args.motionDetectorVersion !== undefined) body.motionDetectorVersion = args.motionDetectorVersion; return JSON.stringify(await merakiPut(env, `/devices/${args.serial}/camera/qualityAndRetentionSettings`, body), null, 2); }
    case "get_camera_sense": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/sense`), null, 2);
    case "update_camera_sense": { const body: Record<string, unknown> = {}; if (args.senseEnabled !== undefined) body.senseEnabled = args.senseEnabled; if (args.mqttBrokerId !== undefined) body.mqttBrokerId = args.mqttBrokerId; if (args.audioDetection !== undefined) body.audioDetection = args.audioDetection; return JSON.stringify(await merakiPut(env, `/devices/${args.serial}/camera/sense`, body), null, 2); }
    case "get_camera_sense_object_detection_models": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/sense/objectDetectionModels`), null, 2);
    case "get_camera_wireless_profiles": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/wirelessProfiles`), null, 2);
    case "update_camera_wireless_profiles": return JSON.stringify(await merakiPut(env, `/devices/${args.serial}/camera/wirelessProfiles`, { ids: args.ids }), null, 2);
    case "get_camera_custom_analytics": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/customAnalytics`), null, 2);
    case "update_camera_custom_analytics": { const body: Record<string, unknown> = {}; if (args.enabled !== undefined) body.enabled = args.enabled; if (args.artifactId !== undefined) body.artifactId = args.artifactId; if (args.parameters !== undefined) body.parameters = args.parameters; return JSON.stringify(await merakiPut(env, `/devices/${args.serial}/camera/customAnalytics`, body), null, 2); }

    // Camera - live/snapshot/analytics
    case "generate_camera_snapshot": { const body: Record<string, unknown> = {}; if (args.timestamp !== undefined) body.timestamp = args.timestamp; if (args.fullframe !== undefined) body.fullframe = args.fullframe; return JSON.stringify(await merakiPost(env, `/devices/${args.serial}/camera/generateSnapshot`, body), null, 2); }
    case "get_camera_video_link": { const p: Record<string, string> = {}; if (args.timestamp) p.timestamp = String(args.timestamp); return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/videoLink`, p), null, 2); }
    case "get_camera_analytics_live": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/analytics/live`), null, 2);
    case "get_camera_analytics_overview": { const p: Record<string, string> = {}; if (args.timespan !== undefined) p.timespan = String(args.timespan); if (args.objectType) p.objectType = String(args.objectType); return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/analytics/overview`, p), null, 2); }
    case "get_camera_analytics_recent": { const p: Record<string, string> = {}; if (args.objectType) p.objectType = String(args.objectType); return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/analytics/recent`, p), null, 2); }
    case "list_camera_analytics_zones": return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/analytics/zones`), null, 2);
    case "get_camera_analytics_zone_history": { const p: Record<string, string> = {}; if (args.timespan !== undefined) p.timespan = String(args.timespan); if (args.resolution !== undefined) p.resolution = String(args.resolution); if (args.objectType) p.objectType = String(args.objectType); return JSON.stringify(await merakiGet(env, `/devices/${args.serial}/camera/analytics/zones/${args.zone_id}/history`, p), null, 2); }

    // Camera - network-level
    case "list_camera_schedules": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/camera/schedules`), null, 2);
    case "list_network_camera_wireless_profiles": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/camera/wirelessProfiles`), null, 2);
    case "get_network_camera_wireless_profile": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/camera/wirelessProfiles/${args.profile_id}`), null, 2);
    case "create_network_camera_wireless_profile": return JSON.stringify(await merakiPost(env, `/networks/${args.network_id}/camera/wirelessProfiles`, { name: args.name, ssid: args.ssid }), null, 2);
    case "update_network_camera_wireless_profile": { const body: Record<string, unknown> = {}; if (args.name !== undefined) body.name = args.name; if (args.ssid !== undefined) body.ssid = args.ssid; return JSON.stringify(await merakiPut(env, `/networks/${args.network_id}/camera/wirelessProfiles/${args.profile_id}`, body), null, 2); }
    case "delete_network_camera_wireless_profile": return JSON.stringify(await merakiDelete(env, `/networks/${args.network_id}/camera/wirelessProfiles/${args.profile_id}`), null, 2);
    case "list_network_camera_quality_retention_profiles": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/camera/qualityRetentionProfiles`), null, 2);
    case "get_network_camera_quality_retention_profile": return JSON.stringify(await merakiGet(env, `/networks/${args.network_id}/camera/qualityRetentionProfiles/${args.profile_id}`), null, 2);
    case "create_network_camera_quality_retention_profile": { const body: Record<string, unknown> = { name: args.name }; if (args.motionBasedRetentionEnabled !== undefined) body.motionBasedRetentionEnabled = args.motionBasedRetentionEnabled; if (args.resolution !== undefined) body.resolution = args.resolution; return JSON.stringify(await merakiPost(env, `/networks/${args.network_id}/camera/qualityRetentionProfiles`, body), null, 2); }
    case "update_network_camera_quality_retention_profile": { const body: Record<string, unknown> = {}; if (args.name !== undefined) body.name = args.name; if (args.motionBasedRetentionEnabled !== undefined) body.motionBasedRetentionEnabled = args.motionBasedRetentionEnabled; if (args.resolution !== undefined) body.resolution = args.resolution; return JSON.stringify(await merakiPut(env, `/networks/${args.network_id}/camera/qualityRetentionProfiles/${args.profile_id}`, body), null, 2); }
    case "delete_network_camera_quality_retention_profile": return JSON.stringify(await merakiDelete(env, `/networks/${args.network_id}/camera/qualityRetentionProfiles/${args.profile_id}`), null, 2);

    // Camera - organization-level
    case "get_org_camera_onboarding_statuses": { const p: Record<string, string> = {}; if (args.serials) p.serials = JSON.stringify(args.serials); if (args.networkIds) p.networkIds = JSON.stringify(args.networkIds); return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/onboarding/statuses`, p), null, 2); }
    case "list_org_camera_permissions": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/permissions`), null, 2);
    case "get_org_camera_permission": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/permissions/${args.permission_id}`), null, 2);
    case "list_org_camera_roles": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/roles`), null, 2);
    case "get_org_camera_role": return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/roles/${args.role_id}`), null, 2);
    case "get_org_camera_boundaries_areas_by_device": { const p: Record<string, string> = {}; if (args.serials) p.serials = JSON.stringify(args.serials); if (args.networkIds) p.networkIds = JSON.stringify(args.networkIds); return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/boundaries/areas/byDevice`, p), null, 2); }
    case "get_org_camera_boundaries_lines_by_device": { const p: Record<string, string> = {}; if (args.serials) p.serials = JSON.stringify(args.serials); if (args.networkIds) p.networkIds = JSON.stringify(args.networkIds); return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/boundaries/lines/byDevice`, p), null, 2); }
    // NOTE: Meraki's own spec for this endpoint's `ranges` query param is an array of
    // { startTime, endTime, interval } objects - the exact query-string array-of-objects
    // wire encoding isn't confirmed against a live call, so this forwards it as a single
    // JSON-encoded string under `ranges`. Verify against a live tenant before relying on it;
    // if it 400s, the real encoding is likely indexed params (ranges[0][startTime]=...).
    case "get_org_camera_detections_history": { const p: Record<string, string> = { ranges: JSON.stringify(args.ranges) }; return JSON.stringify(await merakiGet(env, `/organizations/${args.org_id}/camera/detections/history/byBoundary/byInterval`, p), null, 2); }

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

// Constant-time string compare for the inbound bearer check below (no
// early exit on the first differing byte); a length mismatch is fine to
// short-circuit on.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    // Inbound auth (opt-in): once the MCP_AUTH_TOKEN secret is set on this
    // Worker, every route except OPTIONS and /health must carry
    // "Authorization: Bearer <that token>" - the same header the MCP client
    // registrations already send. Unset = unchanged behavior, so this code
    // deploys safely ahead of the secret. Real finding: every Worker in this
    // repo answered tools/list - and therefore every write tool - to a bare,
    // credential-less request on its public workers.dev URL, while the client
    // side had been sending a Bearer token all along that nothing ever
    // checked.
    if (env.MCP_AUTH_TOKEN && url.pathname !== "/health") {
      const provided = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!timingSafeEqual(provided, env.MCP_AUTH_TOKEN)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...JSON_HEADERS, "WWW-Authenticate": "Bearer" } });
      }
    }
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
