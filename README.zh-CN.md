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

---

## 简介

Wevir 是开源、本地优先的 AI 编程 Agent 工作台。Agent 会话、审批、代码审阅、项目文件，以及 Agent 可以操作的内置浏览器，都在同一个桌面应用里；背后是本地 Host，`wevir` 命令行与桌面端共用它。

## 能力

### 模型与账号

- **一套运行时接多家模型**：OpenAI、Anthropic、Google AI Studio、Google Vertex AI、Azure OpenAI / Microsoft Foundry、SpaceXAI（Grok API）、DeepSeek、阿里云百炼、Kimi、Z.ai / 智谱 GLM、小米 MiMo、RedPill、Ollama（本机与云端），以及任意 OpenAI 兼容接口。网关把请求转换为 OpenAI Responses、Chat Completions 或 Anthropic Messages，推理与工具调用一并转换。
- **密钥只在 Host**：API Key 存在 Host 的密钥存储里，不交给运行时进程。
- **订阅**：用 ChatGPT 账号登录，或直接用已有的 Claude、Cursor、OpenCode、Grok、Antigravity、WorkBuddy、Devin 订阅。Wevir 可以在设置里下载厂商的官方客户端并完成登录，走的是厂商自己的登录流程。
- **会话中切换**：回合之间换模型与推理档位，或把会话交给另一个模型服务，并附上它没看到的那段历史的摘要。

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
