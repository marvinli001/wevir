<p align="center">
  <img src="./assets/icons/exports/brand/light/mark-128.png" width="56" alt="Wevir" />
</p>

<h1 align="center">Wevir</h1>

<p align="center"><strong>A local-first workspace for AI coding agents</strong></p>

<p align="center">
  <a href="#downloads"><img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /></a>
  <img alt="macOS arm64 and x64" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-80643D?style=flat-square&logo=opensourceinitiative&logoColor=white" /></a>
</p>

<p align="center"><a href="./README.md">简体中文</a> · <a href="#downloads">Downloads</a></p>

---

## Overview

Wevir is an open-source, local-first workspace for AI coding agents. Model providers, agent sessions, tool approvals, and code changes live in one desktop app, with a CLI on the same local Host. Codex is the default runtime; other runtimes connect through isolated adapters.

## Features

- **Model providers**: OpenAI, Anthropic, Google AI Studio, Google Vertex AI, DeepSeek, Azure OpenAI / Microsoft Foundry, and OpenAI-compatible APIs; API keys and subscriptions.
- **Session timeline**: Streaming responses, plans, tool calls, subagents, approvals, and questions; permission modes: ask for approval, auto-approve, full access.
- **Change review**: Per-turn diffs, project file browsing and preview.
- **Local Host**: Desktop and CLI share session state and the event stream, with reconnect and resume.

<a id="downloads"></a>

## Downloads

<img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" />

| Platform | Installer |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://wevir.si/en/download/#platforms) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://wevir.si/en/download/#platforms) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [Download EXE](https://wevir.si/en/download/#platforms) |

## Run from source

Requires Node.js **22.19+** (Node 24 LTS recommended) and pnpm **12.6.0**.

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh
pnpm dev
```

## License

[MIT License](LICENSE). Upstream code and third-party attributions: [NOTICE](NOTICE).
