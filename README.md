# BaseTest

BaseTest 是一个统一的 VPS 测试入口：顺序运行 **NodeQuality** 与 **TcpQuality**，捕获两边结果，并生成一个统一报告地址：

```text
https://basetest.aniya.site/r/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

成功时终端最后只突出显示这一条 BaseTest 报告链接；报告页面内部再提供 NodeQuality 与 TcpQuality 的原始报告入口和终端输出。

## 项目定位

BaseTest 是独立实现的 **orchestrator / report aggregator（调度器 + 报告聚合器）**。本仓库不复制两个上游项目的源码，运行时从各自官方入口获取脚本。

## 参考与致谢

本项目参考并调用：

- [LloydAsp/NodeQuality](https://github.com/LloydAsp/NodeQuality) — 上游使用 GNU AGPL-3.0。
- [ibsgss/TcpQuality](https://github.com/ibsgss/TcpQuality) — TCP 质量检测脚本。

详细说明见 [NOTICE.md](NOTICE.md)。本仓库的 MIT License 仅覆盖 BaseTest 自己编写的调度、上传和报告展示代码，不改变上游项目的许可证、版权或使用条款。

## 架构

```text
待测 VPS
   │
   ├─ NodeQuality
   ├─ TcpQuality
   │
   └─ BaseTest run.sh
          │
          ▼
https://basetest.aniya.site/api/reports
          │
          ▼
Cloudflare Worker + Workers KV
          │
          ▼
https://basetest.aniya.site/r/<id>
```

## 1. 部署 Cloudflare Worker + KV

要求 Node.js/npm 可用，并使用 Wrangler v4。

```bash
npm install
npx wrangler login
```

创建 KV：

```bash
npx wrangler kv namespace create REPORTS
```

Wrangler 会返回 namespace ID。把它填入 `wrangler.jsonc`：

```jsonc
"kv_namespaces": [
  {
    "binding": "REPORTS",
    "id": "你的_KV_NAMESPACE_ID"
  }
]
```

`wrangler.jsonc` 已经预设正式域名：

```text
basetest.aniya.site
```

并使用 Custom Domain 配置：

```jsonc
"routes": [
  {
    "pattern": "basetest.aniya.site",
    "custom_domain": true
  }
]
```

只要 `aniya.site` 位于同一个 Cloudflare 账户，部署 Worker 时 Cloudflare 可自动创建/管理对应 DNS 与证书。

### 上传密钥（建议私用部署开启）

```bash
npx wrangler secret put UPLOAD_TOKEN
```

不要把上传密钥写入 `run.sh`、`wrangler.jsonc` 或公开 GitHub 仓库。

部署前检查：

```bash
npm run check
```

正式部署：

```bash
npm run deploy
```

健康检查：

```bash
curl -fsSL https://basetest.aniya.site/healthz
```

正常应返回类似：

```json
{"ok":true,"service":"BaseTest"}
```

## 2. 运行统一测试

未设置 Worker 上传密钥时：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/jiaotang777/BaseTest/main/run.sh)
```

如果 Worker 设置了 `UPLOAD_TOKEN`，在待测 VPS 上临时提供同一密钥：

```bash
export NQC_UPLOAD_TOKEN='你的上传密钥'
bash <(curl -fsSL https://raw.githubusercontent.com/jiaotang777/BaseTest/main/run.sh)
unset NQC_UPLOAD_TOKEN
```

测试完成后终端最后会显示：

```text
============================================================
 BaseTest report
============================================================
https://basetest.aniya.site/r/2cNEO7xJ3VJtQH40n0YxhwvXZbnL4ZKx
```

## 参数

```text
--report-base-url URL   报告站地址
--upload-token TOKEN    可选上传密钥
--node-arg ARG          向 NodeQuality 透传一个参数，可重复
--tcp-arg ARG           向 TcpQuality 透传一个参数，可重复
--skip-node             只跑 TcpQuality
--skip-tcp              只跑 NodeQuality
-h, --help              帮助
-v, --version           版本
```

TcpQuality 开启 `--all`：

```bash
bash run.sh --tcp-arg --all
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `NQC_REPORT_BASE_URL` | 覆盖统一报告站域名，默认 `https://basetest.aniya.site` |
| `NQC_UPLOAD_TOKEN` | Worker 上传密钥，可选 |
| `NODEQUALITY_RUN_URL` | NodeQuality 启动入口，默认 `https://run.NodeQuality.com` |
| `TCPQUALITY_RUN_URL` | TcpQuality 启动入口，默认 GitHub Raw |
| `NQC_MAX_LOG_BYTES` | 每项上传的最大日志字节数，默认 512 KiB |

## 从已经登录 GitHub 的服务器上传

如果服务器已经执行过 `gh auth login` 并且 `gh auth status` 正常，可以直接从服务器创建并推送仓库：

```bash
gh auth status
cd /path/to/BaseTest
git init
git add .
git commit -m "Initial BaseTest release"
git branch -M main
gh repo create jiaotang777/BaseTest --public --source=. --remote=origin --push
```

如果 GitHub 上已经存在空的 `jiaotang777/BaseTest`：

```bash
cd /path/to/BaseTest
git init
git add .
git commit -m "Initial BaseTest release"
git branch -M main
git remote add origin git@github.com:jiaotang777/BaseTest.git
git push -u origin main
```

## 数据与隐私

测试日志可能包含服务器 IP、ASN、硬件信息、网络路由等内容。报告默认保存 90 天，可通过 `REPORT_TTL_SECONDS` 修改（代码会限制在 60 秒到 365 天范围内）。

如果公开开放 `/api/reports`，任何人都可能消耗你的 KV 写入额度。私用部署建议设置 `UPLOAD_TOKEN`；公开服务则应另外配置 Cloudflare 的限流/防滥用策略。
