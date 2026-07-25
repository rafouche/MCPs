# teams-meeting-notes-worker

Auto-generates Azure-OpenAI-written meeting notes from Teams transcripts and
posts them to a Teams channel, with no manual step after the meeting ends.

**Pattern:** webhook-driven automation worker (Graph change notification →
Azure OpenAI → Teams webhook). Unlike the `*-mcp` workers in this repo, this
worker does not implement an MCP `TOOLS`/`runTool` surface or a `/mcp`
JSON-RPC endpoint — it has no MCP client-facing role. It follows the same
npm/wrangler install and secrets conventions as the rest of the repo, but
its routes are its own (see **Routes** below).

**Windows shell note (same as every other project in this repo):**
PowerShell's quoting mangles JSON request bodies. Use `cmd.exe`, or pipe
from `echo` into curl's `--data-binary @-`, when hand-testing the
`/webhook` or `/subscribe` endpoints from the command line.

## How it decides what to post where (read this first)

There are two ways to get notes back into Teams. This build uses the simpler
one on purpose:

- **Incoming Webhook to a fixed channel (what this uses):** every meeting's
  notes land in one "Meeting Notes" channel per client tenant. Setup is a
  few clicks in Teams, no extra Graph app permission needed, works
  immediately.
- **Posting into the original meeting's own chat thread:** more "native"
  feeling, but requires resolving meeting ID → chat ID and app-level
  `ChatMessage.Send` permission, which has tighter Microsoft restrictions
  and more failure modes. Treat as a v2 upgrade, not a v1 requirement.

Start with the webhook approach below; it'll get you 90% of the value
today.

## 1. Azure AD app registration (per client tenant, or your own tenant to start)

1. Entra admin center → **App registrations** → **New registration**.
   Name it something like `Altec Meeting Notes Worker`.
2. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Application permissions**. Add:
   - `OnlineMeetingTranscript.Read.All`
   - `OnlineMeetings.Read.All`
3. Click **Grant admin consent** for the tenant — application permissions
   don't work until this is done.
4. **Certificates & secrets** → **New client secret**. Copy the value
   immediately (shown once).
5. Note the **Application (client) ID** and **Directory (tenant) ID** from
   the Overview page.

These three values (tenant ID, client ID, client secret) go into
`GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, and `GRAPH_CLIENT_SECRET` below — as
Cloudflare secrets, never in this file or any other tracked file.

## 2. Teams webhook (via Power Automate)

The classic "Incoming Webhook" connector Microsoft used to ship is retired.
The replacement lives in Power Automate as a **built-in trigger** (not a
regular connector) — it doesn't show up if you search for "webhook" in
Teams' own Workflows template catalog, and it won't show up in Power
Automate's "Automated cloud flow" creation dialog's trigger search either
(that dialog only searches connector-based triggers). You have to reach it
through the full flow designer's own trigger picker, under **Built-in
tools**. Verified working path, done directly in Power Automate (no need to
go through Teams at all):

1. Go to [make.powerautomate.com](https://make.powerautomate.com) → **Create**
   (left nav) → **Automated cloud flow**.
2. In the "Build an automated cloud flow" dialog, give it a name (e.g.
   `Post Teams Meeting Notes`) and click **Skip** instead of searching for a
   trigger — that dialog's search box won't find the one we need. Skipping
   drops you on a blank flow canvas with an **"Add a trigger"** placeholder.
3. Click **Add a trigger**. In the left panel, scroll to the
   **Built-in tools** section (above "By connector") and click
   **Microsoft Teams Webhook**, then select
   **When a Teams webhook request is received**.
4. On the trigger's **Parameters** tab, change **"Who can trigger the
   flow?"** from the default **"Any user in my tenant"** to **"Anyone"**.
   This is required — our worker calls this URL with a plain unauthenticated
   POST (no Azure AD bearer token), and "Any user in my tenant" would 401
   every call. The URL itself is the only thing securing it (same trust
   model as the old classic connector), so treat it as a secret.
5. Click the **+** below the trigger → **Add an action** → search
   **"Post card in a chat or channel"** (Microsoft Teams connector) — not
   "Post message in a chat or channel"; the "card" variant has a dedicated
   Adaptive Card JSON field, which is a much cleaner fit for what our
   worker sends. Configure:
   - **Post as:** Flow bot
   - **Post in:** Channel
   - **Team:** your team
   - **Channel:** your target channel (e.g. "Meeting Notes")
   - **Adaptive Card:** click into the field, open the dynamic-content
     picker (lightning-bolt icon), and select **"Attachments Adaptive
     Card"** under the trigger. Power Automate parses this directly out of
     our worker's payload envelope (`{ type: "message", attachments: [{
     contentType: "application/vnd.microsoft.card.adaptive", content:
     {...} }] }`) — no manual JSON expression needed.
   - Because `attachments` is technically an array, Power Automate will
     auto-wrap the action in a **"For each"** loop when you insert that
     token. That's expected and correct — our worker always sends exactly
     one attachment, so it's a loop of one.
6. Rename the flow at the top-left if you haven't already, then **Save**.
7. Click back into the trigger step — the **HTTP URL** field now shows the
   generated webhook URL. Click the copy icon next to it rather than trying
   to select/read the text — it's a bearer secret and the field is
   typically visually truncated.
8. Set the secret and paste when prompted (don't type it as a second
   argument):
   ```bash
   wrangler secret put TEAMS_WEBHOOK_URL
   ```
9. **Test before wiring up the real pipeline.** `%TEAMS_WEBHOOK_URL%` /
   `$env:TEAMS_WEBHOOK_URL` will **not** work for this — it's a Cloudflare
   Worker secret, not a local shell variable, so nothing expands it
   locally. Paste the actual URL (or re-copy it from the trigger step) into
   one of these instead:

   PowerShell (pulls straight from the clipboard if you just copied it,
   avoiding retyping a secret):
   ```powershell
   $url = Get-Clipboard
   $body = @'
   {"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":"test"}]}}]}
   '@
   Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $body
   ```

   `cmd.exe` (see the Windows shell note above for why `curl` in
   PowerShell doesn't work the same way — it's aliased to
   `Invoke-WebRequest` there, with different flags):
   ```cmd
   curl -X POST "<paste your webhook URL here>" -H "Content-Type: application/json" -d "{\"type\":\"message\",\"attachments\":[{\"contentType\":\"application/vnd.microsoft.card.adaptive\",\"content\":{\"type\":\"AdaptiveCard\",\"version\":\"1.4\",\"body\":[{\"type\":\"TextBlock\",\"text\":\"test\"}]}}]}"
   ```

   Confirm an actual card renders in the channel (not blank, not raw JSON
   dumped as text) before relying on it for a real meeting. Both commands
   above return no output on success — check the channel, not the shell.

## 3. Azure OpenAI resource and deployment

Two values come out of this section: `AZURE_OPENAI_ENDPOINT` (a full URL,
not just a hostname) and `AZURE_OPENAI_KEY`.

**Read this before picking a model.** Azure's OpenAI model catalog moves
fast — `gpt-4o` and `gpt-4o-mini`, both commonly cited in older docs and
tutorials, are **fully deprecated for new deployments** as of this
writing (Microsoft's own replacement path points at the `gpt-5.x` line).
Whatever model name you find in a blog post, ours included, may already be
gone by the time you set this up. Don't hardcode a model choice from
documentation — check what's actually deployable in your subscription and
region first:

```bash
az cognitiveservices model list --location <region> \
  --query "[?kind=='OpenAI'].{Model:model.name, Version:model.version, Status:model.lifecycleStatus}" \
  -o table
```

Only `"GenerallyAvailable"` entries are safe bets; skip anything showing
`"Deprecating"` or `"Deprecated"` — those will fail at deployment time even
though they still show up in the catalog listing.

**New subscriptions typically start with zero default quota** for
`GlobalStandard` SKU on newer/premium models — a deployment attempt fails
with `InsufficientQuota` even though the model itself is listed as
available. Check what quota you actually have before attempting a
deployment:

```bash
az cognitiveservices usage list --location <region> \
  --query "[?contains(name.value, '<model-name>')].{Name:name.value, Limit:limit}" -o table
```

If `GlobalStandard` shows a 0 limit, look for a `DataZoneStandard` limit
instead (often has usable default quota on a fresh subscription) —
functionally fine for most orgs: it scopes processing to a broader
US-wide data zone rather than a single specific region, not a single-region
guarantee like `Standard`/`GlobalStandard`, but not a "your data leaves the
country" concern either. Getting non-default quota approved for a specific
model/SKU combination means filing a quota-increase request in the Azure
Portal, which is a manual Microsoft approval — not instant.

1. In the [Azure Portal](https://portal.azure.com), search for
   **Azure OpenAI** → **Create** (or reuse an existing resource if you
   already have one for this subscription/region).
   - Pick the **Subscription** and **Resource group** you want this billed
     under. If the subscription has never used Azure OpenAI / Cognitive
     Services before, resource creation will fail until the
     `Microsoft.CognitiveServices` resource provider is registered on it
     (`az provider register --namespace Microsoft.CognitiveServices` — a
     one-time step, takes a minute or two to complete).
   - Pick a **Region** that has capacity for the model you want to deploy
     (not every region supports every model — check with the CLI query
     above, or the portal's region picker, before committing).
   - Give it a **Name** — this becomes part of the endpoint hostname, e.g.
     a resource named `altec-meeting-notes` gives you
     `https://altec-meeting-notes.openai.azure.com`.
   - Pick a **Pricing tier** and click **Review + create** → **Create**.
     Wait for deployment to finish (a couple of minutes).
2. Once deployed, click **Go to resource**, then in the left nav open
   **Resource Management → Keys and Endpoint**.
   - Copy **KEY 1** (or KEY 2 — either works) — this is the raw value for
     `AZURE_OPENAI_KEY`. Treat it like a password; don't paste it into this
     file or any other tracked file.
   - Note the **Endpoint** value shown here too (e.g.
     `https://altec-meeting-notes.openai.azure.com/`) — you'll need it in
     step 4 below, but you do **not** set this bare value as the secret;
     the secret is the full chat-completions URL built in step 4.
3. Deploy a chat-completions-capable model — pick one from the live
   `GenerallyAvailable` list above, with quota confirmed on whichever SKU
   you're using:
   - Go to **Azure OpenAI Studio** (button on the resource's Overview page,
     or `https://oai.azure.com` with the resource selected) →
     **Deployments** → **Create new deployment**.
   - Give the deployment a **Deployment name** — pick something short and
     memorable (e.g. `meeting-notes`), since you'll paste this exact name
     into the endpoint URL next. This name does not have to match the
     underlying model name.
   - Confirm the deployment — it typically becomes available within a
     minute or two.
4. Assemble `AZURE_OPENAI_ENDPOINT` from the three pieces above (resource
   name, deployment name) plus an API version, in this exact shape:

   ```
   https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>/chat/completions?api-version=<api-version>
   ```

   For example:

   ```
   https://altec-meeting-notes.openai.azure.com/openai/deployments/meeting-notes/chat/completions?api-version=2024-08-01-preview
   ```

   For `<api-version>`, use the current value documented on the
   [Azure OpenAI API version lifecycle](https://learn.microsoft.com/azure/ai-services/openai/api-version-lifecycle)
   page — this changes over time as Microsoft retires older versions, so
   don't assume the example above is still current when you set this up.
   `2024-08-01-preview` is confirmed working against the `chat/completions`
   endpoint as of this writing (Azure lists it as part of a "Legacy API"
   surface but still functional), even against current-generation models —
   but verify against the lifecycle page rather than trusting that
   indefinitely.
   This whole URL (not just the hostname) is what you paste in when you
   run `wrangler secret put AZURE_OPENAI_ENDPOINT` in step 5.
5. **Test before wiring up the secrets.** Some current-generation models
   reject the `max_tokens` parameter our worker's request body uses and
   require `max_completion_tokens` instead — you'll get a `400
   unsupported_parameter` error otherwise. Confirm with a direct call
   first:
   ```bash
   curl -X POST "<your AZURE_OPENAI_ENDPOINT>" \
     -H "api-key: <your AZURE_OPENAI_KEY>" \
     -H "Content-Type: application/json" \
     -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"max_completion_tokens\":5}"
   ```
   If it comes back complaining about `max_completion_tokens` instead
   (i.e. the model wants the old `max_tokens` name), or the worker starts
   throwing `Azure OpenAI error: 400 ... unsupported_parameter` after you
   deploy, check `src/index.js`'s `generateNotesWithAzureOpenAI` function
   and adjust which parameter name it sends to match your model.

## 4. Secrets Required

```bash
npm install
npx wrangler kv namespace create MEETING_NOTES_KV
# paste the returned id into wrangler.jsonc under kv_namespaces

wrangler secret put GRAPH_TENANT_ID       # Directory (tenant) ID, from step 1
wrangler secret put GRAPH_CLIENT_ID       # Application (client) ID, from step 1
wrangler secret put GRAPH_CLIENT_SECRET   # client secret value, from step 1
wrangler secret put GRAPH_CLIENT_STATE    # any random string you generate — shared secret to validate notifications came from your subscription
wrangler secret put AZURE_OPENAI_ENDPOINT # full chat-completions URL incl. deployment name + api-version, from step 3
wrangler secret put AZURE_OPENAI_KEY      # resource key (KEY 1 or KEY 2), from step 3
wrangler secret put TEAMS_WEBHOOK_URL     # from step 2
wrangler secret put WORKER_NOTIFICATION_URL   # this worker's own public URL once deployed, e.g. https://teams-meeting-notes-worker.young-math-a33a.workers.dev/webhook
```

`wrangler secret put <NAME>` prompts for the value on stdin — don't pass it
as a second argument, and never paste real secret values into this file or
any other tracked file.

## 5. Deploy

```bash
wrangler deploy
```

## 6. Create the Graph subscription

Once deployed and `WORKER_NOTIFICATION_URL` points at the live `/webhook`
endpoint:

```bash
curl -X POST https://teams-meeting-notes-worker.young-math-a33a.workers.dev/subscribe
```

Graph will immediately hit your `/webhook` with a `validationToken` — the
worker echoes it back automatically. If that round-trip fails, the
subscription creation itself will fail with an error you'll see in the
response body.

## 7. Verify the renewal cron

`wrangler.jsonc` runs `/renew` daily via a Cron Trigger. **Before relying on
this**, check the current max `expirationDateTime` window Microsoft allows
for the `communications/onlineMeetings/getAllTranscripts` resource — it has
changed over time and the code currently requests 3 days out as a
conservative default. If the actual max is shorter, tighten the cron
schedule accordingly so renewal always happens before expiry.

## Routes

- `POST /webhook` — Graph change-notification receiver (also handles the
  `validationToken` handshake)
- `POST /subscribe` — creates the Graph subscription
- `POST /renew` — renews the Graph subscription (also called by the cron)
- `GET /health` — health check

## What happens end to end

1. Someone records/transcribes a Teams meeting (native `Record and
   transcribe`).
2. A few minutes after the meeting ends, Graph finishes processing the
   transcript and fires a `created` change notification to `/webhook`.
3. Worker acks Graph within the required window, then asynchronously:
   - fetches the transcript VTT content via Graph (app-only token, client
     credentials flow, cached in KV)
   - converts VTT to plain speaker-labeled text
   - sends it to Azure OpenAI with a fixed notes-format prompt
   - posts the result as an Adaptive Card to the Teams webhook channel

## Known gaps to close before production use

- **Dedupe TTL** is 7 days in KV — fine for normal use, but if you ever
  replay old notifications manually, be aware they'll be silently dropped
  if already marked processed.
- **No retry/backoff** on Azure OpenAI or Graph fetch failures — currently just
  logs and drops. Given the triage-worker precedent, consider wiring this
  into the same alerting pattern you're already using there.
- **Per-tenant scaling**: this is written for one tenant (one set of Graph
  secrets, one Teams webhook). For multiple client tenants, you'd want to
  key secrets/webhook URLs by tenant ID and branch on `n.tenantId` from the
  notification payload — straightforward extension, not done here.
- **Transcript-only, no recording/video** — this pulls the VTT transcript
  specifically, not the video file. That's intentional (keeps Azure OpenAI
  calls cheap and fast) but worth confirming matches what you actually want
  archived per client.
- **Lifecycle notifications are received but ignored.** Graph requires a
  `lifecycleNotificationUrl` on any subscription with more than a 1-hour
  expiration window (this worker requests 3 days out), so `/subscribe`
  points it at the same `/webhook` route as regular change notifications.
  Lifecycle events (`reauthorizationRequired`, `subscriptionRemoved`,
  `missedNotifications`) have no `changeType` field, so
  `processNotifications`' `changeType !== "created"` check silently drops
  them today — they're received but nothing acts on them. The daily
  `/renew` cron is the actual safety net against subscription expiry; a
  `missedNotifications` event going unhandled means a transcript could
  theoretically be missed without anything surfacing that fact. Worth
  wiring into the same alerting pattern as the other known gaps here if
  this goes into real production use.
- **Per-app subscription limit is 1.** Graph allows only one active
  subscription per resource type (`communications/onlineMeetings/
  getAllTranscripts`) per app per tenant. If `/subscribe` ever fails with
  `ExtensionError` / "has reached its limit of '1'... subscription", an
  old subscription wasn't cleaned up — list and delete it via the Graph
  API (`GET`/`DELETE /v1.0/subscriptions/{id}`) before retrying, or use
  `/renew` instead of `/subscribe` if one already exists and just needs
  its expiry extended.
