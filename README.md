<p align="center">
  <img src="./assets/icons/exports/brand/light/mark-128.png" width="56" alt="Wevir" />
</p>

<h1 align="center">Wevir</h1>

<p align="center"><strong>本地优先的 AI 编程 Agent 工作台</strong></p>

<p align="center">
  <a href="#downloads"><img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /></a>
  <img alt="macOS arm64 and x64" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-80643D?style=flat-square&logo=opensourceinitiative&logoColor=white" /></a>
</p>

<p align="center"><a href="./README.en.md">English</a> · <a href="#downloads">下载</a></p>

---

## 简介

Wevir 是开源、本地优先的 AI Agent 工作台，将模型服务、Agent 会话、工具审批与代码变更集中于同一桌面应用，并提供共用本地 Host 的 CLI。默认执行引擎为 Codex，其他引擎经独立适配器接入。

## 核心能力

- **模型服务**：OpenAI、Anthropic、Google AI Studio、Google Vertex AI、DeepSeek、Azure OpenAI / Microsoft Foundry 及 OpenAI 兼容接口；支持 API Key 与订阅账户。
- **会话时间线**：流式回复、计划、工具调用、子 Agent、审批与提问；权限模式分为请求批准、自动批准与完全访问。
- **变更审阅**：按回合查看文件差异，浏览与预览项目文件。
- **本地 Host**：桌面端与 CLI 共用会话状态与事件流，断线后可重连续接。

<a id="downloads"></a>

## 下载

<img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" />

| 平台 | 安装包 |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [下载 DMG](https://download.wevir.si/desktop/darwin-arm64/Wevir-beta-mac-arm64.dmg) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [下载 DMG](https://download.wevir.si/desktop/darwin-x64/Wevir-beta-mac-x64.dmg) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [下载 EXE](https://download.wevir.si/desktop/win32-x64/Wevir-beta-win-x64-setup.exe) |

## 从源码运行

需要 Node.js **22.19+**（推荐 24 LTS）与 pnpm **12.6.0**。

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh
pnpm dev
```

详见[开发指南](docs/development.md)。

## 文档

- [桌面工作台布局](docs/architecture/desktop-layout.md)
- [模型协议网关](docs/architecture/model-gateway.md)
- [安全说明](docs/security.md)
- [架构决策记录](docs/adr/README.md)
- [开发指南](docs/development.md)

## 许可证

[MIT License](LICENSE)。上游移植与第三方版权声明见 [NOTICE](NOTICE)。
