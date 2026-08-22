const encoder = new TextEncoder();
const decoder = new TextDecoder();
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

  const bodyText = await readBodyLimited(request, MAX_BODY_BYTES);
  if (bodyText === null) return json({ error: "payload_too_large" }, 413);

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

async function readBodyLimited(request, maxBytes) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(joined);
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
    nodeQuality: normalizeSection(input?.nodeQuality),
    tcpQuality: normalizeSection(input?.tcpQuality),
    client: { version: clean(input?.client?.version, 32) || "unknown" },
  };
}

function normalizeSection(section) {
  return {
    exitCode: Number.isInteger(section?.exitCode) ? section.exitCode : null,
    log: clean(section?.log, MAX_LOG_CHARS),
  };
}

function clean(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
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

const ANSI_COLORS = {
  30: "#6b7280",
  31: "#ef4444",
  32: "#22c55e",
  33: "#eab308",
  34: "#60a5fa",
  35: "#d946ef",
  36: "#22d3ee",
  37: "#e5e7eb",
  90: "#9ca3af",
  91: "#fb7185",
  92: "#4ade80",
  93: "#fde047",
  94: "#93c5fd",
  95: "#e879f9",
  96: "#67e8f9",
  97: "#ffffff",
};

function ansiToHtml(value) {
  const input = String(value ?? "");
  const re = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let match;
  let color = "";
  let bold = false;
  let dim = false;

  const openSpan = () => {
    const styles = [];
    if (color) styles.push(`color:${color}`);
    if (bold) styles.push("font-weight:700");
    if (dim) styles.push("opacity:.72");
    return styles.length ? `<span style="${styles.join(";")}">` : "";
  };

  let spanOpen = false;
  while ((match = re.exec(input)) !== null) {
    const segment = input.slice(last, match.index);
    if (segment) out += esc(segment);
    if (spanOpen) {
      out += "</span>";
      spanOpen = false;
    }

    const codes = (match[1] || "0").split(";").map((n) => Number(n || 0));
    for (const code of codes) {
      if (code === 0) {
        color = "";
        bold = false;
        dim = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 2) {
        dim = true;
      } else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 39) {
        color = "";
      } else if (ANSI_COLORS[code]) {
        color = ANSI_COLORS[code];
      }
    }

    const start = openSpan();
    if (start) {
      out += start;
      spanOpen = true;
    }
    last = re.lastIndex;
  }

  out += esc(input.slice(last));
  if (spanOpen) out += "</span>";
  return out;
}

function sectionStatus(code) {
  if (code === null) return "unknown";
  return code === 0 ? "completed" : `exit ${code}`;
}

function reportPage(report) {
  const nq = report.nodeQuality || {};
  const tq = report.tcpQuality || {};
  return pageShell(`
    <main class="report-wrap">
      <header class="report-header">
        <div class="brand">BaseTest</div>
        <h1>VPS Test Report</h1>
        <div class="meta">${esc(report.createdAt || "")} · ${esc(report.id || "")}</div>
      </header>

      <pre class="terminal"><span class="report-label">==================== NodeQuality ====================</span>
<span class="report-state">status: ${esc(sectionStatus(nq.exitCode))}</span>

${ansiToHtml(nq.log || "No NodeQuality output captured.\n")}
<span class="report-label">===================== TcpQuality ====================</span>
<span class="report-state">status: ${esc(sectionStatus(tq.exitCode))}</span>

${ansiToHtml(tq.log || "No TcpQuality output captured.\n")}</pre>

      <footer>BaseTest · NodeQuality + TcpQuality</footer>
    </main>
  `, "BaseTest Report");
}

function homePage() {
  return pageShell(`
    <main class="landing">
      <div class="brand">BaseTest</div>
      <h1>NodeQuality + TcpQuality</h1>
      <p>One VPS test command. One BaseTest report URL.</p>
      <code>bash &lt;(curl -fsSL https://raw.githubusercontent.com/jiaotang777/BaseTest/main/run.sh)</code>
    </main>
  `, "BaseTest");
}

function notFoundPage() {
  return pageShell('<main class="landing"><div class="brand">BaseTest</div><h1>Report not found</h1><p>This report may have expired or the URL is invalid.</p></main>', "Report not found");
}

function pageShell(body, title) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  :root{color-scheme:dark;--bg:#0b0d10;--panel:#111419;--line:#2b3038;--text:#e8edf3;--muted:#8b949e;--green:#3ddc84;--yellow:#f7c948;--blue:#58a6ff}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.report-wrap{width:min(1180px,calc(100% - 28px));margin:0 auto;padding:44px 0 36px}.report-header{padding:12px 4px 30px;border-bottom:1px solid var(--line);margin-bottom:24px}.brand{font:800 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}.report-header h1,.landing h1{font-size:clamp(30px,6vw,58px);letter-spacing:-.04em;margin:12px 0 8px}.meta{color:var(--muted);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.terminal{margin:0;background:#17191d;border:1px solid var(--line);border-radius:12px;padding:20px;overflow:auto;white-space:pre;tab-size:4;color:#d7dde5;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Noto Sans Mono CJK SC",monospace;box-shadow:0 12px 30px rgba(0,0,0,.18)}.report-label{color:var(--blue);font-weight:800}.report-state{color:var(--muted)}footer{border-top:1px solid var(--line);padding-top:22px;color:var(--muted);text-align:center;font-size:12px}.landing{width:min(860px,calc(100% - 32px));margin:0 auto;padding:14vh 0}.landing p{color:var(--muted);font-size:17px}.landing code{display:block;margin-top:26px;padding:16px 18px;border:1px solid var(--line);background:var(--panel);border-radius:10px;overflow:auto;white-space:nowrap;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}@media(max-width:680px){.report-wrap{width:calc(100% - 16px);padding-top:24px}.report-header{padding-left:6px;padding-right:6px}.terminal{padding:12px;border-radius:9px;font-size:11px}.landing{padding-top:10vh}}
  </style></head><body>${body}</body></html>`;
}
