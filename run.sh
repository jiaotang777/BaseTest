#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="0.2.0"
REPORT_BASE_URL="${NQC_REPORT_BASE_URL:-https://basetest.aniya.site}"
UPLOAD_TOKEN="${NQC_UPLOAD_TOKEN:-}"
NODEQUALITY_RUN_URL="${NODEQUALITY_RUN_URL:-https://run.NodeQuality.com}"
TCPQUALITY_RUN_URL="${TCPQUALITY_RUN_URL:-https://raw.githubusercontent.com/ibsgss/TcpQuality/main/runTcpQuality.sh}"
MAX_LOG_BYTES="${NQC_MAX_LOG_BYTES:-524288}"

NODE_ARGS=()
TCP_ARGS=()
SKIP_NODE=0
SKIP_TCP=0

usage() {
  cat <<'USAGE'
BaseTest — NodeQuality + TcpQuality unified runner

Usage:
  bash run.sh [options]

Options:
  --report-base-url URL   Report site URL (default: https://basetest.aniya.site)
  --upload-token TOKEN    Optional API upload token (or NQC_UPLOAD_TOKEN)
  --node-arg ARG          Pass one argument to NodeQuality (repeatable)
  --tcp-arg ARG           Pass one argument to TcpQuality (repeatable)
  --skip-node             Skip NodeQuality
  --skip-tcp              Skip TcpQuality
  -h, --help              Show this help
  -v, --version           Show version

Examples:
  bash run.sh
  bash run.sh --tcp-arg --all
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

for cmd in bash curl grep tail mktemp tee python3; do
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

fetch_script() {
  local url="$1" output="$2" label="$3"
  echo "[BaseTest] Fetching ${label}..."
  curl -fsSL --retry 2 --retry-delay 1 --connect-timeout 15 --max-time 60 \
    "$url" -o "$output"
  [[ -s "$output" ]] || { echo "[x] ${label} download was empty" >&2; return 1; }
}

run_nodequality() {
  echo
  echo "============================================================"
  echo " NodeQuality"
  echo "============================================================"
  fetch_script "$NODEQUALITY_RUN_URL" "$NODE_SCRIPT" "NodeQuality" || return $?
  set +e
  bash "$NODE_SCRIPT" "${NODE_ARGS[@]}" 2>&1 | tee "$NODE_LOG"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

run_tcpquality() {
  echo
  echo "============================================================"
  echo " TcpQuality"
  echo "============================================================"
  fetch_script "$TCPQUALITY_RUN_URL" "$TCP_SCRIPT" "TcpQuality" || return $?
  set +e
  bash "$TCP_SCRIPT" "${TCP_ARGS[@]}" 2>&1 | tee "$TCP_LOG"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

node_rc=0
tcp_rc=0
if [[ "$SKIP_NODE" -eq 0 ]]; then run_nodequality || node_rc=$?; fi
if [[ "$SKIP_TCP" -eq 0 ]]; then run_tcpquality || tcp_rc=$?; fi

PAYLOAD_FILE="$WORK_DIR/payload.json"
META_FILE="$WORK_DIR/meta.json"
python3 - "$NODE_LOG" "$TCP_LOG" "$PAYLOAD_FILE" "$META_FILE" "$node_rc" "$tcp_rc" "$VERSION" "$MAX_LOG_BYTES" <<'PYJSON'
import json
import pathlib
import re
import sys

node_log, tcp_log, out, meta_out, node_rc, tcp_rc, version, max_bytes = sys.argv[1:]
max_bytes = int(max_bytes)
ansi = re.compile(rb"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def clean_bytes(path):
    data = pathlib.Path(path).read_bytes()
    data = ansi.sub(b"", data).replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if len(data) > max_bytes:
        prefix = f"[log truncated: showing last {max_bytes} bytes of {len(data)}]\n".encode()
        data = prefix + data[-max_bytes:]
    return data.decode("utf-8", errors="replace")


node_text = clean_bytes(node_log)
tcp_text = clean_bytes(tcp_log)
node_match = re.findall(r"https?://(?:[A-Za-z0-9.-]+\.)?nodequality\.com/r/[A-Za-z0-9_-]+", node_text, re.I)
tcp_match = re.findall(r"https?://tcpquality\.ibsgss\.uk/r/[A-Za-z0-9_-]+", tcp_text, re.I)
node_url = node_match[-1] if node_match else ""
tcp_url = tcp_match[-1] if tcp_match else ""

payload = {
    "nodeQuality": {"url": node_url, "exitCode": int(node_rc), "log": node_text},
    "tcpQuality": {"url": tcp_url, "exitCode": int(tcp_rc), "log": tcp_text},
    "client": {"version": version},
}
pathlib.Path(out).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
pathlib.Path(meta_out).write_text(json.dumps({"node": node_url, "tcp": tcp_url}), encoding="utf-8")
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

echo
echo "============================================================"
echo " BaseTest report"
echo "============================================================"
echo "$REPORT_URL"

if [[ "$node_rc" -ne 0 || "$tcp_rc" -ne 0 ]]; then
  echo "[!] One upstream test exited non-zero: NodeQuality=$node_rc TcpQuality=$tcp_rc" >&2
fi
