#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="0.4.17"
REPORT_BASE_URL="${NQC_REPORT_BASE_URL:-https://basetest.aniya.site}"
UPLOAD_TOKEN="${NQC_UPLOAD_TOKEN:-}"
NODEQUALITY_RUN_URL="${NODEQUALITY_RUN_URL:-https://run.NodeQuality.com}"
TCPQUALITY_RUN_URL="${TCPQUALITY_RUN_URL:-https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh}"
MAX_LOG_BYTES="${NQC_MAX_LOG_BYTES:-700000}"

NODE_ARGS=()
TCP_ARGS=()
SKIP_NODE=0
SKIP_TCP=0
INTERACTIVE_MENU=1

usage() {
  cat <<'USAGE'
BaseTest - NodeQuality + TcpQuality unified runner

Usage:
  bash run.sh [options]

Options:
  --report-base-url URL   Report site URL (default: https://basetest.aniya.site)
  --upload-token TOKEN    Optional API upload token (or NQC_UPLOAD_TOKEN)
  --node-arg ARG          Pass one argument to NodeQuality (repeatable)
  --tcp-arg ARG           Pass one argument to TcpQuality (repeatable)
  --skip-node             Skip NodeQuality
  --skip-tcp              Skip TcpQuality
  --no-menu               Do not ask the unified menu; use all default choices
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  bash run.sh
  bash run.sh --no-menu
USAGE
}

while (($#)); do
  case "$1" in
    --report-base-url)
      [[ $# -ge 2 ]] || { echo "[x] --report-base-url requires a value" >&2; exit 2; }
      REPORT_BASE_URL="$2"; shift 2 ;;
    --upload-token)
      [[ $# -ge 2 ]] || { echo "[x] --upload-token requires a value" >&2; exit 2; }
      UPLOAD_TOKEN="$2"; shift 2 ;;
    --node-arg)
      [[ $# -ge 2 ]] || { echo "[x] --node-arg requires a value" >&2; exit 2; }
      NODE_ARGS+=("$2"); shift 2 ;;
    --tcp-arg)
      [[ $# -ge 2 ]] || { echo "[x] --tcp-arg requires a value" >&2; exit 2; }
      TCP_ARGS+=("$2"); shift 2 ;;
    --skip-node) SKIP_NODE=1; shift ;;
    --skip-tcp) SKIP_TCP=1; shift ;;
    --no-menu) INTERACTIVE_MENU=0; shift ;;
    -h|--help) usage; exit 0 ;;
    -v|--version) echo "$VERSION"; exit 0 ;;
    *) echo "[x] Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

REPORT_BASE_URL="${REPORT_BASE_URL%/}"
if [[ ! "$REPORT_BASE_URL" =~ ^https://[^/]+(:[0-9]+)?$ ]]; then
  echo "[x] Report base URL must be an HTTPS origin, for example https://basetest.aniya.site" >&2
  exit 2
fi

if [[ "$SKIP_NODE" -eq 1 && "$SKIP_TCP" -eq 1 ]]; then
  echo "[x] --skip-node and --skip-tcp cannot be used together" >&2
  exit 2
fi

for cmd in bash curl grep mktemp tee python3 sed; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "[x] Missing dependency: $cmd" >&2; exit 1; }
done

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/basetest.XXXXXX")"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT

NODE_LOG="$WORK_DIR/nodequality.log"
TCP_LOG="$WORK_DIR/tcpquality.log"
NODE_SCRIPT="$WORK_DIR/nodequality.sh"
TCP_SCRIPT="$WORK_DIR/tcpquality.sh"
: > "$NODE_LOG"
: > "$TCP_LOG"

# Defaults match the upstream interactive defaults.
NQ_HQ="y"
NQ_IP="y"
NQ_NET="y"
NQ_TRACE="y"
TQ_ROUTE="y"
TQ_EDU="y"
TQ_INTL="y"
TQ_SPEED="y"
TQ_RANK="y"

read_choice() {
  local prompt="$1" allowed="$2" default_value="$3" answer=""
  while :; do
    if [[ -r /dev/tty ]]; then
      printf '%s' "$prompt" > /dev/tty
      IFS= read -r answer < /dev/tty || answer=""
    else
      printf '%s' "$prompt" >&2
      IFS= read -r answer || answer=""
    fi
    answer="${answer:-$default_value}"
    answer="${answer,,}"
    case ":$allowed:" in
      *":$answer:"*) printf '%s' "$answer"; return 0 ;;
    esac
    printf '输入无效，可选值：%s\n' "${allowed//:/, }" >&2
  done
}

show_unified_menu() {
  echo
  echo "============================================================"
  echo " BaseTest 测试选项"
  echo "============================================================"
  echo "请先一次性选择全部测试项目，确认后才开始运行。"
  echo

  if [[ "$SKIP_NODE" -eq 0 ]]; then
    echo "[NodeQuality]"
    NQ_HQ=$(read_choice "1. HardwareQuality？[y/f/v/n]（默认 y）：" "y:f:v:n" "y")
    NQ_IP=$(read_choice "2. IPQuality？[y/n]（默认 y）：" "y:n" "y")
    NQ_NET=$(read_choice "3. NetQuality？[y/l/n]（默认 y）：" "y:l:n" "y")
    NQ_TRACE=$(read_choice "4. 回程路由追踪？[y/n]（默认 y）：" "y:n" "y")
    echo
  fi

  if [[ "$SKIP_TCP" -eq 0 ]]; then
    echo "[TcpQuality]"
    TQ_ROUTE=$(read_choice "5. 三网回程（IPv4/IPv6/IPv4大包）？[y/n]（默认 y）：" "y:n" "y")
    TQ_EDU=$(read_choice "6. 教育网回程（CERNET/CERNET2）？[y/n]（默认 y）：" "y:n" "y")
    TQ_INTL=$(read_choice "7. 国际互联？[y/n]（默认 y）：" "y:n" "y")
    TQ_SPEED=$(read_choice "8. 三网单线程速度？[y/n]（默认 y）：" "y:n" "y")
    TQ_RANK=$(read_choice "9. 上传 TcpQuality 原站报告并参与排名？[y/n]（默认 y）：" "y:n" "y")

    if [[ "$TQ_ROUTE" == n && "$TQ_EDU" == n && "$TQ_INTL" == n && "$TQ_SPEED" == n ]]; then
      echo "[x] TcpQuality 至少需要选择一个测试项目。" >&2
      exit 2
    fi
    if [[ "$TQ_ROUTE" == n && "$TQ_EDU" == n && "$TQ_INTL" == y && "$TQ_SPEED" == y ]]; then
      echo "[x] TcpQuality 国际互联与单线程测速不能在关闭三网/教育网时同时单独运行。" >&2
      exit 2
    fi
  fi

  echo
  echo "选项已确定，开始测试。"
}

if [[ "$INTERACTIVE_MENU" -eq 1 ]]; then
  show_unified_menu
fi

fetch_script() {
  local url="$1" output="$2" label="$3"
  echo "[BaseTest] Fetching ${label}..."
  curl -fsSL --retry 2 --retry-delay 1 --connect-timeout 15 --max-time 90 \
    "$url" -o "$output"
  [[ -s "$output" ]] || { echo "[x] ${label} download was empty" >&2; return 1; }
}

filter_live_output() {
  # Upstream report links are captured internally when needed, but the terminal
  # only exposes the final BaseTest report URL.
  sed -E \
    -e '/nodequality\.com\/r\/[A-Za-z0-9_-]+/d' \
    -e '/tcpquality\.ibsgss\.uk\/r\/[A-Za-z0-9_-]+/d' \
    -e '/运行 HardwareQuality 测试？/d' \
    -e '/运行 IPQuality 测试？/d' \
    -e '/运行 NetQuality 测试？/d' \
    -e '/运行 回程路由追踪（Backroute Trace）测试？/d'
}

run_nodequality() {
  echo
  echo "============================================================"
  echo " NodeQuality"
  echo "============================================================"
  fetch_script "$NODEQUALITY_RUN_URL" "$NODE_SCRIPT" "NodeQuality" || return $?

  # NodeQuality 上游通过 Check.Place 动态获取子测试脚本。
  # 只修改本次下载到临时目录的副本，增加失败检测和自动重试。
  sed -i \
    -e 's#curl -Ls https://Net.Check.Place#curl -fLs --retry 5 --retry-all-errors --retry-delay 2 https://Net.Check.Place#g' \
    -e 's#curl -Ls https://IP.Check.Place#curl -fLs --retry 5 --retry-all-errors --retry-delay 2 https://IP.Check.Place#g' \
    "$NODE_SCRIPT"

  # NetQuality 如果第一次没有产生正式报告，
  # 自动重新执行整个 NetQuality 模块一次。
  python3 - "$NODE_SCRIPT" <<'PYNQ'
from pathlib import Path
import sys

p = Path(sys.argv[1])
s = p.read_text(encoding="utf-8")

start = s.find("function run_net_quality(){")
end = s.find("function run_net_trace(){", start)

if start < 0 or end < 0:
    raise SystemExit("找不到 upstream run_net_quality")

new = r'''function run_net_quality(){
    local params=""
    local output=""
    local rc=1
    local attempt=1

    [[ "$run_net_quality_test" =~ ^[Ll]$ ]] && params=" -L"

    while [[ "$attempt" -le 2 ]]; do
        output="$(
            chroot_run bash \
              <(curl -fLs \
                --retry 5 \
                --retry-all-errors \
                --retry-delay 2 \
                https://Net.Check.Place) \
              $opt_ipv \
              $opt_lang \
              $params \
              -y \
              -o /result/$net_quality_json_filename \
              2>&1
        )"

        rc=$?

        if printf '%s\n' "$output" \
          | grep -Eq '网络质量体检报告|NET(WORK)?[[:space:]]+QUALITY.*REPORT'
        then
            printf '%s\n' "$output"
            return 0
        fi

        attempt=$((attempt + 1))

        if [[ "$attempt" -le 2 ]]; then
            sleep 2
        fi
    done

    printf '%s\n' "$output"
    return "$rc"
}'''

p.write_text(
    s[:start] + new + "\n\n" + s[end:],
    encoding="utf-8"
)
PYNQ

  set +e
  printf '%s\n%s\n%s\n%s\n' "$NQ_HQ" "$NQ_IP" "$NQ_NET" "$NQ_TRACE" \
    | bash "$NODE_SCRIPT" "${NODE_ARGS[@]}" 2>&1 \
    | tee "$NODE_LOG" \
    | filter_live_output
  local rc=${PIPESTATUS[1]}
  set -e
  return "$rc"
}

build_tcp_args() {
  local -a selected=()

  [[ "$TQ_EDU" == y ]] && selected+=("--cernet")
  [[ "$TQ_INTL" == y ]] && selected+=("--intl")

  if [[ "$TQ_SPEED" == y ]]; then
    if [[ "$TQ_ROUTE" == n && "$TQ_EDU" == n ]]; then
      selected+=("--only-speedtest")
    else
      selected+=("--speedtest")
    fi
  fi

  if [[ "$TQ_ROUTE" == y && "$TQ_EDU" == y && "$TQ_INTL" == y && "$TQ_SPEED" == y ]]; then
    selected=("--all")
  fi

  [[ "$TQ_RANK" == n ]] && selected+=("--no-rank-upload")

  # The upstream rootfs enters its own menu when no core argument exists.
  # -s 0 equals the current standard SYN default and is used only as a neutral
  # explicit argument to keep the already-selected BaseTest choices noninteractive.
  if [[ ${#selected[@]} -eq 0 ]]; then
    selected=("-s" "0")
  fi

  TCP_SELECTED_ARGS=("${selected[@]}")
}

run_tcpquality() {
  echo
  echo "============================================================"
  echo " TcpQuality"
  echo "============================================================"
  fetch_script "$TCPQUALITY_RUN_URL" "$TCP_SCRIPT" "TcpQuality" || return $?
  build_tcp_args
  set +e
  INTERACTIVE_INCLUDE_DEFAULT_ROUTE="$([[ "$TQ_ROUTE" == y ]] && echo 1 || echo 0)" \
    bash "$TCP_SCRIPT" "${TCP_SELECTED_ARGS[@]}" "${TCP_ARGS[@]}" 2>&1 \
    | tee "$TCP_LOG" \
    | filter_live_output
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

node_rc=0
tcp_rc=0
if [[ "$SKIP_NODE" -eq 0 ]]; then run_nodequality || node_rc=$?; fi
if [[ "$SKIP_TCP" -eq 0 ]]; then run_tcpquality || tcp_rc=$?; fi

PAYLOAD_FILE="$WORK_DIR/payload.json"
python3 - "$NODE_LOG" "$TCP_LOG" "$PAYLOAD_FILE" "$node_rc" "$tcp_rc" "$VERSION" "$MAX_LOG_BYTES" <<'PYJSON'
import json
import pathlib
import re
import sys

node_log, tcp_log, out, node_rc, tcp_rc, version, max_bytes = sys.argv[1:]
max_bytes = int(max_bytes)

# Keep SGR color codes (ESC[...m) for the BaseTest HTML renderer, but remove
# cursor movement/OSC/control noise that does not make sense in a static page.
osc = re.compile(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)")
csi_non_sgr = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-LN-Z\\-_]")
upstream_url = re.compile(
    r"https?://(?:(?:[A-Za-z0-9.-]+\.)?nodequality\.com|tcpquality\.ibsgss\.uk)/r/[A-Za-z0-9_-]+",
    re.I,
)
node_url_re = re.compile(r"https?://(?:[A-Za-z0-9.-]+\.)?nodequality\.com/r/[A-Za-z0-9_-]+", re.I)
tcp_url_re = re.compile(r"https?://tcpquality\.ibsgss\.uk/r/[A-Za-z0-9_-]+", re.I)


def clean_log(path, kind):
    data = pathlib.Path(path).read_bytes()
    data = osc.sub(b"", data)
    data = csi_non_sgr.sub(b"", data)
    data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if len(data) > max_bytes:
        prefix = f"[log truncated: showing last {max_bytes} bytes of {len(data)}]\n".encode()
        data = prefix + data[-max_bytes:]
    text = data.decode("utf-8", errors="replace")

    # Remove upstream report URLs and duplicated upstream interactive prompts.
    cleaned = []
    for line in text.splitlines():
        if upstream_url.search(line):
            continue
        if kind == "node" and any(marker in line for marker in (
            "运行 HardwareQuality 测试？",
            "运行 IPQuality 测试？",
            "运行 NetQuality 测试？",
            "运行 回程路由追踪（Backroute Trace）测试？",
        )):
            continue
        cleaned.append(line.rstrip())
    return "\n".join(cleaned).strip() + "\n"


node_raw = pathlib.Path(node_log).read_text(encoding="utf-8", errors="replace")
tcp_raw = pathlib.Path(tcp_log).read_text(encoding="utf-8", errors="replace")
node_match = node_url_re.findall(node_raw)
tcp_match = tcp_url_re.findall(tcp_raw)

# NodeQuality currently exits 1 during its normal cleanup even after a report was
# generated. Treat an observed upstream result URL as a completed test.
node_exit = 0 if node_match else int(node_rc)
tcp_exit = int(tcp_rc)

payload = {
    "nodeQuality": {
        "exitCode": node_exit,
        "log": clean_log(node_log, "node"),
    },
    "tcpQuality": {
        "exitCode": tcp_exit,
        "log": clean_log(tcp_log, "tcp"),
    },
    "client": {"version": version},
}
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
PYJSON

headers=(-H 'content-type: application/json')
if [[ -n "$UPLOAD_TOKEN" ]]; then
  headers+=(-H "authorization: Bearer $UPLOAD_TOKEN")
fi

response="$WORK_DIR/response.json"
set +e
http_code=$(curl -sS -o "$response" -w '%{http_code}' \
  --retry 2 --retry-all-errors --retry-delay 1 --connect-timeout 15 --max-time 90 \
  -X POST "${REPORT_BASE_URL}/api/reports" \
  "${headers[@]}" \
  --data-binary "@$PAYLOAD_FILE")
curl_rc=$?
set -e

if [[ "$curl_rc" -ne 0 ]]; then
  echo "[x] Report upload failed: curl exit ${curl_rc}" >&2
  exit 1
fi

if [[ "$http_code" != "201" ]]; then
  echo "[x] Report upload failed (HTTP $http_code):" >&2
  cat "$response" >&2
  exit 1
fi

REPORT_URL=$(python3 - "$response" <<'PY'
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get("url", "")
except Exception:
    value = ""
if not isinstance(value, str) or not value.startswith("https://"):
    raise SystemExit(1)
print(value)
PY
) || { echo "[x] Worker returned an invalid report URL" >&2; exit 1; }

# Keep the final terminal output intentionally minimal: the BaseTest report URL
# is the last and only report link shown to the user.
echo
echo "$REPORT_URL"
