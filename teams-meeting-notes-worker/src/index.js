/**
 * teams-meeting-notes-worker
 *
 * Flow:
 *   1. Graph sends a change notification when a meeting transcript becomes
 *      available (subscription on communications/onlineMeetings/getAllTranscripts).
 *   2. Worker validates clientState, acks Graph immediately, then processes
 *      async (via ctx.waitUntil) so we never miss Graph's ~30s ack window.
 *   3. Worker fetches the transcript content from Graph (app-only token,
 *      client credentials flow, cached in KV).
 *   4. VTT is converted to plain speaker-labeled text.
 *   5. Transcript is sent to Azure OpenAI for structured meeting notes.
 *   6. Notes are posted to Teams via an Incoming Webhook (see README for why
 *      this is the v1 approach instead of posting into the original chat).
 *
 * Bindings expected (see wrangler.toml):
 *   KV            - MEETING_NOTES_KV (token cache + processed-id dedupe)
 *   Secrets       - GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
 *                   GRAPH_CLIENT_STATE, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY,
 *                   TEAMS_WEBHOOK_URL, WORKER_NOTIFICATION_URL (this worker's own
 *                   public /webhook URL, used by the /subscribe and /renew routes)
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }
    if (url.pathname === "/subscribe" && request.method === "POST") {
      return handleSubscribe(env);
    }
    if (url.pathname === "/renew" && request.method === "POST") {
      return handleRenew(env);
    }
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },

  // Cron trigger (see wrangler.toml) — renews the subscription before it expires.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleRenew(env));
  },
};

// ---------------------------------------------------------------------------
// Graph webhook receive + validation handshake
// ---------------------------------------------------------------------------

async function handleWebhook(request, env, ctx) {
  const url = new URL(request.url);

  // Graph validation handshake: it POSTs (or GETs, depending on flow) with a
  // validationToken query param and expects it echoed back as text/plain
  // within 10 seconds. This happens on subscription creation and renewal.
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const notifications = body.value || [];

  // Ack immediately — Graph retries aggressively if it doesn't get a fast 202.
  // Do the real work after responding, via waitUntil.
  ctx.waitUntil(processNotifications(notifications, env));

  return new Response(null, { status: 202 });
}

async function processNotifications(notifications, env) {
  for (const n of notifications) {
    try {
      if (n.clientState !== env.GRAPH_CLIENT_STATE) {
        console.error("clientState mismatch, dropping notification");
        continue;
      }
      if (n.changeType !== "created") continue;

      // n.resource looks like:
      //   communications/onlineMeetings('MEETING_ID')/transcripts('TRANSCRIPT_ID')
      const resourcePath = n.resource;
      if (!resourcePath) continue;

      // Dedupe — Graph can and does redeliver notifications.
      const dedupeKey = `processed:${resourcePath}`;
      const already = await env.MEETING_NOTES_KV.get(dedupeKey);
      if (already) continue;
      await env.MEETING_NOTES_KV.put(dedupeKey, "1", { expirationTtl: 60 * 60 * 24 * 7 });

      await processTranscript(resourcePath, env);
    } catch (err) {
      console.error("error processing notification", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Transcript fetch + Azure OpenAI + Teams post
// ---------------------------------------------------------------------------

async function processTranscript(resourcePath, env) {
  const token = await getGraphToken(env);

  // Metadata call to get meeting subject / organizer / time for context and
  // for the Teams post title. resourcePath already gives us the transcript
  // resource itself, so fetch the transcript content directly.
  const contentUrl = `${GRAPH_BASE}/${resourcePath}/content?$format=text/vtt`;
  const meetingUrl = `${GRAPH_BASE}/${resourcePath.split("/transcripts")[0]}`;

  const [vttResp, meetingResp] = await Promise.all([
    fetch(contentUrl, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(meetingUrl, { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (!vttResp.ok) {
    console.error("failed to fetch transcript content", vttResp.status, await vttResp.text());
    return;
  }

  const vtt = await vttResp.text();
  const meeting = meetingResp.ok ? await meetingResp.json() : {};

  const plainTranscript = vttToPlainText(vtt);
  if (!plainTranscript.trim()) {
    console.error("empty transcript, skipping");
    return;
  }

  const notesMarkdown = await generateNotesWithAzureOpenAI(plainTranscript, meeting, env);
  await postToTeams(notesMarkdown, meeting, env);
}

/**
 * Fetch (or reuse cached) app-only Graph token via client credentials flow.
 * Cached in KV with a TTL slightly under the actual token lifetime.
 */
async function getGraphToken(env) {
  const cacheKey = "graph_app_token";
  const cached = await env.MEETING_NOTES_KV.get(cacheKey);
  if (cached) return cached;

  const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!resp.ok) {
    throw new Error(`Graph token request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  // expires_in is seconds; cache for a bit less to avoid edge-of-expiry use.
  await env.MEETING_NOTES_KV.put(cacheKey, data.access_token, {
    expirationTtl: Math.max(60, data.expires_in - 120),
  });

  return data.access_token;
}

/**
 * Minimal WEBVTT -> "Speaker: line" plain text converter.
 * Teams transcripts embed speaker as a <v Speaker Name> tag inside the cue text.
 */
function vttToPlainText(vtt) {
  const lines = vtt.split(/\r?\n/);
  const out = [];
  let lastSpeaker = null;

  for (const line of lines) {
    if (!line || line.startsWith("WEBVTT") || /^\d+$/.test(line.trim())) continue;
    if (line.includes("-->")) continue; // timestamp cue line

    const match = line.match(/^<v ([^>]+)>(.*)$/);
    if (match) {
      const speaker = match[1].trim();
      const text = match[2].replace(/<\/v>$/, "").trim();
      if (speaker === lastSpeaker) {
        out.push(text);
      } else {
        out.push(`\n${speaker}: ${text}`);
        lastSpeaker = speaker;
      }
    } else if (line.trim()) {
      out.push(line.trim());
    }
  }

  return out.join(" ").replace(/\n /g, "\n").trim();
}

async function generateNotesWithAzureOpenAI(transcript, meeting, env) {
  const subject = meeting?.subject || "Teams Meeting";

  const prompt = `You are generating internal meeting notes for an MSP (Altec Solutions Group) from a raw Teams meeting transcript.

Meeting subject: ${subject}

Produce concise notes in this exact Markdown structure:

## Summary
2-4 sentences on what the meeting was about and the outcome.

## Key Decisions
- Bullet list. Omit section if none.

## Action Items
- Bullet list, each formatted as: **Owner** — task (if an owner wasn't stated, write "Unassigned").

## Open Questions
- Bullet list of anything left unresolved. Omit section if none.

Do not editorialize or add information not present in the transcript. If the transcript is too short or unclear to produce real notes, say so plainly instead of fabricating content.

Transcript:
"""
${transcript}
"""`;

  const resp = await fetch(env.AZURE_OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": env.AZURE_OPENAI_KEY,
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1500,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Azure OpenAI error: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content;
  return text || "_Azure OpenAI returned no text content._";
}

/**
 * Posts to a Teams channel via Incoming Webhook (Workflows connector).
 * See README for why this is the v1 posting method.
 */
async function postToTeams(notesMarkdown, meeting, env) {
  const subject = meeting?.subject || "Teams Meeting";
  const startTime = meeting?.startDateTime
    ? new Date(meeting.startDateTime).toLocaleString("en-US", { timeZone: "America/Chicago" })
    : "";

  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: `Meeting Notes: ${subject}`,
              weight: "Bolder",
              size: "Medium",
              wrap: true,
            },
            ...(startTime
              ? [{ type: "TextBlock", text: startTime, isSubtle: true, spacing: "None", wrap: true }]
              : []),
            { type: "TextBlock", text: notesMarkdown, wrap: true },
          ],
        },
      },
    ],
  };

  const resp = await fetch(env.TEAMS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });

  if (!resp.ok) {
    console.error("failed to post to Teams", resp.status, await resp.text());
  }
}

// ---------------------------------------------------------------------------
// Subscription lifecycle (call these manually or via /renew cron)
// ---------------------------------------------------------------------------

async function handleSubscribe(env) {
  const token = await getGraphToken(env);

  const expirationDateTime = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString(); // 3 days out — adjust after checking current max for this resource in Graph docs

  const body = {
    changeType: "created",
    notificationUrl: env.WORKER_NOTIFICATION_URL, // this worker's /webhook, publicly reachable
    resource: "communications/onlineMeetings/getAllTranscripts",
    expirationDateTime,
    clientState: env.GRAPH_CLIENT_STATE,
    // includeResourceData intentionally omitted (false) — avoids needing an
    // encryption certificate. Worker fetches transcript content itself
    // using the resource path in the notification instead.
  };

  const resp = await fetch(`${GRAPH_BASE}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (resp.ok) {
    await env.MEETING_NOTES_KV.put("graph_subscription_id", data.id);
    await env.MEETING_NOTES_KV.put("graph_subscription_expires", data.expirationDateTime);
  }

  return new Response(JSON.stringify(data, null, 2), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleRenew(env) {
  const subId = await env.MEETING_NOTES_KV.get("graph_subscription_id");
  if (!subId) {
    return new Response("no subscription on record — call /subscribe first", { status: 400 });
  }

  const token = await getGraphToken(env);
  const expirationDateTime = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3).toISOString();

  const resp = await fetch(`${GRAPH_BASE}/subscriptions/${subId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime }),
  });

  const data = await resp.json();

  if (resp.ok) {
    await env.MEETING_NOTES_KV.put("graph_subscription_expires", data.expirationDateTime);
  } else {
    console.error("renewal failed, subscription may need re-creation via /subscribe", data);
  }

  return new Response(JSON.stringify(data, null, 2), {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}
