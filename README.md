<p align="center">
  <img src="./assets/icons/exports/brand/light/mark-128.png" width="56" alt="Wevir" />
</p>

<h1 align="center">Wevir</h1>

<p align="center"><strong>A local-first desktop workspace for AI coding agents</strong></p>

<p align="center">
  <a href="#downloads"><img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /></a>
  <img alt="macOS arm64 and x64" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-80643D?style=flat-square&logo=opensourceinitiative&logoColor=white" /></a>
</p>

<p align="center">English · <a href="./README.zh-CN.md">简体中文</a> · <a href="#downloads">Downloads</a> · <a href="https://github.com/marvinli001/wevir/discussions">Discussions</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/hero-dark.webp" />
    <img src="./assets/readme/hero-light.webp" width="900" alt="A Wevir session: the agent has read files, edited two files, and run the tests, and awaits approval to commit; the changes pane shows the diff" />
  </picture>
</p>

---

## Overview

**Wevir is a Codex-style, open-source desktop workspace for AI coding agents, independent of any single model provider.** It supports your own API keys, any OpenAI-compatible endpoint, and existing subscriptions (most with multiple accounts), with model switching mid-session.

Sessions, approvals, change review, project files, and an agent-driven built-in browser live in one desktop app. A local Host runs the agents and keeps their data on your machine; the `wevir` CLI connects to the same Host.

<p align="center">
  <img src="./assets/readme/wevir-demo.webp" width="900" alt="Demo: the agent adds a TTL to a cache while the session switches from an OpenAI model to DeepSeek, then to a local Ollama model; the picker lists Codex, Claude, Cursor, OpenCode, Grok, and Antigravity subscriptions, with two accounts each for Codex and Claude" />
</p>

### Highlights

- **Model per task, not per app.** The open-source Codex agent runtime runs locally; Wevir's gateway translates its requests for OpenAI, Anthropic, Google, DeepSeek, a dozen other providers, local Ollama, and any OpenAI-compatible endpoint. Switch model or provider between turns within the same session.
- **Multiple subscriptions, multiple accounts.** Codex (ChatGPT), Claude Code, Grok, OpenCode, Antigravity, and Cursor subscriptions work side by side, each with multi-account support. Accounts have isolated sign-in and data, custom labels, and per-account usage in the sidebar; each session runs on the account you choose.
- **Review before anything lands.** Commands outside the sandbox require approval, every turn is checkpointed, and the changes pane shows per-turn, branch, or uncommitted diffs with comments, staging, and commits.
- **Local-first.** Sessions, settings, and API keys stay in a local data directory. Keys are held by the Host and never passed to the agent process.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/diff-dark.webp" />
    <img src="./assets/readme/diff-light.webp" width="900" alt="The changes pane in split view with a TypeScript diff" />
  </picture>
</p>

## Features

### Models and accounts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/providers-dark.webp" />
  <img src="./assets/readme/providers-light.webp" width="400" align="right" alt="Model providers in Settings" />
</picture>

- **One runtime, many providers**: OpenAI, Anthropic, Google AI Studio, Google Vertex AI, Azure OpenAI / Microsoft Foundry, SpaceXAI (Grok API), DeepSeek, Alibaba Cloud Model Studio, Kimi, Z.ai / Zhipu GLM, Xiaomi MiMo, MiniMax, StepFun, Tencent Cloud TokenHub, Azure Claude, RedPill, Ollama (local and cloud), and any OpenAI-compatible endpoint. The gateway converts requests to OpenAI Responses, Chat Completions, or Anthropic Messages, including reasoning and tool calls.
- **Key isolation**: API keys live in the Host's secret store and are never passed to the runtime process.
- **Subscriptions**: ChatGPT sign-in, plus Claude, OpenCode, Grok, Antigravity, WorkBuddy, Devin, and Cursor subscriptions. Wevir runs the vendor's own client or SDK with your existing sign-in; client download and sign-in are available in Settings. Requirements per source: [Status](#status).
- **Multiple accounts**: ChatGPT, Claude, Grok, OpenCode, Antigravity, and Cursor support multiple accounts, with per-account credential and session directories, labels such as Work or Personal, and separate usage. WorkBuddy and Devin are limited to one account.
- **Mid-session switching**: Change model and reasoning effort between turns, or hand a session to another provider with a summary of the history it lacks.

<br clear="right" />

### Sessions

- **Live timeline**: Streaming replies, plans, tool calls, subagents (each its own session), approvals, and agent questions.
- **Steering**: Plan mode, long-running goals, steering or queued messages during a turn, context compaction, and code review.
- **Permission modes**: Ask for approval, auto-approve, or full access.
- **Branch and recover**: Side questions, branching into a new session, rewinding the last turn, and a recap on return.
- **Isolation**: Sessions in a fresh Git worktree, multi-folder environments, or project-free chat.
- **Input**: Image attachments; one-click start for agent-suggested follow-up tasks.

### Code and files

- **Change review**: Checkpoints before and after every turn; diffs for uncommitted work, the current branch, or a single turn.
- **Files**: Search, browse, preview, and edit project files; sandboxed HTML preview.
- **Code intelligence**: Go-to-definition, references, symbols, call hierarchy, and diagnostics via locally installed language servers (TypeScript, Python, Go, Rust, C/C++, Swift).

### Agent tools

- **Built-in browser**: In-app page navigation, accessibility snapshots, and page interaction.
- **Web access**: Web search (Bocha or Tavily) and page fetching for gateway-connected models.
- **Workspace tools**: Background processes, project and global memory, a shared task board, session creation and messaging, and roles that preset a model, permissions, and instructions.
- **Plugins**: MCP servers, Skills, and plugin packages (Wevir, Codex, and Claude formats), installable by the agent from chat after approval.

### Local Host

- **One Host, many clients**: The desktop app and CLI share sessions, the event log, and approvals; clients reconnect and resume from where they left off.
- **Local storage**: Sessions and settings in a local data directory (SQLite and plain files).
- **Ten languages**: English, Simplified and Traditional Chinese, French, German, Italian, Spanish, Japanese, Korean, and Russian.

## Status

Wevir is in preview. **Supported**: shipped in the builds and covered by automated tests. **Beta**: functional, with less test coverage, a third-party client dependency, or no real-account verification yet. **Planned**: not yet available.

| Area | Item | Status |
| --- | --- | --- |
| Desktop app | macOS, Apple silicon | Supported |
| | macOS, Intel | Beta |
| | Windows x64 | Beta |
| | Linux x64 and arm64 (AppImage, deb) | Beta |
| Models | Codex runtime with API keys, OpenAI-compatible endpoints, or Ollama | Supported |
| | ChatGPT sign-in | Supported |
| Subscriptions | Claude | Beta |
| | OpenCode | Beta |
| | Grok | Beta |
| | Antigravity | Beta |
| | WorkBuddy | Beta |
| | Devin | Beta |
| | Cursor | Beta |
| Other | `wevir` CLI | Beta |
| | Computer use | Beta |
| | Mobile app | Planned |

## Known limitations

- **Preview builds only.** Every published build is a development build (`0.0.1-beta.N`), cut automatically from `master` after CI passes. Frequent updates; behavior may change between builds.
- **Update channel.** In-app updates follow the development channel; the stable channel has no releases yet.
- **Subscription sources.** They depend on each vendor's client or SDK and your existing sign-in, are subject to vendor terms, and may break when the client changes.
- **Platforms.** No Windows on Arm build. Computer use is macOS only. On Linux only the AppImage updates in place; the deb build shows new versions with a link to the download page.

Bug reports: [GitHub Issues](https://github.com/marvinli001/wevir/issues). Questions and ideas: [GitHub Discussions](https://github.com/marvinli001/wevir/discussions).

<a id="downloads"></a>

## Downloads

<img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" />

| Platform | Installer |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://wevir.si/en/download/#platforms) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://wevir.si/en/download/#platforms) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [Download EXE](https://wevir.si/en/download/#platforms) |

## Run from source

Requirements: Node.js **24.22.1+** (Node 24 LTS) and pnpm **12.6.0**.

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh   # fetch the pinned Codex runtime
pnpm dev                      # start the desktop app
```

CLI: run `pnpm build` once, then `pnpm --silent wevir --help`. Commands, repository layout, and contribution rules: [AGENTS.md](AGENTS.md).

## Related repositories

| Repository | Contents |
| --- | --- |
| [Wevir-Labs/wevir-marketplace](https://github.com/Wevir-Labs/wevir-marketplace) | Official plugin and skill marketplace |
| [marvinli001/wevir-web](https://github.com/marvinli001/wevir-web) | Web client and official relay (web.wevir.si) |

## License

[MIT License](LICENSE). Upstream code and third-party attributions: [NOTICE](NOTICE).
