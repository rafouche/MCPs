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

## 2. Teams webhook (via Workflows / Power Automate)

The classic "Incoming Webhook" connector Microsoft used to ship is being
retired tenant by tenant, replaced by the Workflows app (which is Power
Automate under the hood). The template catalog you see when you search
"webhook" in Workflows varies by tenant/rollout wave and does **not**
reliably include a direct Incoming-Webhook-equivalent template — build the
flow manually instead. Confirmed working path:

1. In Teams, go to the channel you want notes posted to (e.g. create a new
   "Meeting Notes" channel) → **⋯** → **Workflows**.
2. **Create** → **Create from scratch**.
3. The trigger shortlist shown here (Schedule / SharePoint / Outlook /
   Teams) does **not** include an HTTP/webhook trigger. Click
   **"Build with Power Automate to see more triggers"** at the bottom of
   the list — this opens the full flow designer at
   `make.powerautomate.com`.
4. In the trigger search box, search **"webhook"** and select
   **When a Teams webhook request is received** (Microsoft Teams
   connector) — this is the modern, supported replacement for the old
   Incoming Webhook connector.
5. Add a new step → search **"Post message"** → add
   **Post message in a chat or channel** (Microsoft Teams connector).
   Configure:
   - **Post as:** Flow bot
   - **Post in:** Channel
   - **Team / Channel:** pick your target team and the channel from step 1
6. Our worker POSTs a payload shaped like the old connector's envelope:
   ```json
   {
     "type": "message",
     "attachments": [
       {
         "contentType": "application/vnd.microsoft.card.adaptive",
         "content": { "...": "the Adaptive Card object" }
       }
     ]
   }
   ```
   On the **Post message in a chat or channel** action, switch the message
   type to **Adaptive Card** and map the card content in from the
   trigger's incoming request body — open the dynamic-content picker and
   look for the body field from **When a Teams webhook request is
   received**. If the picker won't let you drill directly into
   `attachments[0].content`, use the expression editor with something
   like:
   ```
   triggerBody()?['attachments']?[0]?['content']
   ```
   treating this as a starting point rather than a guarantee — Power
   Automate's dynamic-content picker sometimes exposes field names that
   don't exactly match the raw JSON path, so adjust to whatever the
   picker actually offers you.
7. **Save** the flow, then click back into the **When a Teams webhook
   request is received** trigger step — it now displays the generated
   HTTP POST URL. Copy it; this is `TEAMS_WEBHOOK_URL`.
8. **Test before wiring up the real pipeline.** Set the secret
   (`wrangler secret put TEAMS_WEBHOOK_URL`), then send a manual test POST
   matching the same envelope shape the worker sends — from `cmd.exe`
   (see the Windows shell note above for why):
   ```cmd
   curl -X POST "<your webhook URL>" -H "Content-Type: application/json" -d "{\"type\":\"message\",\"attachments\":[{\"contentType\":\"application/vnd.microsoft.card.adaptive\",\"content\":{\"type\":\"AdaptiveCard\",\"version\":\"1.4\",\"body\":[{\"type\":\"TextBlock\",\"text\":\"test\"}]}}]}"
   ```
   Confirm an actual card renders in the channel (not blank, not raw JSON
   dumped as text) before relying on it for a real meeting.

## 3. Azure OpenAI resource and deployment

Two values come out of this section: `AZURE_OPENAI_ENDPOINT` (a full URL,
not just a hostname) and `AZURE_OPENAI_KEY`.

1. In the [Azure Portal](https://portal.azure.com), search for
   **Azure OpenAI** → **Create** (or reuse an existing resource if you
   already have one for this subscription/region).
   - Pick the **Subscription** and **Resource group** you want this billed
     under.
   - Pick a **Region** that has capacity for the model you want to deploy
     (not every region supports every model — check availability in the
     portal's region picker before committing).
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
3. Deploy a chat-completions-capable model:
   - Go to **Azure OpenAI Studio** (button on the resource's Overview page,
     or `https://oai.azure.com` with the resource selected) →
     **Deployments** → **Create new deployment**.
   - Pick a model that supports chat completions (e.g. `gpt-4o` or
     `gpt-4o-mini`) and give the deployment a **Deployment name** — pick
     something short and memorable (e.g. `meeting-notes`), since you'll
     paste this exact name into the endpoint URL next. This name does not
     have to match the underlying model name.
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
   This whole URL (not just the hostname) is what you paste in when you
   run `wrangler secret put AZURE_OPENAI_ENDPOINT` in step 5.

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
