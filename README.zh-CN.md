<p align="center">
  <img src="./assets/icons/exports/brand/light/mark-128.png" width="56" alt="Wevir" />
</p>

<h1 align="center">Wevir</h1>

<p align="center"><strong>本地优先的 AI 编程 Agent 桌面工作台</strong></p>

<p align="center">
  <a href="#downloads"><img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" /></a>
  <img alt="macOS arm64 and x64" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-111111?style=flat-square&logo=apple&logoColor=white" />
  <img alt="Windows x64" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" />
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-80643D?style=flat-square&logo=opensourceinitiative&logoColor=white" /></a>
</p>

<p align="center"><a href="./README.md">English</a> · 简体中文 · <a href="#downloads">下载</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/hero-dark.webp" />
    <img src="./assets/readme/hero-light.webp" width="900" alt="Wevir 的一个会话：Agent 读了文件、改了两个文件并跑了测试，正在等待批准提交；右侧变更窗格显示差异" />
  </picture>
</p>

---

## 简介

**Wevir 是 Codex 式的 AI 编程 Agent 桌面工作台，不绑定某一家模型服务。** 用自己的 API Key、任意 OpenAI 兼容接口或已有的订阅（多数可加多个账号），会话进行中也能换模型。

会话、审批、变更审阅、项目文件，以及 Agent 可以操作的浏览器，都在同一个开源桌面应用里。本地 Host 运行 Agent，数据留在你的电脑上；`wevir` 命令行连的是同一个 Host。

### 为什么用 Wevir

- **按任务选模型，而不是按应用。** 开源的 Codex Agent 运行时在本机运行，Wevir 的网关把它的请求转换给 OpenAI、Anthropic、Google、DeepSeek 等十余家模型服务、本机 Ollama 与任意 OpenAI 兼容接口。回合之间换模型或换服务，不用离开当前会话。
- **多个订阅，每个都能加多个账号。** 已经付费的 Codex（ChatGPT）、Claude Code、Grok、OpenCode、Antigravity、Cursor 订阅可以同时用，每种都能添加多个账号。每个账号有独立的登录与数据、自定的标签，侧栏里单独显示用量，会话用哪个账号由你选。
- **改动落地前先审阅。** 沙箱外的命令要你批准；每个回合都有检查点；变更窗格按回合、分支或未提交查看差异，可以批注、暂存并提交。
- **本地优先。** 会话、设置与 API Key 留在本机的数据目录。Key 由 Host 保管，不交给 Agent 进程。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/diff-dark.webp" />
    <img src="./assets/readme/diff-light.webp" width="900" alt="变更窗格的左右对照视图，显示一段 TypeScript 差异" />
  </picture>
</p>

## 能力

### 模型与账号

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/readme/providers-dark.webp" />
  <img src="./assets/readme/providers-light.webp" width="400" align="right" alt="设置里可以添加的模型服务列表" />
</picture>

- **一套运行时接多家模型**：OpenAI、Anthropic、Google AI Studio、Google Vertex AI、Azure OpenAI / Microsoft Foundry、SpaceXAI（Grok API）、DeepSeek、阿里云百炼、Kimi、Z.ai / 智谱 GLM、小米 MiMo、MiniMax、阶跃星辰、腾讯云 TokenHub、Azure Claude、RedPill、Ollama（本机与云端），以及任意 OpenAI 兼容接口。网关把请求转换为 OpenAI Responses、Chat Completions 或 Anthropic Messages，推理与工具调用一并转换。
- **密钥只在 Host**：API Key 存在 Host 的密钥存储里，不交给运行时进程。
- **订阅**：用 ChatGPT 账号登录，或直接用已有的 Claude、OpenCode、Grok、Antigravity、WorkBuddy、Devin、Cursor 订阅。Wevir 用厂商自己的客户端或 SDK 与你现有的登录运行，可以在设置里下载客户端并发起登录。各来源的要求见[状态](#状态)。
- **多账号**：ChatGPT、Claude、Grok、OpenCode、Antigravity、Cursor 都能添加多个账号。每个账号的凭据与会话放在各自的目录里，可以加“工作”“个人”之类的标签，用量分开统计。WorkBuddy 与 Devin 各只支持一个账号。
- **会话中切换**：回合之间换模型与推理档位，或把会话交给另一个模型服务，并附上它没看到的那段历史的摘要。

<br clear="right" />

### 会话

- **实时时间线**：流式回复、计划、工具调用、子 Agent（各自是一个会话）、审批与 Agent 的提问。
- **多种引导方式**：计划模式、长期目标、回合进行中插话或排队、压缩上下文、代码审查。
- **权限模式**：请求批准、自动批准、完全访问。
- **分支与回退**：支线提问不打断主线，分支到新会话，撤回最后一个回合，离开一阵回来时给出简短回顾。
- **隔离**：在新的 Git worktree 里开会话，把多个文件夹组成环境，或不建项目直接对话。
- **丰富的输入**：消息可以带图片；Agent 建议的后续任务一键开始。

### 代码与文件

- **变更审阅**：每个回合前后自动留检查点；查看未提交、本分支或单个回合的差异。
- **文件**：搜索、浏览、预览与编辑项目文件，HTML 在沙箱里预览。
- **代码智能**：跳转定义、查找引用、符号、调用层级与诊断，用本机已装的语言服务器（TypeScript、Python、Go、Rust、C/C++、Swift）。

### Agent 的工具

- **内置浏览器**：Agent 可以在应用里打开网页、读取无障碍快照并操作页面。
- **联网**：经网关接入的模型可用网页搜索（博查或 Tavily）与网页抓取。
- **工作区工具**：后台进程、项目与全局记忆、共享任务清单、新开会话并互发消息，以及预设模型、权限与说明的角色。
- **插件**：MCP 服务、Skills 与插件包（支持 Wevir、Codex、Claude 格式）；经你批准后，Agent 可以在对话里安装。

### 本地 Host

- **一个 Host，多个客户端**：桌面端与命令行共用会话、事件记录与审批；断线后重连，从断开处继续。
- **本地存储**：会话与设置留在本机的数据目录（SQLite 与普通文件）。
- **十种界面语言**：英语、简体中文、繁体中文、法语、德语、意大利语、西班牙语、日语、韩语、俄语。

## 状态

Wevir 还在预览阶段。**支持**：包含在安装包里，有自动化测试覆盖。**测试版**：能用，但测试覆盖较少、依赖第三方客户端，或还没用真实账号验证过。**计划中**：还不能用。

| 方面 | 项目 | 状态 | 说明 |
| --- | --- | --- | --- |
| 桌面端 | macOS，Apple 芯片 | 支持 | 已签名并公证 |
| | macOS，Intel | 测试版 | 已构建并公证；CI 测试跑在 Apple 芯片上 |
| | Windows x64 | 测试版 | CI 有测试；没有电脑操作 |
| | Linux | 暂无 | 不发布安装包 |
| 模型 | Codex 运行时 + API Key、OpenAI 兼容接口或 Ollama | 支持 | |
| | ChatGPT 账号登录 | 支持 | 走 Codex 运行时自己的登录 |
| 订阅 | Claude | 测试版 | 随包带 Claude Agent SDK；用本机的 Claude 登录 |
| | OpenCode | 测试版 | Wevir 可以下载客户端 |
| | Grok | 测试版 | 需要 `grok` 命令行 |
| | Antigravity | 测试版 | Wevir 下载锁定的版本 |
| | WorkBuddy | 测试版 | 需要 `codebuddy` 命令行 |
| | Devin | 测试版 | 还没用真实账号验证 |
| | Cursor | 测试版 | 只在源码构建里可用：Cursor SDK 不随安装包分发 |
| 其他 | `wevir` 命令行 | 测试版 | 从源码运行，不在安装包里 |
| | 电脑操作 | 测试版 | 仅 macOS，默认关闭 |
| | 移动端 | 计划中 | |

## 已知限制

- **只有预览版。** 发布的都是开发版（`0.0.1-beta.N`），`master` 上 CI 通过后自动打包。更新频繁，版本之间行为可能变化。
- **更新通道。** 应用内更新走开发通道，正式通道还没有发布过版本。
- **订阅来源受厂商约束。** 它们用各家自己的客户端或 SDK 与你现有的登录运行，受各家条款约束，客户端变化时可能失效。
- **平台。** 没有 Linux 与 Windows on Arm 安装包；电脑操作只支持 macOS。
- **命令行。** `wevir` 命令行不在安装包里，要从源码运行。

发现问题或缺口，请到 [GitHub Issues](https://github.com/marvinli001/wevir/issues) 反馈。

<a id="downloads"></a>

## 下载

<img alt="Preview" src="https://img.shields.io/badge/dynamic/yaml?url=https%3A%2F%2Fdownload.wevir.si%2Fdesktop%2Fdarwin-arm64%2Fbeta-mac.yml&query=%24.version&prefix=v&label=preview&color=80643D&style=flat-square&logo=github&logoColor=white" />

| 平台 | 安装包 |
| --- | --- |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Apple%20Silicon-111111?style=flat-square&logo=apple&logoColor=white" /> | [下载 DMG](https://wevir.si/download/#platforms) |
| <img alt="Apple" src="https://img.shields.io/badge/macOS-Intel-111111?style=flat-square&logo=apple&logoColor=white" /> | [下载 DMG](https://wevir.si/download/#platforms) |
| <img alt="Windows" src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows11&logoColor=white" /> | [下载 EXE](https://wevir.si/download/#platforms) |

## 从源码运行

需要 Node.js **24.15+**（Node 24 LTS）与 pnpm **12.6.0**。

```bash
git clone https://github.com/marvinli001/wevir.git
cd wevir
pnpm install
bash scripts/fetch-codex.sh   # 下载锁定版本的 Codex 运行时
pnpm dev                      # 启动桌面端
```

命令行要先 `pnpm build` 一次，再运行 `pnpm --silent wevir --help`。常用命令、目录结构与贡献规则见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT License](LICENSE)。上游移植与第三方版权声明见 [NOTICE](NOTICE)。
