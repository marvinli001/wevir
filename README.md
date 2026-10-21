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

<p align="center">English · <a href="./README.zh-CN.md">简体中文</a> · <a href="#downloads">Downloads</a></p>

---

## Overview

Wevir is an open-source, local-first workspace for AI coding agents. Agent sessions, approvals, code review, files, and a browser the agent can drive all live in one desktop app, backed by a local Host that the `wevir` CLI shares.

## Features

### Models and accounts

- **Most providers through one runtime**: OpenAI, Anthropic, Google AI Studio, Google Vertex AI, Azure OpenAI / Microsoft Foundry, SpaceXAI (Grok API), DeepSeek, Alibaba Cloud Model Studio, Kimi, Z.ai / Zhipu GLM, Xiaomi MiMo, RedPill, Ollama (local and cloud), and any OpenAI-compatible endpoint. The gateway converts requests to OpenAI Responses, Chat Completions, or Anthropic Messages, including reasoning and tool calls.
- **Keys stay in the Host**: API keys are kept in the Host's secret store and never passed to the runtime process.
- **Subscriptions**: Sign in with ChatGPT, or use a Claude, Cursor, OpenCode, Grok, Antigravity, WorkBuddy, or Devin subscription you already have. Wevir can download the vendor's official client and sign you in from Settings, using the vendor's own sign-in flow.
- **Switch mid-session**: Change model and reasoning effort between turns, or hand a session to another provider with a summary of what it missed.

### Sessions

- **Live timeline**: Streaming replies, plans, tool calls, subagents (each opens as its own session), approvals, and questions from the agent.
- **Ways to steer**: Plan mode, long-running goals, steer or queue messages while a turn runs, compact context, and code review.
- **Permission modes**: Ask for approval, auto-approve, or full access.
- **Branch and recover**: Ask side questions without derailing the main thread, branch into a new session, rewind the last turn, and get a short recap when you come back.
- **Isolation**: Start a session in a fresh Git worktree, group several folders into an environment, or chat without a project.
- **Rich input**: Images in messages, and follow-up tasks the agent suggests that start with one click.

### Code and files

- **Change review**: Checkpoints before and after every turn; diffs for uncommitted work, the current branch, or a single turn.
- **Files**: Search, browse, preview, and edit project files, including sandboxed HTML preview.
- **Code intelligence**: Go-to-definition, references, symbols, call hierarchy, and diagnostics through language servers already installed on your machine (TypeScript, Python, Go, Rust, C/C++, Swift).

### Tools for the agent

- **Built-in browser**: The agent can open pages, read accessibility snapshots, and interact with them inside the app.
- **Web access**: Web search (Bocha or Tavily) and page fetching for models connected through the gateway.
- **Workspace tools**: Background processes, project and global memory, a shared task board, starting and messaging other sessions, and roles that preset a model, permissions, and instructions.
- **Plugins**: MCP servers, Skills, and plugin packages (Wevir, Codex, and Claude formats). The agent can install them from chat after you approve.

### Local Host

- **One Host, many clients**: The desktop app and CLI share sessions, the event log, and approvals; clients reconnect and resume where they left off.
- **Local storage**: Sessions and settings stay in a local data directory (SQLite and plain files).
- **Ten languages**: English, Simplified and Traditional Chinese, French, German, Italian, Spanish, Japanese, Korean, and Russian.

<a id="downloads"></a>

## Downloads

<img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" />

| Platform | Installer |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://wevir.si/en/download/#platforms) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [Download DMG](https://wevir.si/en/download/#platforms) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [Download EXE](https://wevir.si/en/download/#platforms) |

## Run from source

Requires Node.js **24.15+** (Node 24 LTS) and pnpm **12.6.0**.

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh   # download the pinned Codex runtime
pnpm dev                      # start the desktop app
```

To use the CLI, run `pnpm build` once, then `pnpm --silent wevir --help`. Commands, repository layout, and contribution rules are in [AGENTS.md](AGENTS.md).

## License

[MIT License](LICENSE). Upstream code and third-party attributions: [NOTICE](NOTICE).
