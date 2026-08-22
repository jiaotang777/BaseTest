const encoder = new TextEncoder();
const MAX_BODY_BYTES = 2_500_000;
const MAX_LOG_CHARS = 700_000;
const DEFAULT_REPORT_TTL_SECONDS = 60 * 60 * 24 * 90;
const MIN_REPORT_TTL_SECONDS = 60;
const MAX_REPORT_TTL_SECONDS = 60 * 60 * 24 * 365;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return html(homePage());
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, service: "BaseTest" });
      }

      if (request.method === "POST" && url.pathname === "/api/reports") {
        return await createReport(request, env, url.origin);
      }

      const match = url.pathname.match(/^\/r\/([A-Za-z0-9_-]{12,64})$/);
      if (request.method === "GET" && match) {
        return await renderReport(env, match[1]);
      }

      return text("Not Found", 404);
    } catch (error) {
      console.error(JSON.stringify({ event: "unhandled_error", message: String(error) }));
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function createReport(request, env, origin) {
  if (!env.REPORTS) return json({ error: "REPORTS binding is not configured" }, 500);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json({ error: "content_type_must_be_application_json" }, 415);
  }

  if (env.UPLOAD_TOKEN) {
    const auth = request.headers.get("authorization") || "";
    const expected = `Bearer ${env.UPLOAD_TOKEN}`;
    if (!(await secureEqual(auth, expected))) return json({ error: "unauthorized" }, 401);
  }

  const length = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  const bodyText = await request.text();
  if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large" }, 413);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const report = normalizeReport(body);
  if (!report.nodeQuality.log && !report.tcpQuality.log) {
    return json({ error: "empty_report" }, 400);
  }

  const id = randomId();
  report.id = id;
  report.createdAt = new Date().toISOString();

  await env.REPORTS.put(`report:${id}`, JSON.stringify(report), {
    expirationTtl: reportTtl(env.REPORT_TTL_SECONDS),
  });

  const publicBase = validPublicBase(env.PUBLIC_BASE_URL) || origin;
  return json({ id, url: `${publicBase}/r/${id}` }, 201);
}

async function renderReport(env, id) {
  if (!env.REPORTS) return text("Storage is not configured", 500);
  const report = await env.REPORTS.get(`report:${id}`, { type: "json" });
  if (!report) return html(notFoundPage(), 404);
  return html(reportPage(report), 200, {
    "cache-control": "public, max-age=60",
    "x-robots-tag": "noindex, nofollow",
  });
}

function normalizeReport(input) {
  return {
    nodeQuality: normalizeSection(input?.nodeQuality, "nodequality.com"),
    tcpQuality: normalizeSection(input?.tcpQuality, "tcpquality.ibsgss.uk"),
    client: { version: clean(input?.client?.version, 32) || "unknown" },
  };
}

function normalizeSection(section, allowedHost) {
  return {
    url: safeSourceUrl(section?.url, allowedHost),
    exitCode: Number.isInteger(section?.exitCode) ? section.exitCode : null,
    log: clean(section?.log, MAX_LOG_CHARS),
  };
}

function clean(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function safeSourceUrl(value, allowedHost) {
  if (typeof value !== "string" || !value) return "";
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    const allowed = host === allowedHost || host.endsWith(`.${allowedHost}`);
    return u.protocol === "https:" && allowed ? u.href : "";
  } catch {
    return "";
  }
}

function validPublicBase(value) {
  if (typeof value !== "string" || !value) return "";
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.origin : "";
  } catch {
    return "";
  }
}

function reportTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REPORT_TTL_SECONDS;
  return Math.min(MAX_REPORT_TTL_SECONDS, Math.max(MIN_REPORT_TTL_SECONDS, Math.trunc(parsed)));
}

function randomId() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function secureEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: securityHeaders({
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

function html(markup, status = 200, extra = {}) {
  return new Response(markup, {
    status,
    headers: securityHeaders({
      "content-type": "text/html; charset=utf-8",
      ...extra,
    }),
  });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function statusBadge(code) {
  if (code === null) return '<span class="badge neutral">unknown</span>';
  return code === 0
    ? '<span class="badge ok">completed</span>'
    : `<span class="badge bad">exit ${esc(code)}</span>`;
}

function sourceButton(url, label) {
  return url
    ? `<a class="button" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ${esc(label)} original ↗</a>`
    : '<span class="button disabled">Original URL not detected</span>';
}

function reportPage(report) {
  const nq = report.nodeQuality || {};
  const tq = report.tcpQuality || {};
  return pageShell(`
    <main class="wrap">
      <header class="hero">
        <div class="eyebrow">Unified VPS benchmark report</div>
        <h1>NodeQuality <span>×</span> TcpQuality</h1>
        <p>One report link, two complementary test suites.</p>
        <div class="meta">${esc(report.createdAt || "")} · ${esc(report.id || "")}</div>
      </header>

      <section class="grid">
        <article class="card">
          <div class="card-head"><div><small>综合质量</small><h2>NodeQuality</h2></div>${statusBadge(nq.exitCode)}</div>
          <p>Hardware, IP quality and network quality.</p>
          ${sourceButton(nq.url, "NodeQuality")}
        </article>
        <article class="card">
          <div class="card-head"><div><small>TCP 质量</small><h2>TcpQuality</h2></div>${statusBadge(tq.exitCode)}</div>
          <p>Latency, retransmission, return route and optional single-thread speed tests.</p>
          ${sourceButton(tq.url, "TcpQuality")}
        </article>
      </section>

      <section class="logs">
        <details open>
          <summary><span>NodeQuality terminal output</span><span class="chev">⌄</span></summary>
          <pre>${esc(nq.log || "No output captured.")}</pre>
        </details>
        <details>
          <summary><span>TcpQuality terminal output</span><span class="chev">⌄</span></summary>
          <pre>${esc(tq.log || "No output captured.")}</pre>
        </details>
      </section>

      <footer>Generated by BaseTest · Upstream projects remain credited to their original authors.</footer>
    </main>
  `, "BaseTest");
}

function homePage() {
  return pageShell(`
    <main class="wrap"><header class="hero"><div class="eyebrow">Unified benchmark</div><h1>NodeQuality <span>×</span> TcpQuality</h1><p>Run both VPS test suites and publish a single report URL under basetest.aniya.site.</p></header></main>
  `, "BaseTest");
}

function notFoundPage() {
  return pageShell('<main class="wrap"><header class="hero"><div class="eyebrow">404</div><h1>Report not found</h1><p>This report may have expired or the URL is invalid.</p></header></main>', "Report not found");
}

function pageShell(body, title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{color-scheme:dark;--bg:#090b10;--panel:#11151d;--line:#242b38;--text:#f4f7fb;--muted:#99a3b2;--accent:#c8ff5a;--blue:#7cb8ff;--bad:#ff7b7b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -10%,#1b2330 0,transparent 36%),var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{width:min(1080px,calc(100% - 32px));margin:0 auto;padding:72px 0 36px}.hero{text-align:center;margin-bottom:34px}.eyebrow{color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.hero h1{font-size:clamp(34px,7vw,68px);line-height:1;margin:14px 0 16px;letter-spacing:-.045em}.hero h1 span{color:var(--muted);font-weight:400}.hero p,.meta{color:var(--muted)}.meta{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:10px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.card,.logs details{background:rgba(17,21,29,.82);border:1px solid var(--line);border-radius:18px;box-shadow:0 16px 50px rgba(0,0,0,.22);backdrop-filter:blur(16px)}.card{padding:22px}.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.card small{color:var(--muted)}.card h2{margin:0;font-size:25px}.card p{color:var(--muted);min-height:48px}.badge{display:inline-flex;padding:4px 9px;border-radius:999px;font-size:12px;font-weight:700;background:#202632;color:var(--muted)}.badge.ok{background:#1d2b16;color:var(--accent)}.badge.bad{background:#321d22;color:var(--bad)}.button{display:inline-flex;text-decoration:none;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:8px 11px;font-weight:700}.button:hover{border-color:#475164}.button.disabled{color:#677181}.logs{margin-top:16px;display:grid;gap:12px}.logs details{overflow:hidden}.logs summary{cursor:pointer;display:flex;justify-content:space-between;padding:15px 18px;font-weight:800}.logs pre{margin:0;border-top:1px solid var(--line);padding:18px;max-height:680px;overflow:auto;background:#080a0f;color:#cbd3df;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}footer{text-align:center;color:#667080;font-size:12px;padding:28px 0}@media(max-width:720px){.wrap{padding-top:42px}.grid{grid-template-columns:1fr}.card p{min-height:0}}
  </style></head><body>${body}</body></html>`;
}
