export interface Env {
  NINJA_BASE_URL: string;
  NINJA_CLIENT_ID: string;
  NINJA_CLIENT_SECRET: string;
}

let cachedToken: { token: string; expires: number } | null = null;

async function getToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  const res = await fetch(`${env.NINJA_BASE_URL}/ws/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.NINJA_CLIENT_ID,
      client_secret: env.NINJA_CLIENT_SECRET,
      scope: "monitoring management control",
    }).toString(),
  });
  if (!res.ok) throw new Error(`NinjaOne auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expires: Date.now() + (data.expires_in * 1000) };
  return data.access_token;
}

async function ninjaGet(env: Env, path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getToken(env);
  const url = new URL(`${env.NINJA_BASE_URL}/v2${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /v2${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function ninjaPost(env: Env, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.NINJA_BASE_URL}/v2${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST /v2${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function ninjaPut(env: Env, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.NINJA_BASE_URL}/v2${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PUT /v2${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function ninjaPatch(env: Env, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.NINJA_BASE_URL}/v2${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`PATCH /v2${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? { success: true } : res.json();
}

async function ninjaDelete(env: Env, path: string): Promise<unknown> {
  const token = await getToken(env);
  const res = await fetch(`${env.NINJA_BASE_URL}/v2${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`DELETE /v2${path} failed (${res.status}): ${await res.text()}`);
  return { success: true };
}

const TOOLS = [
  // Healthcheck
  { name: "healthcheck", description: "Test connectivity to NinjaOne and verify credentials", inputSchema: { type: "object", properties: {} } },

  // Organizations
  { name: "list_organizations", description: "List all organizations/clients in NinjaOne", inputSchema: { type: "object", properties: { pageSize: { type: "number", description: "Results per page (default 50)" }, after: { type: "number", description: "Pagination cursor - last org ID" } } } },
  { name: "get_organization", description: "Get full details of a single organization by ID", inputSchema: { type: "object", properties: { org_id: { type: "number" } }, required: ["org_id"] } },
  { name: "create_organization", description: "Create a new organization/client in NinjaOne", inputSchema: { type: "object", properties: { name: { type: "string", description: "Organization name" }, description: { type: "string" }, nodeApprovalMode: { type: "string", description: "AUTOMATIC, MANUAL, or REJECT (default AUTOMATIC)" } }, required: ["name"] } },
  { name: "update_organization", description: "Update an organization's name, description, or settings", inputSchema: { type: "object", properties: { org_id: { type: "number" }, name: { type: "string" }, description: { type: "string" }, nodeApprovalMode: { type: "string" } }, required: ["org_id"] } },
  { name: "list_org_locations", description: "List locations/sites for an organization", inputSchema: { type: "object", properties: { org_id: { type: "number" } }, required: ["org_id"] } },
  { name: "create_org_location", description: "Create a new location/site for an organization", inputSchema: { type: "object", properties: { org_id: { type: "number" }, name: { type: "string", description: "Location name" }, address: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zipCode: { type: "string" } }, required: ["org_id", "name"] } },
  { name: "list_org_devices", description: "List all devices for a specific organization", inputSchema: { type: "object", properties: { org_id: { type: "number" }, pageSize: { type: "number" } }, required: ["org_id"] } },
  { name: "list_org_contacts", description: "List end-user contacts for an organization", inputSchema: { type: "object", properties: { org_id: { type: "number" } }, required: ["org_id"] } },
  { name: "list_org_policies", description: "List policies assigned to an organization", inputSchema: { type: "object", properties: { org_id: { type: "number" } }, required: ["org_id"] } },

  // Devices
  { name: "list_devices", description: "List all managed devices across all organizations", inputSchema: { type: "object", properties: { pageSize: { type: "number", description: "Results per page (default 50)" }, after: { type: "number", description: "Pagination cursor" }, org_id: { type: "number", description: "Filter by organization ID" } } } },
  { name: "list_devices_detailed", description: "List devices with full hardware and software details", inputSchema: { type: "object", properties: { pageSize: { type: "number", description: "Results per page (default 25)" }, after: { type: "number" }, org_id: { type: "number" } } } },
  { name: "get_device", description: "Get full details of a single device by ID", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "update_device", description: "Update a device's display name, description, or assigned user", inputSchema: { type: "object", properties: { device_id: { type: "number" }, displayName: { type: "string" }, description: { type: "string" }, userData: { type: "object", description: "Custom field values" } }, required: ["device_id"] } },
  { name: "get_device_os_info", description: "Get OS details and last logged-on user for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_disks", description: "Get disk/storage information for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_network_interfaces", description: "Get network interface and IP address information for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_software", description: "Get installed software inventory for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_processors", description: "Get CPU/processor details for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_volumes", description: "Get disk volume and free space details for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_windows_services", description: "Get Windows services and their status for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },

  // Device Actions (Write)
  { name: "reboot_device", description: "Reboot a managed device", inputSchema: { type: "object", properties: { device_id: { type: "number" }, mode: { type: "string", description: "NORMAL or FORCED (default NORMAL)" } }, required: ["device_id"] } },
  { name: "run_script_on_device", description: "Run an automation script on a device by script ID", inputSchema: { type: "object", properties: { device_id: { type: "number" }, script_id: { type: "number", description: "Script ID from list_automation_scripts" }, runAs: { type: "string", description: "SYSTEM or LOGGED_IN_USER (default SYSTEM)" }, parameters: { type: "object", description: "Script parameter key-value pairs" } }, required: ["device_id", "script_id"] } },
  { name: "set_device_maintenance", description: "Put a device in maintenance mode for a specified duration", inputSchema: { type: "object", properties: { device_id: { type: "number" }, start: { type: "string", description: "Start datetime ISO e.g. 2026-05-22T18:00:00Z (omit for now)" }, end: { type: "string", description: "End datetime ISO e.g. 2026-05-22T20:00:00Z" }, disabledFeatures: { type: "array", items: { type: "string" }, description: "Features to disable: ALERTS, PATCHING, AVSCANS, TASKS (omit for all)" } }, required: ["device_id", "end"] } },
  { name: "end_device_maintenance", description: "Cancel/end maintenance mode on a device immediately", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "get_device_maintenance", description: "Get current maintenance window status for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "approve_device", description: "Approve a pending device for monitoring and management", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "reject_device", description: "Reject a pending device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },

  // Alerts
  { name: "list_alerts", description: "List all active alerts across all devices", inputSchema: { type: "object", properties: { sourceType: { type: "string", description: "CONDITION, PATCH, ANTIVIRUS, etc." }, lang: { type: "string", description: "Language for messages (default en)" } } } },
  { name: "list_device_alerts", description: "List active alerts for a specific device", inputSchema: { type: "object", properties: { device_id: { type: "number" }, lang: { type: "string" } }, required: ["device_id"] } },
  { name: "acknowledge_alert", description: "Acknowledge an active alert by alert UID", inputSchema: { type: "object", properties: { alert_uid: { type: "string", description: "Alert UID from list_alerts" } }, required: ["alert_uid"] } },
  { name: "resolve_alert", description: "Resolve an active alert by alert UID", inputSchema: { type: "object", properties: { alert_uid: { type: "string", description: "Alert UID from list_alerts" } }, required: ["alert_uid"] } },

  // Patch Management
  { name: "get_device_os_patches", description: "Get OS patches for a device filtered by status", inputSchema: { type: "object", properties: { device_id: { type: "number" }, status: { type: "string", description: "PENDING, FAILED, REJECTED, APPROVED, INSTALLED" } }, required: ["device_id"] } },
  { name: "get_device_software_patches", description: "Get third-party software patches for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" }, status: { type: "string", description: "PENDING, FAILED, REJECTED, APPROVED, INSTALLED" } }, required: ["device_id"] } },
  { name: "query_os_patches", description: "Query OS patch status across all devices", inputSchema: { type: "object", properties: { status: { type: "string", description: "PENDING, FAILED, REJECTED, APPROVED, INSTALLED" }, type: { type: "string" }, pageSize: { type: "number", description: "Default 50" } } } },
  { name: "query_software_patches", description: "Query third-party software patch status across all devices", inputSchema: { type: "object", properties: { status: { type: "string" }, productIdentifier: { type: "string", description: "Filter by software product name" }, pageSize: { type: "number", description: "Default 50" } } } },
  { name: "approve_os_patch", description: "Approve an OS patch for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" }, patch_id: { type: "number", description: "Patch ID from get_device_os_patches" } }, required: ["device_id", "patch_id"] } },
  { name: "reject_os_patch", description: "Reject an OS patch for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" }, patch_id: { type: "number", description: "Patch ID from get_device_os_patches" } }, required: ["device_id", "patch_id"] } },

  // Activities
  { name: "list_activities", description: "List recent activities and audit log entries", inputSchema: { type: "object", properties: { pageSize: { type: "number", description: "Default 50" }, activityType: { type: "string", description: "CONDITION, ACTIONSET, SYSTEM, USER" }, after: { type: "number" }, startTime: { type: "number", description: "Unix timestamp" }, endTime: { type: "number", description: "Unix timestamp" } } } },
  { name: "list_device_activities", description: "List recent activities for a specific device", inputSchema: { type: "object", properties: { device_id: { type: "number" }, pageSize: { type: "number", description: "Default 50" }, activityType: { type: "string" } }, required: ["device_id"] } },

  // Software / Inventory
  { name: "query_software_inventory", description: "Query installed software across all managed devices", inputSchema: { type: "object", properties: { name: { type: "string", description: "Filter by software name" }, pageSize: { type: "number", description: "Default 50" } } } },

  // Policies
  { name: "list_policies", description: "List all policies in NinjaOne", inputSchema: { type: "object", properties: {} } },

  // Automation Scripts
  { name: "list_automation_scripts", description: "List all available automation scripts", inputSchema: { type: "object", properties: {} } },

  // Users
  { name: "list_users", description: "List NinjaOne technician/user accounts", inputSchema: { type: "object", properties: {} } },

  // Device Groups
  { name: "list_device_groups", description: "List device groups/filters in NinjaOne", inputSchema: { type: "object", properties: {} } },

  // Antivirus / Security
  { name: "list_device_antivirus_status", description: "Get antivirus status and threats for a device", inputSchema: { type: "object", properties: { device_id: { type: "number" } }, required: ["device_id"] } },
  { name: "query_antivirus_threats", description: "Query antivirus threats detected across all devices", inputSchema: { type: "object", properties: { pageSize: { type: "number", description: "Default 50" } } } },

  // Backup
  { name: "query_backup_jobs", description: "Query backup job status across all devices", inputSchema: { type: "object", properties: { status: { type: "string", description: "SUCCEEDED, FAILED, RUNNING" }, pageSize: { type: "number", description: "Default 50" } } } },

  // Ticketing
  { name: "list_tickets", description: "List NinjaOne tickets/alerts with optional filters", inputSchema: { type: "object", properties: { status: { type: "string", description: "OPEN, CLOSED, PAUSED" }, org_id: { type: "number", description: "Filter by organization" }, pageSize: { type: "number", description: "Default 50" } } } },
  { name: "get_ticket", description: "Get full details of a single NinjaOne ticket", inputSchema: { type: "object", properties: { ticket_id: { type: "number" } }, required: ["ticket_id"] } },
  { name: "create_ticket", description: "Create a new NinjaOne ticket", inputSchema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" }, org_id: { type: "number", description: "Organization ID" }, device_id: { type: "number", description: "Associated device ID" }, priority: { type: "string", description: "NONE, LOW, MEDIUM, HIGH, URGENT" }, severity: { type: "string", description: "NONE, MINOR, MODERATE, MAJOR, CRITICAL" } }, required: ["subject"] } },
  { name: "update_ticket", description: "Update a NinjaOne ticket status, priority, or assignee", inputSchema: { type: "object", properties: { ticket_id: { type: "number" }, status: { type: "string", description: "OPEN, CLOSED, PAUSED" }, priority: { type: "string" }, assignedAppUserId: { type: "number", description: "Technician ID to assign" } }, required: ["ticket_id"] } },
];

async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<string> {
  switch (name) {
    case "healthcheck": { const data = await ninjaGet(env, "/organizations", { pageSize: "1" }); return `Connected OK to ${env.NINJA_BASE_URL}. Response: ${JSON.stringify(data).substring(0, 150)}`; }

    // Organizations
    case "list_organizations": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.after) p.after = String(args.after); return JSON.stringify(await ninjaGet(env, "/organizations", p), null, 2); }
    case "get_organization": return JSON.stringify(await ninjaGet(env, `/organizations/${args.org_id}`), null, 2);
    case "create_organization": return JSON.stringify(await ninjaPost(env, "/organizations", { name: args.name, description: args.description ?? "", nodeApprovalMode: args.nodeApprovalMode ?? "AUTOMATIC" }), null, 2);
    case "update_organization": { const body: Record<string, unknown> = {}; if (args.name) body.name = args.name; if (args.description !== undefined) body.description = args.description; if (args.nodeApprovalMode) body.nodeApprovalMode = args.nodeApprovalMode; return JSON.stringify(await ninjaPatch(env, `/organizations/${args.org_id}`, body), null, 2); }
    case "list_org_locations": return JSON.stringify(await ninjaGet(env, `/organization/${args.org_id}/locations`), null, 2);
    case "create_org_location": { const body: Record<string, unknown> = { name: args.name }; if (args.address) body.address = args.address; if (args.city) body.city = args.city; if (args.state) body.state = args.state; if (args.zipCode) body.zipCode = args.zipCode; return JSON.stringify(await ninjaPost(env, `/organization/${args.org_id}/locations`, body), null, 2); }
    case "list_org_devices": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; return JSON.stringify(await ninjaGet(env, `/organization/${args.org_id}/devices`, p), null, 2); }
    case "list_org_contacts": return JSON.stringify(await ninjaGet(env, `/organization/${args.org_id}/end-users`), null, 2);
    case "list_org_policies": return JSON.stringify(await ninjaGet(env, `/organization/${args.org_id}/policies`), null, 2);

    // Devices (Read)
    case "list_devices": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.after) p.after = String(args.after); if (args.org_id) p.org = String(args.org_id); return JSON.stringify(await ninjaGet(env, "/devices", p), null, 2); }
    case "list_devices_detailed": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 25) }; if (args.after) p.after = String(args.after); if (args.org_id) p.org = String(args.org_id); return JSON.stringify(await ninjaGet(env, "/devices-detailed", p), null, 2); }
    case "get_device": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}`), null, 2);
    case "update_device": { const body: Record<string, unknown> = {}; if (args.displayName) body.displayName = args.displayName; if (args.description) body.description = args.description; if (args.userData) body.userData = args.userData; return JSON.stringify(await ninjaPatch(env, `/device/${args.device_id}`, body), null, 2); }
    case "get_device_os_info": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/os`), null, 2);
    case "get_device_disks": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/disks`), null, 2);
    case "get_device_network_interfaces": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/network-interfaces`), null, 2);
    case "get_device_software": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/software`), null, 2);
    case "get_device_processors": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/processors`), null, 2);
    case "get_device_volumes": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/volumes`), null, 2);
    case "get_device_windows_services": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/windows-services`), null, 2);

    // Device Actions (Write)
    case "reboot_device": return JSON.stringify(await ninjaPost(env, `/device/${args.device_id}/reboot/${args.mode ?? "NORMAL"}`), null, 2);
    case "run_script_on_device": return JSON.stringify(await ninjaPost(env, `/device/${args.device_id}/script/run`, { id: args.script_id, runAs: args.runAs ?? "SYSTEM", parameters: args.parameters ?? {} }), null, 2);
    case "set_device_maintenance": { const body: Record<string, unknown> = { end: args.end }; if (args.start) body.start = args.start; if (args.disabledFeatures) body.disabledFeatures = args.disabledFeatures; return JSON.stringify(await ninjaPut(env, `/device/${args.device_id}/maintenance`, body), null, 2); }
    case "end_device_maintenance": return JSON.stringify(await ninjaDelete(env, `/device/${args.device_id}/maintenance`), null, 2);
    case "get_device_maintenance": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/maintenance`), null, 2);
    case "approve_device": return JSON.stringify(await ninjaPost(env, `/device/${args.device_id}/approval/APPROVE`), null, 2);
    case "reject_device": return JSON.stringify(await ninjaPost(env, `/device/${args.device_id}/approval/REJECT`), null, 2);

    // Alerts
    case "list_alerts": { const p: Record<string, string> = { lang: String(args.lang ?? "en") }; if (args.sourceType) p.sourceType = String(args.sourceType); return JSON.stringify(await ninjaGet(env, "/alerts", p), null, 2); }
    case "list_device_alerts": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/alerts`, { lang: String(args.lang ?? "en") }), null, 2);
    case "acknowledge_alert": return JSON.stringify(await ninjaPost(env, `/alert/${args.alert_uid}/acknowledge`), null, 2);
    case "resolve_alert": return JSON.stringify(await ninjaDelete(env, `/alert/${args.alert_uid}`), null, 2);

    // Patch Management
    case "get_device_os_patches": { const p: Record<string, string> = {}; if (args.status) p.status = String(args.status); return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/os-patches`, p), null, 2); }
    case "get_device_software_patches": { const p: Record<string, string> = {}; if (args.status) p.status = String(args.status); return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/software-patches`, p), null, 2); }
    case "query_os_patches": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.status) p.status = String(args.status); if (args.type) p.type = String(args.type); return JSON.stringify(await ninjaGet(env, "/queries/os-patches", p), null, 2); }
    case "query_software_patches": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.status) p.status = String(args.status); if (args.productIdentifier) p.productIdentifier = String(args.productIdentifier); return JSON.stringify(await ninjaGet(env, "/queries/software-patches", p), null, 2); }
    case "approve_os_patch": return JSON.stringify(await ninjaPost(env, `/device/${args.device_id}/os-patches/${args.patch_id}/approve`), null, 2);
    case "reject_os_patch": return JSON.stringify(await ninjaPost(env, `/device/${args.device_id}/os-patches/${args.patch_id}/reject`), null, 2);

    // Activities
    case "list_activities": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.activityType) p.activityType = String(args.activityType); if (args.after) p.after = String(args.after); if (args.startTime) p.startTime = String(args.startTime); if (args.endTime) p.endTime = String(args.endTime); return JSON.stringify(await ninjaGet(env, "/activities", p), null, 2); }
    case "list_device_activities": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.activityType) p.activityType = String(args.activityType); return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/activities`, p), null, 2); }

    // Software / Inventory
    case "query_software_inventory": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.name) p.name = String(args.name); return JSON.stringify(await ninjaGet(env, "/queries/software", p), null, 2); }

    // Policies / Scripts / Users / Groups
    case "list_policies": return JSON.stringify(await ninjaGet(env, "/policies"), null, 2);
    case "list_automation_scripts": return JSON.stringify(await ninjaGet(env, "/automation/scripts"), null, 2);
    case "list_users": return JSON.stringify(await ninjaGet(env, "/users"), null, 2);
    case "list_device_groups": return JSON.stringify(await ninjaGet(env, "/device-groups"), null, 2);

    // Antivirus / Security
    case "list_device_antivirus_status": return JSON.stringify(await ninjaGet(env, `/device/${args.device_id}/antivirus-status`), null, 2);
    case "query_antivirus_threats": return JSON.stringify(await ninjaGet(env, "/queries/antivirus-threats", { pageSize: String(args.pageSize ?? 50) }), null, 2);

    // Backup
    case "query_backup_jobs": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.status) p.status = String(args.status); return JSON.stringify(await ninjaGet(env, "/queries/backup-jobs", p), null, 2); }

    // Ticketing
    case "list_tickets": { const p: Record<string, string> = { pageSize: String(args.pageSize ?? 50) }; if (args.status) p.status = String(args.status); if (args.org_id) p.clientId = String(args.org_id); return JSON.stringify(await ninjaGet(env, "/ticketing/ticket", p), null, 2); }
    case "get_ticket": return JSON.stringify(await ninjaGet(env, `/ticketing/ticket/${args.ticket_id}`), null, 2);
    case "create_ticket": { const body: Record<string, unknown> = { subject: args.subject }; if (args.description) body.description = args.description; if (args.org_id) body.clientId = args.org_id; if (args.device_id) body.nodeId = args.device_id; if (args.priority) body.priority = args.priority; if (args.severity) body.severity = args.severity; return JSON.stringify(await ninjaPost(env, "/ticketing/ticket", body), null, 2); }
    case "update_ticket": { const body: Record<string, unknown> = {}; if (args.status) body.status = args.status; if (args.priority) body.priority = args.priority; if (args.assignedAppUserId) body.assignedAppUserId = args.assignedAppUserId; return JSON.stringify(await ninjaPatch(env, `/ticketing/ticket/${args.ticket_id}`, body), null, 2); }

    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================
// Wallboard status route — firewall/router/gateway online-offline
// status, for the wallboard's Network zone (merged there with
// Meraki org health).
//
// Reuses the same /organizations and /devices endpoints your
// list_organizations / list_devices tools already call — filters
// to NMS device classes (firewalls, routers, gateways) and shapes
// into { client, name, role, status, lastContact } per device.
//
// pageSize is set high (1000) to get everything in one call. If
// your device count ever exceeds that, this will silently miss
// devices past the first page — add "after" cursor pagination here
// if that becomes a real concern.
// ============================================================

const NODE_CLASSES = ["NMS_FIREWALL", "NMS_ROUTER", "NMS_PRIVATE_NETWORK_GATEWAY"];
const ROLE_LABELS: Record<string, string> = { NMS_FIREWALL: "Firewall", NMS_ROUTER: "Router", NMS_PRIVATE_NETWORK_GATEWAY: "Gateway" };

async function buildNocStatus(env: Env) {
  const orgs = (await ninjaGet(env, "/organizations", { pageSize: "1000" })) as any[];
  const orgNameById = new Map(orgs.map((o) => [o.id, o.name]));

  const devices = (await ninjaGet(env, "/devices", { pageSize: "1000" })) as any[];

  const filtered = devices
    .filter((d) => NODE_CLASSES.includes(d.nodeClass))
    .map((d) => ({
      id: d.id,
      client: orgNameById.get(d.organizationId) || `Org ${d.organizationId}`,
      name: d.displayName || d.systemName || `Device ${d.id}`,
      role: ROLE_LABELS[d.nodeClass] || d.nodeClass,
      status: d.offline ? "offline" : "online",
      lastContact: d.lastContact ? new Date(d.lastContact * 1000).toISOString() : new Date().toISOString(),
    }));

  return { updated: new Date().toISOString(), devices: filtered };
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept" };
const JSON_HEADERS = { ...CORS, "Content-Type": "application/json" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return new Response(JSON.stringify({ status: "ok", instance: env.NINJA_BASE_URL }), { headers: JSON_HEADERS });
    if (url.pathname === "/status") {
      try {
        const status = await buildNocStatus(env);
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
          if (method === "initialize") responses.push({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "NinjaOne RMM MCP Server", version: "2.0.0" } } });
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
    return new Response("NinjaOne RMM MCP Server v2 - POST /mcp, GET /status, GET /health", { status: 200, headers: CORS });
  },
};
