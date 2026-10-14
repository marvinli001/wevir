# Wevir

Wevir 是面向中国大陆用户的**本地优先、开源、多模型、可跨设备接续的 Agent 工作台**，覆盖代码开发、文件、资料与办公任务。它以 [OpenAI Codex](https://github.com/openai/codex) 的 app-server 为默认 Agent 执行内核、经 Host 内置的模型协议网关接各家模型服务（[ADR-0005](docs/adr/0005-agent-runtime-and-model-gateway.md)，迁移中；骨架阶段的引擎是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh），以后保留为可选引擎），自己拥有 Local Agent Host、版本化的会话协议和桌面 / 命令行客户端：会话与审批的事实在本机的 Host 里，多个客户端看同一条事件流，模型可以选 DeepSeek 或任一 OpenAI 兼容服务。

## 当前状态：骨架已完成

骨架阶段把“建会话 → 发提示 → 看流式输出 → 审批 → 取消 → 重启恢复”这条线竖着打通了（计划已归档：[SKELETON_PLAN](docs/archive/skeleton/SKELETON_PLAN.md) §4.2）。现在能做的：

- 桌面端（Electron，开发模式）：添加工作区、配置 Provider 并测试连接、新建会话，看到流式回答、工具调用与内联的审批卡片，运行中取消，退出再打开后历史完整、可以接着对话；Host 意外退出会自动重新拉起并补齐事件。
- Host 以真实 dsh 为引擎；另有 echo 假引擎用于离线开发和测试。换成 Codex 的方案与验证见 [ADR-0005](docs/adr/0005-agent-runtime-and-model-gateway.md) 与 [Codex 研读](docs/research/codex-notes.md)。
- 还没有：安装包、手机端、远程访问、终端面板、Diff 与文件预览、Skills / MCP 管理。用真实模型 Key 跑完整对话、Windows 上的 `pnpm dev` 都还没验证。

## 快速开始

需要 Node ≥ 22.19（推荐 24 LTS）与 pnpm 12.6.0。

```bash
pnpm install
```

```bash
pnpm dev
```

第一次 `pnpm dev` 会下载 Electron 二进制。在大陆网络下先切换 npm 镜像、设好 `ELECTRON_MIRROR`，见[开发指南 §7](docs/development.md#7-大陆网络)。

- [开发指南](docs/development.md)：环境、运行、数据目录与日志、离线开发、测试、大陆网络、常见问题
- [架构总览](docs/architecture/overview.md)：分层、各包职责、一次请求的数据流
- [安全说明](docs/security.md)：信任边界、密钥、dsh 沙箱
- 架构决策：[docs/adr/](docs/adr/README.md) · 骨架复盘：[docs/retro/skeleton.md](docs/retro/skeleton.md) · 已归档的计划：[docs/archive/](docs/archive/)
- 贡献者与 AI 助手的仓库规则：[AGENTS.md](AGENTS.md)

许可证：[MIT](LICENSE)。移植自上游与其他第三方来源的文件及其版权声明见 [NOTICE](NOTICE)。
