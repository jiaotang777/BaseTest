import baseWorker from "./worker.js";

const RUN_URL =
  "https://raw.githubusercontent.com/jiaotang777/BaseTest/main/run.sh";

const NORMAL_COMMAND =
  `curl -fsSL ${RUN_URL} | sudo bash`;

const ROOT_COMMAND =
  `bash <(curl -fsSL ${RUN_URL})`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 只接管首页和首页 JS。
    // 报告、API、healthz 等继续由原 worker.js 处理。
    if (request.method === "GET" && url.pathname === "/") {
      return html(homePage());
    }

    if (
      request.method === "GET" &&
      url.pathname === "/assets/home.js"
    ) {
      return javascript(HOME_JS);
    }

    return baseWorker.fetch(request, env, ctx);
  },
};

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=()",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; " +
      "script-src 'self'; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'none'",
    ...extra,
  };
}

function html(markup) {
  return new Response(markup, {
    status: 200,
    headers: securityHeaders({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

function javascript(value) {
  return new Response(value, {
    status: 200,
    headers: securityHeaders({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    }),
  });
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch]
  );
}

function commandCard({
  id,
  prompt,
  title,
  subtitle,
  command,
  recommended = false,
}) {
  return `
    <article class="command-card${recommended ? " recommended" : ""}">
      <div class="command-head">
        <div class="command-user">
          <span class="prompt-badge">${esc(prompt)}</span>

          <div>
            <div class="title-row">
              <h2>${esc(title)}</h2>
              ${
                recommended
                  ? '<span class="recommend">推荐</span>'
                  : ""
              }
            </div>

            <p>${esc(subtitle)}</p>
          </div>
        </div>

        <button
          type="button"
          class="copy-button"
          data-copy="${esc(id)}"
        >
          复制命令
        </button>
      </div>

      <button
        type="button"
        class="command-box"
        data-copy="${esc(id)}"
        aria-label="复制${esc(title)}命令"
      >
        <span class="terminal-prompt">${esc(prompt)}</span>

        <code id="${esc(id)}">${esc(command)}</code>

        <span class="copy-icon">⧉</span>
      </button>

      <div class="paste-status">
        <span class="status-dot"></span>

        <span class="status-text">
          点击复制，然后回到 SSH 终端粘贴运行
        </span>

        <span class="paste-ready">
          READY
        </span>
      </div>
    </article>
  `;
}

function homePage() {
  const normalCard = commandCard({
    id: "command-normal",
    prompt: "$",
    title: "普通用户",
    subtitle:
      "ubuntu / debian / ec2-user 等非 root 登录账户",
    command: NORMAL_COMMAND,
    recommended: true,
  });

  const rootCard = commandCard({
    id: "command-root",
    prompt: "#",
    title: "root 用户",
    subtitle:
      "已经执行 sudo -i，或者当前终端提示符是 #",
    command: ROOT_COMMAND,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<meta name="color-scheme" content="dark">
<title>BaseTest</title>

<style>
:root{
  color-scheme:dark;
  --bg:#0d0f12;
  --surface:#14171c;
  --surface2:#191d23;
  --line:#2a3038;
  --line2:#363d47;
  --text:#e7ebf0;
  --muted:#8c96a3;
  --soft:#b7c0cb;
  --green:#42d392;
  --green-bg:#14261f;
  --yellow:#f0c66b;
  --shadow:0 18px 50px rgba(0,0,0,.24);
}

*{box-sizing:border-box}

html{background:var(--bg)}

body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    "PingFang SC",
    "Microsoft YaHei",
    sans-serif;
}

button{font:inherit}

.sitebar{
  border-bottom:1px solid var(--line);
  background:rgba(13,15,18,.92);
  position:sticky;
  top:0;
  z-index:20;
  backdrop-filter:blur(14px);
}

.sitebar-inner{
  height:56px;
  width:min(1080px,calc(100% - 28px));
  margin:0 auto;
  display:flex;
  align-items:center;
  justify-content:space-between;
}

.wordmark{
  color:var(--text);
  font-weight:850;
  letter-spacing:-.02em;
  text-decoration:none;
  font-size:17px;
}

.wordmark:before{
  content:"●";
  color:var(--green);
  font-size:10px;
  margin-right:9px;
  vertical-align:2px;
}

.repo-link{
  color:var(--muted);
  text-decoration:none;
  font-size:13px;
}

.repo-link:hover{
  color:var(--text);
}

.landing{
  width:min(900px,calc(100% - 32px));
  margin:0 auto;
  padding:10vh 0 8vh;
}

.kicker{
  font:
    750 11px/1.3
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  color:var(--green);
  letter-spacing:.13em;
  text-transform:uppercase;
}

h1{
  font-size:clamp(34px,6vw,54px);
  letter-spacing:-.05em;
  line-height:1.02;
  margin:10px 0 12px;
}

.lead{
  max-width:700px;
  margin:0;
  color:var(--muted);
  font-size:16px;
  line-height:1.75;
}

.command-list{
  display:grid;
  gap:14px;
  margin-top:32px;
}

.command-card{
  border:1px solid var(--line);
  background:
    linear-gradient(
      180deg,
      #15181d,
      #111419
    );
  border-radius:14px;
  overflow:hidden;
  box-shadow:var(--shadow);
  transition:
    border-color .18s ease,
    box-shadow .18s ease,
    transform .18s ease;
}

.command-card.recommended{
  border-color:#2c4d40;
}

.command-card.copied{
  border-color:#3a8b69;
  box-shadow:
    0 0 0 1px rgba(66,211,146,.16),
    0 18px 52px rgba(0,0,0,.3);
  transform:translateY(-1px);
}

.command-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:18px;
  padding:16px 17px 13px;
}

.command-user{
  display:flex;
  align-items:center;
  gap:12px;
  min-width:0;
}

.prompt-badge{
  width:35px;
  height:35px;
  border:1px solid var(--line2);
  border-radius:9px;
  display:grid;
  place-items:center;
  flex:none;
  background:#0d1014;
  color:var(--green);
  font:
    800 15px/1
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}

.title-row{
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}

.title-row h2{
  margin:0;
  font-size:14px;
}

.command-head p{
  margin:4px 0 0;
  color:var(--muted);
  font-size:11px;
  line-height:1.45;
}

.recommend{
  border:1px solid #23543f;
  background:var(--green-bg);
  color:var(--green);
  border-radius:999px;
  padding:3px 7px;
  font-size:9px;
  font-weight:800;
  letter-spacing:.08em;
}

.copy-button{
  appearance:none;
  border:1px solid var(--line2);
  background:var(--surface2);
  color:var(--soft);
  border-radius:8px;
  padding:8px 11px;
  cursor:pointer;
  font-size:11px;
  font-weight:750;
  white-space:nowrap;
}

.copy-button:hover{
  color:var(--text);
  border-color:#4a535f;
}

.command-card.copied .copy-button{
  border-color:#2f6e55;
  background:var(--green-bg);
  color:var(--green);
}

.command-box{
  appearance:none;
  width:calc(100% - 34px);
  margin:0 17px;
  border:1px solid var(--line);
  background:#0b0e12;
  color:#dbe2ea;
  border-radius:10px;
  padding:14px;
  display:grid;
  grid-template-columns:auto minmax(0,1fr) auto;
  align-items:center;
  gap:11px;
  text-align:left;
  cursor:pointer;
  overflow:hidden;
}

.command-box:hover{
  border-color:var(--line2);
}

.terminal-prompt{
  color:var(--green);
  font:
    800 12px/1
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}

.command-box code{
  overflow:auto;
  white-space:nowrap;
  scrollbar-width:none;
  font:
    12px/1.5
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}

.command-box code::-webkit-scrollbar{
  display:none;
}

.copy-icon{
  color:#596370;
  font-size:17px;
}

.command-card.copied .copy-icon{
  color:var(--green);
}

.paste-status{
  min-height:41px;
  padding:10px 18px 12px;
  display:flex;
  align-items:center;
  gap:8px;
  color:#707b88;
  font:
    650 10px/1.4
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}

.status-dot{
  width:6px;
  height:6px;
  border-radius:50%;
  background:#4b5563;
  box-shadow:
    0 0 0 3px rgba(75,85,99,.12);
  flex:none;
}

.paste-ready{
  margin-left:auto;
  border:1px solid var(--line);
  border-radius:999px;
  padding:4px 7px;
  color:#596370;
  font-size:8px;
  letter-spacing:.08em;
}

.command-card.copied .paste-status{
  color:var(--green);
}

.command-card.copied .status-dot{
  background:var(--green);
  box-shadow:
    0 0 0 4px rgba(66,211,146,.12);
  animation:pulse 1s ease infinite;
}

.command-card.copied .paste-ready{
  border-color:#2b624d;
  color:var(--green);
}

.helper{
  display:flex;
  align-items:flex-start;
  gap:10px;
  margin:19px 2px 0;
  color:var(--muted);
  font-size:12px;
  line-height:1.7;
}

.helper-mark{
  color:var(--yellow);
}

.helper code{
  color:var(--soft);
  font:
    11px
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}

.toast{
  position:fixed;
  left:50%;
  bottom:24px;
  transform:translate(-50%,18px);
  background:#eef2f6;
  color:#111827;
  border-radius:999px;
  padding:8px 13px;
  font-size:12px;
  font-weight:750;
  opacity:0;
  pointer-events:none;
  transition:.18s ease;
  z-index:50;
  box-shadow:
    0 10px 30px rgba(0,0,0,.28);
}

.toast.show{
  opacity:1;
  transform:translate(-50%,0);
}

.footer{
  width:min(1080px,calc(100% - 28px));
  margin:0 auto;
  border-top:1px solid var(--line);
  padding:20px 0 32px;
  color:#65707d;
  text-align:center;
  font-size:11px;
}

@keyframes pulse{
  0%,100%{opacity:1}
  50%{opacity:.4}
}

@media(max-width:680px){
  .landing{
    padding-top:8vh;
  }

  .command-head{
    padding-left:13px;
    padding-right:13px;
  }

  .command-box{
    width:calc(100% - 24px);
    margin:0 12px;
    padding:13px 11px;
  }

  .command-box code{
    font-size:10.5px;
  }

  .paste-status{
    padding-left:13px;
    padding-right:13px;
  }

  .paste-ready{
    display:none;
  }

  .sitebar-inner,
  .footer{
    width:calc(100% - 20px);
  }
}
</style>
</head>

<body>

<header class="sitebar">
  <div class="sitebar-inner">
    <a class="wordmark" href="/">
      BaseTest
    </a>

    <a
      class="repo-link"
      href="https://github.com/jiaotang777/BaseTest"
      target="_blank"
      rel="noopener noreferrer"
    >
      GitHub ↗
    </a>
  </div>
</header>

<main class="landing">
  <div class="kicker">
    NodeQuality × TcpQuality
  </div>

  <h1>
    一个命令，一份报告。
  </h1>

  <p class="lead">
    根据当前登录用户选择对应命令。
    复制成功后会进入可粘贴状态，
    回到 SSH 终端直接粘贴运行即可。
  </p>

  <section
    class="command-list"
    aria-label="BaseTest 运行命令"
  >
    ${normalCard}
    ${rootCard}
  </section>

  <div class="helper">
    <span class="helper-mark">◆</span>

    <span>
      不确定当前身份？
      运行 <code>whoami</code>。
      输出 <code>root</code> 就使用
      <code># root 用户</code>；
      其他情况使用
      <code>$ 普通用户</code>。
    </span>
  </div>
</main>

<footer class="footer">
  BaseTest · basetest.aniya.site
</footer>

<div
  class="toast"
  role="status"
  aria-live="polite"
></div>

<script
  src="/assets/home.js?v=1"
  defer
></script>

</body>
</html>`;
}

const HOME_JS = `(() => {
  const toast =
    document.querySelector('.toast');

  const resetTimers =
    new Map();

  let toastTimer = 0;

  function notify(message) {
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add('show');

    clearTimeout(toastTimer);

    toastTimer =
      setTimeout(
        () => toast.classList.remove('show'),
        1600
      );
  }

  async function copyText(value) {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator.clipboard.writeText(value);
      return;
    }

    const temp =
      document.createElement('textarea');

    temp.value = value;
    temp.style.position = 'fixed';
    temp.style.opacity = '0';

    document.body.appendChild(temp);

    temp.select();

    document.execCommand('copy');

    temp.remove();
  }

  function markCopied(card) {
    if (!card) return;

    card.classList.add('copied');

    const button =
      card.querySelector('.copy-button');

    const status =
      card.querySelector('.status-text');

    const ready =
      card.querySelector('.paste-ready');

    if (button) {
      button.textContent = '已复制 ✓';
    }

    if (status) {
      status.textContent =
        '已复制 · 现在回到终端直接粘贴即可';
    }

    if (ready) {
      ready.textContent = 'PASTE READY';
    }

    const oldTimer =
      resetTimers.get(card);

    if (oldTimer) {
      clearTimeout(oldTimer);
    }

    const timer =
      setTimeout(() => {
        card.classList.remove('copied');

        if (button) {
          button.textContent = '复制命令';
        }

        if (status) {
          status.textContent =
            '点击复制，然后回到 SSH 终端粘贴运行';
        }

        if (ready) {
          ready.textContent = 'READY';
        }

        resetTimers.delete(card);
      }, 2800);

    resetTimers.set(card, timer);
  }

  document
    .querySelectorAll('[data-copy]')
    .forEach((control) => {
      control.addEventListener(
        'click',
        async () => {
          const id =
            control.dataset.copy;

          const target =
            document.getElementById(id);

          if (!target) return;

          try {
            await copyText(
              target.textContent.trim()
            );

            markCopied(
              control.closest('.command-card')
            );

            notify(
              '命令已复制，可以粘贴到终端'
            );
          } catch {
            notify(
              '复制失败，请手动选择命令'
            );
          }
        }
      );
    });
})();`;
