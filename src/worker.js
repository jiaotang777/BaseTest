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

      if (request.method === "GET" && url.pathname === "/assets/report.js") {
        return javascript(REPORT_JS);
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

  report.stats = await nextBaseTestStats(
    env,
    report.createdAt
  );

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
    "cache-control": "no-store",
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


function beijingDay(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const bj = new Date(
    date.getTime() + 8 * 60 * 60 * 1000
  );

  return bj.toISOString().slice(0, 10);
}

async function nextBaseTestStats(env, createdAt) {
  const day = beijingDay(createdAt);

  const dailyKey = `basetest:stats:daily:${day}`;
  const totalKey = "basetest:stats:total";

  let daily = Number(
    await env.REPORTS.get(dailyKey)
  );

  let total = Number(
    await env.REPORTS.get(totalKey)
  );

  if (!Number.isInteger(daily) || daily < 0) {
    daily = 0;
  }

  if (!Number.isInteger(total) || total < 0) {
    total = 0;
  }

  daily += 1;
  total += 1;

  await Promise.all([
    env.REPORTS.put(
      dailyKey,
      String(daily)
    ),

    env.REPORTS.put(
      totalKey,
      String(total)
    ),
  ]);

  return {
    daily,
    total,
  };
}

function formatReportTime(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "—";
  }

  const bj = new Date(
    date.getTime() + 8 * 60 * 60 * 1000
  );

  return (
    bj.toISOString()
      .slice(0, 19)
      .replace("T", " ")
    + " CST（北京时间）"
  );
}

function reportStatsMarkup(report, type, hidden = false) {
  const daily =
    Number.isInteger(report?.stats?.daily)
      ? report.stats.daily
      : "—";

  const total =
    Number.isInteger(report?.stats?.total)
      ? report.stats.total
      : "—";

  return `
    <div
      class="report-stats ${esc(type)}"
      data-report-stats="${esc(type)}"
      ${hidden ? "hidden" : ""}
    >
      <div>
        报告时间：${esc(formatReportTime(report.createdAt))}
      </div>

      <div>
        今日报告次数：${esc(daily)}
        <span class="stats-gap"></span>
        累计报告次数：${esc(total)}
      </div>
    </div>
  `;
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
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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

function javascript(value) {
  return new Response(value, {
    status: 200,
    headers: securityHeaders({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
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

const ANSI_16 = [
  "#111827", "#ef4444", "#22c55e", "#eab308", "#3b82f6", "#d946ef", "#06b6d4", "#d1d5db",
  "#6b7280", "#fb7185", "#4ade80", "#fde047", "#93c5fd", "#e879f9", "#67e8f9", "#ffffff",
];

function xtermColor(n) {
  const value = Number(n);
  if (!Number.isInteger(value) || value < 0 || value > 255) return "";
  if (value < 16) return ANSI_16[value];
  if (value >= 232) {
    const c = 8 + (value - 232) * 10;
    return `rgb(${c},${c},${c})`;
  }
  const x = value - 16;
  const r = Math.floor(x / 36);
  const g = Math.floor((x % 36) / 6);
  const b = x % 6;
  const cv = (v) => (v === 0 ? 0 : 55 + v * 40);
  return `rgb(${cv(r)},${cv(g)},${cv(b)})`;
}

function ansiToHtml(value) {
  const input = String(value ?? "");
  const re = /\x1b\[([0-9;]*)m/g;
  let out = "";
  let last = 0;
  let match;
  let fg = "";
  let bg = "";
  let bold = false;
  let dim = false;
  let underline = false;
  let inverse = false;

  const reset = () => {
    fg = "";
    bg = "";
    bold = false;
    dim = false;
    underline = false;
    inverse = false;
  };

  const openSpan = () => {
    let useFg = fg;
    let useBg = bg;
    if (inverse) [useFg, useBg] = [useBg || "#0b0d10", useFg || "#e8edf3"];
    const styles = [];
    if (useFg) styles.push(`color:${useFg}`);
    if (useBg) styles.push(`background-color:${useBg}`);
    if (bold) styles.push("font-weight:700");
    if (dim) styles.push("opacity:.72");
    if (underline) styles.push("text-decoration:underline");
    return styles.length ? `<span style="${styles.join(";")}">` : "";
  };

  let spanOpen = false;
  while ((match = re.exec(input)) !== null) {
    if (match.index > last) out += esc(input.slice(last, match.index));
    if (spanOpen) {
      out += "</span>";
      spanOpen = false;
    }

    const codes = (match[1] || "0").split(";").map((n) => Number(n || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) reset();
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 4) underline = true;
      else if (code === 7) inverse = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 24) underline = false;
      else if (code === 27) inverse = false;
      else if (code === 39) fg = "";
      else if (code === 49) bg = "";
      else if (code >= 30 && code <= 37) fg = ANSI_16[code - 30];
      else if (code >= 90 && code <= 97) fg = ANSI_16[8 + code - 90];
      else if (code >= 40 && code <= 47) bg = ANSI_16[code - 40];
      else if (code >= 100 && code <= 107) bg = ANSI_16[8 + code - 100];
      else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isInteger(codes[i + 2])) {
        const color = xtermColor(codes[i + 2]);
        if (code === 38) fg = color; else bg = color;
        i += 2;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && codes.length > i + 4) {
        const r = Math.max(0, Math.min(255, codes[i + 2] || 0));
        const g = Math.max(0, Math.min(255, codes[i + 3] || 0));
        const b = Math.max(0, Math.min(255, codes[i + 4] || 0));
        const color = `rgb(${r},${g},${b})`;
        if (code === 38) fg = color; else bg = color;
        i += 4;
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

function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function splitNodeQuality(log) {
  const buckets = {
    basic: [],
    ip: [],
    network: [],
    route: [],
  };

  const raw = String(log || "");
  let current = "";

  for (const rawLine of raw.split("\n")) {
    const line = stripAnsi(rawLine).trim();

    if (/^(正在运行硬件质量测试|Running\s+Hardware\s+Quality\s+Test)/i.test(line)) {
      current = "basic";
      continue;
    }

    if (/^(正在运行\s*IP\s*质量测试|Running\s+IP\s+Quality\s+Test)/i.test(line)) {
      current = "ip";
      continue;
    }

    if (/^(正在运行网络质量测试|Running\s+Network\s+Quality\s+Test)/i.test(line)) {
      current = "network";
      continue;
    }

    if (/^(正在运行回程路由追踪|Running\s+Backroute\s+Trace)/i.test(line)) {
      current = "route";
      continue;
    }

    // 测试真正开始之前的 Logo、安装、下载、清理信息全部丢弃
    if (!current) continue;

    buckets[current].push(rawLine);
  }

  for (const key of Object.keys(buckets)) {
    buckets[key] = buckets[key].join("\n").trim();
  }

  return buckets;
}

function splitTcpQuality(log) {
  const buckets = {
    ipv4: [],
    large4: [],
    ipv6: [],
    education: [],
    international: [],
    speedtest: [],
  };

  let current = "";
  const allLines = String(log || "").split("\n");

  // TcpQuality 在测试过程中也会输出进度。
  // 这里只从最后一次“报告时间”之后解析最终报告，避免混入测试进度。
  let start = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (/报告时间[:：]/.test(stripAnsi(allLines[i]))) {
      start = i + 1;
    }
  }

  const lines = allLines.slice(start);

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();

    if (
      /^(报告时间|报告链接|今日TCP脚本使用次数|今日报告次数|总使用次数|累计报告次数|感谢使用)/.test(line)
    ) {
      continue;
    }

    if (/^IPv4回程\s+统计摘要/.test(line)) {
      current = "ipv4";
    } else if (/^IPv4大包回程\s+统计摘要/.test(line)) {
      current = "large4";
    } else if (/^IPv6回程\s+统计摘要/.test(line)) {
      current = "ipv6";
    } else if (/^(?:教育网回程|CERNET-IPv4|CERNET2-IPv6)\s+统计摘要/.test(line)) {
      current = "education";
    } else if (/^(?:国际节点TCP互联测试|常用网站\s+国际互联|常用\s+CDN\s+国际互联)/.test(line)) {
      current = "international";
    } else if (/^单线程测速$/.test(line)) {
      current = "speedtest";
    }

    if (current) {
      buckets[current].push(rawLine);
    }
  }

  for (const key of Object.keys(buckets)) {
    buckets[key] = buckets[key].join("\n").trim();
  }

  return buckets;
}

function normalizePlain(value) {
  return stripAnsi(value)
    .replace(/\r/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function buildPlainReport(parts) {
  const blocks = [];

  for (const key of [
    "basic",
    "ip",
    "network",
    "route",
    "tcpIpv4",
    "tcpLarge4",
    "tcpIpv6",
    "tcpEducation",
    "tcpInternational",
    "tcpSpeedtest",
  ]) {
    if (parts[key]) blocks.push(parts[key]);
  }

  return normalizePlain(blocks.join("\n\n"));
}

function buildNodeSeekReport(parts) {
  const plain = buildPlainReport(parts);
  return `[code]\n${plain}\n[/code]`;
}

function buildMarkdownReport(parts) {
  const blocks = [];
  const add = (title, value) => {
    const textValue = normalizePlain(value);
    if (!textValue) return;
    blocks.push(`## ${title}\n\n\`\`\`text\n${textValue}\n\`\`\``);
  };
  add("基本信息", parts.basic);
  add("IP质量", parts.ip);
  add("网络质量", parts.network);
  add("回程路由", parts.route);
  add("IPv4回程", parts.tcpIpv4);
  add("IPv4大包回程", parts.tcpLarge4);
  add("IPv6回程", parts.tcpIpv6);
  add("教育网回程", parts.tcpEducation);
  add("国际互联", parts.tcpInternational);
  add("单线程测速", parts.tcpSpeedtest);
  return `# BaseTest\n\n${blocks.join("\n\n")}`;
}

function sectionMarkup(
  key,
  title,
  source,
  value,
  index,
  report
) {
  const content = String(value || "").trim();

  const stats = content
    ? reportStatsMarkup(
        report,
        "section-report-stats",
        true
      )
    : "";

  return `
    <section
      class="report-section"
      data-section="${esc(key)}"
      data-has-content="${content ? "1" : "0"}"
    >
      <div class="section-head">
        <span class="section-no">
          ${String(index).padStart(2, "0")}
        </span>

        <h2>${esc(title)}</h2>

        <span class="section-source">
          ${esc(source)}
        </span>
      </div>

      <pre class="report-output${content ? "" : " empty-output"}">${content ? ansiToHtml(content) : ""}</pre>

      ${stats}
    </section>
  `;
}

function reportPage(report) {
  const nq = report.nodeQuality || {};
  const tq = report.tcpQuality || {};
  const node = splitNodeQuality(nq.log || "");
  const tcp = splitTcpQuality(tq.log || "");

  const parts = {
    basic: node.basic,
    ip: node.ip,
    network: node.network,
    route: node.route,

    tcpIpv4: tcp.ipv4,
    tcpLarge4: tcp.large4,
    tcpIpv6: tcp.ipv6,
    tcpEducation: tcp.education,
    tcpInternational: tcp.international,
    tcpSpeedtest: tcp.speedtest,
  };
  const plain = buildPlainReport(parts);
  const nodeSeek = buildNodeSeekReport(parts);
  const markdown = buildMarkdownReport(parts);

  const hasAnyContent = Object.values(parts).some(
    (value) => String(value || "").trim()
  );

  // 板块固定显示，不因为没有数据而隐藏。
  const available = [
    ["basic", "基本信息"],
    ["ip", "IP质量"],
    ["network", "网络质量"],
    ["route", "回程路由"],

    ["tcp-ipv4", "IPv4回程"],
    ["tcp-large4", "IPv4大包回程"],
    ["tcp-ipv6", "IPv6回程"],
    ["tcp-education", "教育网回程"],
    ["tcp-international", "国际互联"],
    ["tcp-speedtest", "单线程测速"],
  ];

  const tabs = available
    .map(([key, label]) => `<button class="tab" type="button" role="tab" data-report-tab="${esc(key)}">${esc(label)}</button>`)
    .join("");

  const sectionDefs = [
    ["basic", "基本信息", "NodeQuality", parts.basic],
    ["ip", "IP质量", "NodeQuality", parts.ip],
    ["network", "网络质量", "NodeQuality", parts.network],
    ["route", "回程路由", "NodeQuality", parts.route],

    ["tcp-ipv4", "IPv4回程", "TcpQuality", parts.tcpIpv4],
    ["tcp-large4", "IPv4大包回程", "TcpQuality", parts.tcpLarge4],
    ["tcp-ipv6", "IPv6回程", "TcpQuality", parts.tcpIpv6],
    ["tcp-education", "教育网回程", "TcpQuality", parts.tcpEducation],
    ["tcp-international", "国际互联", "TcpQuality", parts.tcpInternational],
    ["tcp-speedtest", "单线程测速", "TcpQuality", parts.tcpSpeedtest],
  ];

  const sections = sectionDefs
    .filter(([, , , value]) => String(value || "").trim())
    .map(
      ([key, title, source, value], index) =>
        sectionMarkup(
          key,
          title,
          source,
          value,
          index + 1,
          report
        )
    )
    .join("");

  const nodeFailed = nq.exitCode !== null && nq.exitCode !== 0;
  const tcpFailed = tq.exitCode !== null && tq.exitCode !== 0;
  const warnings = [
    nodeFailed ? `NodeQuality exit ${nq.exitCode}` : "",
    tcpFailed ? `TcpQuality exit ${tq.exitCode}` : "",
  ].filter(Boolean);

  return pageShell(`
    <header class="sitebar">
      <div class="sitebar-inner">
        <a class="wordmark" href="/">BaseTest</a>
        <a class="repo-link" href="https://github.com/jiaotang777/BaseTest" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
      </div>
    </header>

    <main class="viewer">
      <header class="viewer-head">
        <div>
          <div class="kicker">NodeQuality × TcpQuality</div>
          <h1>BaseTest 报告</h1>
          <p class="meta">${esc(report.createdAt || "")} · ${esc(report.id || "")}</p>
        </div>
        <div class="state ${warnings.length ? "warn" : "ok"}">${warnings.length ? esc(warnings.join(" · ")) : "测试完成"}</div>
      </header>

      <section class="actions" aria-label="报告操作">
        <button type="button" class="action" data-copy-target="copy-plain"><strong>复制文本</strong><span>复制普通文本</span></button>
        <button type="button" class="action" data-copy-target="copy-nodeseek"><strong>复制为NodeSeek格式</strong><span>论坛代码格式</span></button>
        <button type="button" class="action" data-copy-target="copy-markdown"><strong>复制为通用Markdown</strong><span>Markdown 文本</span></button>
        <button type="button" class="action" data-copy-link><strong>复制链接</strong><span>当前 BaseTest 报告</span></button>
      </section>

      <nav class="tabs" role="tablist" aria-label="报告分类">
        <button class="tab active" type="button" role="tab" aria-selected="true" data-report-tab="all">全部</button>
        ${tabs}
      </nav>

      <div
        class="report-document"
        ${hasAnyContent ? "" : "hidden"}
      >
        ${sections}

        ${
          hasAnyContent
            ? reportStatsMarkup(
                report,
                "all-report-stats",
                false
              )
            : ""
        }
      </div>

      <textarea id="copy-plain" class="copy-buffer" aria-hidden="true">${esc(plain)}</textarea>
      <textarea id="copy-nodeseek" class="copy-buffer" aria-hidden="true">${esc(nodeSeek)}</textarea>
      <textarea id="copy-markdown" class="copy-buffer" aria-hidden="true">${esc(markdown)}</textarea>
      <div class="toast" role="status" aria-live="polite"></div>
    </main>

    <footer class="footer">BaseTest · 结果直接由 basetest.aniya.site 展示</footer>
    <script src="/assets/report.js" defer></script>
  `, "BaseTest Report");
}

function homePage() {
  return pageShell(`
    <header class="sitebar"><div class="sitebar-inner"><a class="wordmark" href="/">BaseTest</a><a class="repo-link" href="https://github.com/jiaotang777/BaseTest" target="_blank" rel="noopener noreferrer">GitHub ↗</a></div></header>
    <main class="landing">
      <div class="kicker">NodeQuality × TcpQuality</div>
      <h1>一个命令，一份报告。</h1>
      <p>一次选择测试项目，完整结果统一显示在 BaseTest。</p>
      <code>bash &lt;(curl -fsSL https://raw.githubusercontent.com/jiaotang777/BaseTest/main/run.sh)</code>
    </main>
  `, "BaseTest");
}

function notFoundPage() {
  return pageShell('<main class="landing"><div class="kicker">404</div><h1>Report not found</h1><p>报告不存在、已经过期，或地址无效。</p></main>', "Report not found");
}

function pageShell(body, title) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)}</title><style>
  :root{color-scheme:dark;--bg:#0d0f12;--surface:#14171c;--surface2:#191d23;--line:#2a3038;--line2:#363d47;--text:#e7ebf0;--muted:#8c96a3;--soft:#b7c0cb;--green:#42d392;--green-bg:#14261f;--yellow:#f0c66b;--yellow-bg:#292217;--blue:#73a7ff;--shadow:0 18px 50px rgba(0,0,0,.24)}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.sitebar{border-bottom:1px solid var(--line);background:rgba(13,15,18,.92);position:sticky;top:0;z-index:20;backdrop-filter:blur(14px)}.sitebar-inner{height:56px;width:min(1080px,calc(100% - 28px));margin:0 auto;display:flex;align-items:center;justify-content:space-between}.wordmark{color:var(--text);font-weight:850;letter-spacing:-.02em;text-decoration:none;font-size:17px}.wordmark:before{content:"●";color:var(--green);font-size:10px;margin-right:9px;vertical-align:2px}.repo-link{color:var(--muted);text-decoration:none;font-size:13px}.repo-link:hover{color:var(--text)}.viewer{width:min(1080px,calc(100% - 28px));margin:0 auto;padding:34px 0 26px}.viewer-head{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-bottom:22px}.kicker{font:750 11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--green);letter-spacing:.13em;text-transform:uppercase}.viewer-head h1,.landing h1{font-size:clamp(30px,5vw,48px);letter-spacing:-.045em;line-height:1.05;margin:9px 0 8px}.meta{margin:0;color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.state{flex:none;border:1px solid #23543f;background:var(--green-bg);color:var(--green);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:750}.state.warn{border-color:#5b4924;background:var(--yellow-bg);color:var(--yellow)}.actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow);margin-bottom:18px}.action{appearance:none;text-align:left;border:0;border-right:1px solid var(--line);background:transparent;color:var(--text);padding:13px 15px;cursor:pointer;min-height:64px}.action:last-child{border-right:0}.action:hover{background:var(--surface2)}.action strong,.action span{display:block}.action strong{font-size:13px}.action span{font-size:11px;color:var(--muted);margin-top:3px}.tabs{display:flex;flex-wrap:wrap;gap:7px;overflow:visible;padding:0 0 10px}.tabs::-webkit-scrollbar{display:none}.tab{appearance:none;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:7px 13px;white-space:nowrap;font-weight:700;font-size:12px;cursor:pointer}.tab:hover{border-color:var(--line2);color:var(--text)}.tab.active{background:var(--text);border-color:var(--text);color:#0d0f12}.report-document{border:1px solid var(--line);border-radius:12px;background:#101216;box-shadow:var(--shadow);overflow:hidden}.report-section{padding:0 18px}.report-section+.report-section{border-top:1px solid var(--line)}.section-head{height:52px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(42,48,56,.55)}.section-no{font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#596370}.section-head h2{font-size:14px;margin:0;letter-spacing:.01em}.section-source{margin-left:auto;color:var(--muted);font:10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.report-output{margin:0;padding:17px 0 23px;overflow-x:auto;white-space:pre;tab-size:4;color:#d8dee8;font:12px/1.48 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Noto Sans Mono CJK SC",monospace}.report-output.empty-output{min-height:58px}.report-section[hidden]{display:none}.report-document[hidden]{display:none}.report-stats{border-top:1px solid var(--line);padding:14px 18px 16px;text-align:center;color:var(--muted);font:600 12px/1.9 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.all-report-stats{margin:0}.section-report-stats{margin:0 -18px}.report-stats[hidden]{display:none}.stats-gap{display:inline-block;width:24px}.empty{padding:40px;text-align:center;color:var(--muted)}.copy-buffer{position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none}.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,18px);background:#eef2f6;color:#111827;border-radius:999px;padding:8px 13px;font-size:12px;font-weight:750;opacity:0;pointer-events:none;transition:.18s ease;z-index:50;box-shadow:0 10px 30px rgba(0,0,0,.28)}.toast.show{opacity:1;transform:translate(-50%,0)}.footer{width:min(1080px,calc(100% - 28px));margin:0 auto;border-top:1px solid var(--line);padding:20px 0 32px;color:#65707d;text-align:center;font-size:11px}.landing{width:min(860px,calc(100% - 32px));margin:0 auto;padding:14vh 0}.landing p{color:var(--muted);font-size:16px}.landing code{display:block;margin-top:26px;padding:16px 18px;border:1px solid var(--line);background:var(--surface);border-radius:10px;overflow:auto;white-space:nowrap;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}@media(max-width:760px){.viewer{width:calc(100% - 16px);padding-top:23px}.sitebar-inner,.footer{width:calc(100% - 20px)}.viewer-head{align-items:flex-start;flex-direction:column;gap:12px}.actions{grid-template-columns:repeat(2,minmax(0,1fr))}.action:nth-child(2){border-right:0}.action:nth-child(-n+2){border-bottom:1px solid var(--line)}.report-section{padding:0 10px}.section-report-stats{margin-left:-10px;margin-right:-10px;padding-left:10px;padding-right:10px}.section-head{height:47px}.report-output{font-size:10.5px;line-height:1.45;padding-top:14px;padding-bottom:18px}.tabs{margin-left:-2px}.landing{padding-top:10vh}}@media(max-width:430px){.actions{box-shadow:none}.action{padding:11px 12px;min-height:58px}.action strong{font-size:12px}.action span{font-size:10px}.viewer-head h1{font-size:34px}}
  </style></head><body>${body}</body></html>`;
}

const REPORT_JS = `(() => {
  const tabs = Array.from(document.querySelectorAll('[data-report-tab]'));
  const sections = Array.from(document.querySelectorAll('[data-section]'));
  const reportDocument = document.querySelector('.report-document');
  const toast = document.querySelector('.toast');

  const allStats = document.querySelector(
    '[data-report-stats="all-report-stats"]'
  );
  let toastTimer = 0;

  function notify(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
  }

  function selectTab(key) {
    tabs.forEach((tab) => {
      const active = tab.dataset.reportTab === key;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    let visibleSections = 0;

    sections.forEach((section) => {
      const selected =
        key === 'all' ||
        section.dataset.section === key;

      section.hidden = !selected;

      if (selected) {
        visibleSections += 1;
      }

      const stats = section.querySelector(
        '[data-report-stats="section-report-stats"]'
      );

      if (stats) {
        stats.hidden =
          key === 'all' ||
          section.dataset.section !== key;
      }
    });

    if (allStats) {
      allStats.hidden = key !== 'all';
    }

    if (reportDocument) {
      reportDocument.hidden =
        key === 'all'
          ? sections.length === 0
          : visibleSections === 0;
    }
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.reportTab)));

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const temp = document.createElement('textarea');
    temp.value = value;
    temp.style.position = 'fixed';
    temp.style.opacity = '0';
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    temp.remove();
  }

  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copyTarget);
      if (!target) return;
      try {
        await copyText(target.value);
        notify('已复制');
      } catch {
        notify('复制失败');
      }
    });
  });

  const linkButton = document.querySelector('[data-copy-link]');
  if (linkButton) {
    linkButton.addEventListener('click', async () => {
      try {
        await copyText(location.href);
        notify('报告链接已复制');
      } catch {
        notify('复制失败');
      }
    });
  }
})();`;
