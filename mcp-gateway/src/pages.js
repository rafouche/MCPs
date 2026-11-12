export var esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export var STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#14171a;--muted:#5b6470;--line:#d9dde3;--accent:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--card:#1a1d21;--ink:#e8eaed;--muted:#9aa3ad;--line:#2c3138;--accent:#6aa0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:460px;margin:8vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{font-size:19px;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}.warn{border-left:3px solid #c77700;padding-left:10px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}code{font-size:13px}`;
export function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main><div class="card">${body}</div>
<p class="muted" style="text-align:center">Altec MCP Gateway</p></main></body></html>`;
}
export function consentPage(d, handle, serverName2) {
  const who = d.clientDomain ? `Published by <strong>${esc(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified.";
  const loop = d.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>' : "";
  return shell(
    `Allow ${d.clientName}?`,
    `<h1>Allow <strong>${esc(d.clientName)}</strong> to use ${esc(serverName2)}?</h1>
<p>${who}</p>
<p>Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>${loop}
<p class="muted">You will sign in with your Altec Microsoft account next. What you can do is set by your assigned role; most access is read-only.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Continue</button></div></form>`
  );
}
export function errorPage(title, message, status = 400) {
  return new Response(shell(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Cache-Control": "no-store"
    }
  });
}

