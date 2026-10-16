<p align="center">
  <img src="./assets/icons/exports/brand/light/mark-128.png" width="56" alt="Wevir" />
</p>

<h1 align="center">Wevir</h1>

<p align="center"><strong>A local-first workspace for AI coding agents</strong></p>
<p align="center">Run agents, follow sessions, and review execution and code changes in one desktop workspace.</p>

<p align="center">
  <a href="#downloads"><img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /></a>
  <img alt="macOS arm64 and x64" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-80643D?style=flat-square&logo=opensourceinitiative&logoColor=white" /></a>
</p>

<p align="center"><a href="./README.md">简体中文</a> · <a href="#downloads">Downloads</a></p>

---

Wevir is an open-source, local-first workspace for AI coding agents. It brings model providers, agent sessions, tool approvals, and code changes into one desktop experience, with a CLI that connects to the same local Host.

Codex is the default runtime. The Host includes a gateway for API-based model providers, while additional runtimes are provided through isolated adapters. The local Host owns session state and its event stream, so the desktop app and CLI can continue the same work.

## Features

- **Connect your models**: OpenAI, Anthropic, Google AI Studio, Google Vertex AI, DeepSeek, Azure OpenAI / Microsoft Foundry, and OpenAI-compatible APIs. Use API keys or supported subscriptions.
- **Follow the work**: Streaming responses, plans, tool calls, subagents, approvals, and questions appear in the session timeline. Choose a permission mode for each session.
- **Review changes in context**: Inspect per-turn diffs, browse project files, and preview file contents.
- **Continue from desktop or CLI**: The local Host owns session state and events. Clients can reconnect and pick up where they left off.

<a id="downloads"></a>

## Downloads

Current preview: <img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /> (the links below always point to the latest preview).

| Platform | Installer |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://download.wevir.si/desktop/darwin-arm64/Wevir-beta-mac-arm64.dmg) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://download.wevir.si/desktop/darwin-x64/Wevir-beta-mac-x64.dmg) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [Download EXE](https://download.wevir.si/desktop/win32-x64/Wevir-beta-win-x64-setup.exe) |

After installation, sign in with a supported agent account or add a model provider in Settings. Provider usage and billing follow the account you connect. The current Windows preview installer is unsigned, so Windows SmartScreen may show a prompt on first launch.

The first stable release is not available yet. Stable installers will be listed on [GitHub Releases](https://github.com/marvinli001/wevir/releases).

## Run from source

For contributors and developers building Wevir locally. Requirements: Node.js **22.19 or newer** (Node 24 LTS recommended) and pnpm **12.6.0**.

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh
pnpm dev
```

The first run downloads Electron and the pinned Codex runtime. See the [development guide](docs/development.md) for environment setup, commands, and troubleshooting.

## Documentation

- [Desktop workspace layout](docs/architecture/desktop-layout.md)
- [Model protocol gateway](docs/architecture/model-gateway.md)
- [Security](docs/security.md)
- [Architecture decision records](docs/adr/README.md)
- [Development guide](docs/development.md)

## License

Wevir is licensed under the [MIT License](LICENSE). See [NOTICE](NOTICE) for upstream code and third-party attributions.
