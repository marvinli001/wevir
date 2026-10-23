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
    <img src="./assets/readme/hero-light.webp" width="900" alt="A Wevir session: the agent has read files, edited two files and run the tests, and is waiting for approval to commit; the changes pane shows the diff" />
  </picture>
</p>

---

## Overview

**Wevir is a Codex-style desktop workspace for coding agents that isn't tied to one model provider.** Bring your own API keys, any OpenAI-compatible endpoint, or the subscriptions you already have (most of them with several accounts), and switch models in the middle of a session.

Sessions, approvals, change review, project files, and a browser the agent can drive live in one open-source desktop app. A local Host runs the agents and keeps their data on your machine; the `wevir` CLI talks to the same Host.

<p align="center">
  <img src="./assets/readme/wevir-demo.webp" width="900" alt="Demo: the agent adds a TTL to a small cache while the session switches from an OpenAI model to DeepSeek and then to a local Ollama model, and the picker lists Codex, Claude, Cursor, OpenCode, Grok, and Antigravity subscriptions with two accounts each for Codex and Claude" />
</p>

### Why Wevir

- **Pick the model per task, not per app.** The open-source Codex agent runtime runs locally, and Wevir's gateway translates its requests for OpenAI, Anthropic, Google, DeepSeek, a dozen other providers, local Ollama, and any OpenAI-compatible endpoint. Change model or provider between turns without leaving the session.
- **Several subscriptions, several accounts each.** Use the Codex (ChatGPT), Claude Code, Grok, OpenCode, Antigravity, and Cursor subscriptions you already pay for side by side, and add more than one account for each. Every account has its own sign-in and data, a label you choose, and its own usage in the sidebar, so you pick which account a session runs on.
- **Review before anything lands.** Commands outside the sandbox wait for your approval, every turn is checkpointed, and the changes pane shows per-turn, branch, or uncommitted diffs that you can comment on, stage, and commit.
- **Local-first.** Sessions, settings, and API keys stay in a local data directory. Keys are held by the Host and never passed to the agent process.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/diff-dark.webp" />
    <img src="./assets/readme/diff-light.webp" width="900" alt="The changes pane in split view, showing a TypeScript diff" />
  </picture>
</p>

## Features

### Models and accounts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/providers-dark.webp" />
  <img src="./assets/readme/providers-light.webp" width="400" align="right" alt="The list of model providers you can add in Settings" />
</picture>

- **Most providers through one runtime**: OpenAI, Anthropic, Google AI Studio, Google Vertex AI, Azure OpenAI / Microsoft Foundry, SpaceXAI (Grok API), DeepSeek, Alibaba Cloud Model Studio, Kimi, Z.ai / Zhipu GLM, Xiaomi MiMo, MiniMax, StepFun, Tencent Cloud TokenHub, Azure Claude, RedPill, Ollama (local and cloud), and any OpenAI-compatible endpoint. The gateway converts requests to OpenAI Responses, Chat Completions, or Anthropic Messages, including reasoning and tool calls.
- **Keys stay in the Host**: API keys are kept in the Host's secret store and never passed to the runtime process.
- **Subscriptions**: Sign in with ChatGPT, or use a Claude, OpenCode, Grok, Antigravity, WorkBuddy, Devin, or Cursor subscription you already have. Wevir runs the vendor's own client or SDK with your existing sign-in, and can download the client and start its sign-in from Settings. See [Status](#status) for what each source needs.
- **Multiple accounts**: Add several ChatGPT, Claude, Grok, OpenCode, Antigravity, or Cursor accounts. Each one keeps its credentials and sessions in its own directory, can carry a label such as Work or Personal, and reports its own usage. WorkBuddy and Devin take one account each.
- **Switch mid-session**: Change model and reasoning effort between turns, or hand a session to another provider with a summary of what it missed.

<br clear="right" />

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

## Status

Wevir is in preview. **Supported** means it is in the builds and covered by automated tests. **Beta** means it works but has less coverage, relies on a third-party client, or has not been checked against a real account. **Planned** means it is not available yet.

| Area | Item | Status | Notes |
| --- | --- | --- | --- |
| Desktop app | macOS, Apple silicon | Supported | Signed and notarized |
| | macOS, Intel | Beta | Built and notarized; CI tests run on Apple silicon |
| | Windows x64 | Beta | Tested in CI; no computer use |
| | Linux | Not available | No build is published |
| Models | Codex runtime with API keys, OpenAI-compatible endpoints, or Ollama | Supported | |
| | ChatGPT sign-in | Supported | Uses the Codex runtime's own sign-in |
| Subscriptions | Claude | Beta | Claude Agent SDK is bundled; uses your local Claude sign-in |
| | OpenCode | Beta | Wevir can download the client |
| | Grok | Beta | Needs the `grok` CLI |
| | Antigravity | Beta | Wevir downloads a pinned version |
| | WorkBuddy | Beta | Needs the `codebuddy` CLI |
| | Devin | Beta | Not yet checked against a real account |
| | Cursor | Beta | Wevir downloads the Cursor SDK from npm when you set it up; not bundled |
| Other | `wevir` CLI | Beta | Run from a source checkout; not packaged |
| | Computer use | Beta | macOS only, off by default |
| | Mobile app | Planned | |

## Known limitations

- **Preview builds only.** Every published build is a development build (`0.0.1-beta.N`) cut automatically from `master` after CI passes. Expect frequent updates and behaviour changes between builds.
- **Update channel.** In-app updates follow the development channel. The stable channel has no releases yet.
- **Subscription sources depend on their vendors.** They run each vendor's own client or SDK with your existing sign-in, so they are subject to that vendor's terms and can break when the client changes.
- **Platforms.** No Linux or Windows on Arm build. Computer use is macOS only.
- **CLI.** The `wevir` CLI is not in the installers; run it from a source checkout.

Found a bug? Open an issue on [GitHub Issues](https://github.com/marvinli001/wevir/issues). Questions, ideas, and setups you want to share go to [GitHub Discussions](https://github.com/marvinli001/wevir/discussions).

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
