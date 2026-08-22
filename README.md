# BaseTest

NodeQuality + TcpQuality 一体化 VPS 测试脚本。

一次选择测试项目，依次运行 NodeQuality 与 TcpQuality，最后只输出一个 BaseTest 报告地址。报告内容全部显示在 `basetest.aniya.site` 自己的页面中，不需要再分别打开两个上游报告页。

## 快速运行

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/jiaotang777/BaseTest/main/run.sh)
```

运行开始时会一次性完成全部测试项目选择：

- NodeQuality：HardwareQuality / IPQuality / NetQuality / 回程路由追踪
- TcpQuality：三网回程 / 教育网回程 / 国际互联 / 单线程测速 / 排名上传

确认后脚本才正式开始测试，中途不会再弹出第二套 TcpQuality 选择菜单。

测试结束后终端最后只显示一个链接：

```text
https://basetest.aniya.site/r/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 报告

BaseTest 报告采用统一报告查看器，NodeQuality 与 TcpQuality 的测试结果全部显示在同一个 BaseTest 页面中，不嵌套上游网页，也不需要分别打开两个上游报告站。

报告页面固定提供以下分类：

- 全部
- 基本信息
- IP质量
- 网络质量
- 回程路由
- IPv4回程
- IPv4大包回程
- IPv6回程
- 教育网回程
- 国际互联
- 单线程测速

「全部」页面只显示实际存在测试数据的栏目；单独进入未测试栏目时仍保留对应标签和报告区域，方便保持不同报告之间一致的页面结构。

报告页面提供：

- 复制文本
- 复制为 NodeSeek 格式
- 复制为通用 Markdown
- 复制 BaseTest 报告链接

NodeSeek 导出采用 `Tabs + ANSI` 格式。各个有数据的测试栏目分别作为 Tab 输出，并保留 ANSI 彩色终端效果；不依赖 PNG 图片、Browser Run 或第三方图床。

示例报告地址：

```text
https://basetest.aniya.site/r/<report-id>
```

## 参数

```text
--report-base-url URL   覆盖报告站地址
--upload-token TOKEN    可选上传密钥
--node-arg ARG          向 NodeQuality 透传参数，可重复
--tcp-arg ARG           向 TcpQuality 透传参数，可重复
--skip-node             只运行 TcpQuality
--skip-tcp              只运行 NodeQuality
--no-menu               不显示 BaseTest 统一选择菜单，全部采用默认选项
-h, --help              显示帮助
-v, --version           显示版本
```

## 环境变量

```text
NQC_REPORT_BASE_URL   BaseTest 报告站，默认 https://basetest.aniya.site
NQC_UPLOAD_TOKEN      可选 Worker 上传密钥
NODEQUALITY_RUN_URL   NodeQuality 启动入口
TCPQUALITY_RUN_URL    TcpQuality 启动入口
NQC_MAX_LOG_BYTES     每个测试保存到报告的最大日志大小
```

## 参考与致谢

BaseTest 是独立实现的调度与报告聚合项目，不在仓库中复制两个上游项目源码。运行时调用：

- [LloydAsp/NodeQuality](https://github.com/LloydAsp/NodeQuality) — GNU AGPL-3.0
- [ibsgss/TcpQuality](https://github.com/ibsgss/TcpQuality)

感谢两个项目及其作者提供的测试能力。详细说明见 [NOTICE.md](NOTICE.md)。

## License

BaseTest 自有代码使用 MIT License。上游项目的代码、服务与测试结果仍分别遵循其原项目许可和条款。
