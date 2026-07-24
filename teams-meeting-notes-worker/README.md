# teams-meeting-notes-worker

Auto-generates Claude-written meeting notes from Teams transcripts and posts
them to a Teams channel, with no manual step after the meeting ends.

**Pattern:** webhook-driven automation worker (Graph change notification →
Claude → Teams webhook). Unlike the `*-mcp` workers in this repo, this
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

## 2. Teams Incoming Webhook

1. In Teams, go to the channel you want notes posted to (e.g. create a new
   "Meeting Notes" channel).
2. **⋯** on the channel → **Workflows** → search "Incoming Webhook" (this
   replaced the legacy connector setup in most tenants now) → configure a
   webhook, give it a name/icon.
3. Copy the generated webhook URL — this is `TEAMS_WEBHOOK_URL`.

## 3. Claude API key

`CLAUDE_API_KEY` is an **Anthropic Console API key**, separate from any
Claude.ai subscription:

1. Go to `console.anthropic.com` → **Settings → API Keys** (an Anthropic
   Console account with billing/credits set up is required — this is
   pay-as-you-go API usage, billed separately from claude.ai).
2. Create a key, copy it immediately (shown once).

## 4. Secrets Required

```bash
npm install
npx wrangler kv namespace create MEETING_NOTES_KV
# paste the returned id into wrangler.jsonc under kv_namespaces

wrangler secret put GRAPH_TENANT_ID       # Directory (tenant) ID, from step 1
wrangler secret put GRAPH_CLIENT_ID       # Application (client) ID, from step 1
wrangler secret put GRAPH_CLIENT_SECRET   # client secret value, from step 1
wrangler secret put GRAPH_CLIENT_STATE    # any random string you generate — shared secret to validate notifications came from your subscription
wrangler secret put CLAUDE_API_KEY        # Anthropic Console API key, from step 3
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
   - sends it to Claude with a fixed notes-format prompt
   - posts the result as an Adaptive Card to the Teams webhook channel

## Known gaps to close before production use

- **Dedupe TTL** is 7 days in KV — fine for normal use, but if you ever
  replay old notifications manually, be aware they'll be silently dropped
  if already marked processed.
- **No retry/backoff** on Claude or Graph fetch failures — currently just
  logs and drops. Given the triage-worker precedent, consider wiring this
  into the same alerting pattern you're already using there.
- **Per-tenant scaling**: this is written for one tenant (one set of Graph
  secrets, one Teams webhook). For multiple client tenants, you'd want to
  key secrets/webhook URLs by tenant ID and branch on `n.tenantId` from the
  notification payload — straightforward extension, not done here.
- **Transcript-only, no recording/video** — this pulls the VTT transcript
  specifically, not the video file. That's intentional (keeps Claude calls
  cheap and fast) but worth confirming matches what you actually want
  archived per client.
