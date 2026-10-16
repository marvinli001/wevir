<p align="center">
  <img src="./assets/icons/exports/brand/light/mark-128.png" width="56" alt="Wevir" />
</p>

<h1 align="center">Wevir</h1>

<p align="center"><strong>本地优先的 AI 编程 Agent 工作台</strong></p>
<p align="center">在一个桌面工作台里运行 Agent、跟进会话、审阅执行过程与代码变更。</p>

<p align="center">
  <a href="#downloads"><img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /></a>
  <img alt="macOS arm64 and x64" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-80643D?style=flat-square&logo=opensourceinitiative&logoColor=white" /></a>
</p>

<p align="center"><a href="./README.en.md">English</a> · <a href="#downloads">下载</a></p>

---

<a id="chinese"></a>

## Wevir 是什么

Wevir 是一款开源、本地优先的 AI Agent 工作台。它把模型服务、Agent 会话、工具审批和代码变更放进同一套桌面体验，并提供 CLI 连接同一个本地 Host。

Codex 是默认执行引擎。Host 为 API 模型服务提供内置网关，其他执行引擎由独立适配器提供。会话与事件由本机 Host 保存，桌面端和 CLI 可从同一条会话继续工作。

## 核心能力

- **连接常用模型服务**：支持 OpenAI、Anthropic、Google AI Studio、Google Vertex AI、DeepSeek、Azure OpenAI / Microsoft Foundry，以及 OpenAI 兼容接口；可使用 API Key 或已接入的订阅账户。
- **看清 Agent 正在做什么**：流式回复、计划、工具调用、子 Agent、审批和提问都留在会话时间线中；可选择请求批准、自动批准或完全访问等权限模式。
- **在上下文中审阅变更**：查看每回合的文件差异、浏览项目文件并预览文件内容。
- **桌面端与 CLI 共用本地会话**：Host 负责会话状态和事件流，客户端断开后可重连并继续。

<a id="downloads"></a>

## 下载与安装

当前预览版：<img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" />（下面的链接总是最新的预览版）。

| 平台 | 安装包 |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [下载 DMG](https://download.wevir.si/desktop/darwin-arm64/Wevir-beta-mac-arm64.dmg) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [下载 DMG](https://download.wevir.si/desktop/darwin-x64/Wevir-beta-mac-x64.dmg) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [下载 EXE](https://download.wevir.si/desktop/win32-x64/Wevir-beta-win-x64-setup.exe) |

安装后，在设置中登录支持的 Agent 账户或添加模型服务。模型使用与计费按所连接服务的账户规则执行。Windows 预览版安装包目前未签名，首次启动时 Windows SmartScreen 可能会显示提示。

正式版尚未发布；正式版安装包会列在 [GitHub Releases](https://github.com/marvinli001/wevir/releases)。

## 从源码运行

适用于参与开发或希望自行构建的用户。需要 Node.js **22.19 或更高版本**（推荐 Node 24 LTS）和 pnpm **12.6.0**。

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh
pnpm dev
```

首次运行会下载 Electron 与锁定版本的 Codex 运行时。更多环境配置、开发命令和故障排查见[开发指南](docs/development.md)。

## 文档

- [桌面工作台布局](docs/architecture/desktop-layout.md)
- [模型协议网关](docs/architecture/model-gateway.md)
- [安全说明](docs/security.md)
- [架构决策记录](docs/adr/README.md)
- [开发指南](docs/development.md)

## 许可证

Wevir 使用 [MIT License](LICENSE)。上游移植内容与第三方版权声明见 [NOTICE](NOTICE)。
