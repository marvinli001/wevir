# Devin ACP 测试夹具

`fake-devin.mjs` 是本机假的 Devin CLI，不登录、不联网、不运行模型或工具。`acp.ndjson` 是按 2026-10-21 核对的 Devin CLI 3000.11.92 合成的样本，**不是带账号的录音**：`initialize`、`mode` 与 `model` 选项的形状、未登录时 `session/prompt` 的错误、`session/load` 找不到会话的错误都在空用户目录的官方 CLI 上核对过（没登录时真 CLI 的模型选项是空的，模型 ID 是 fixture 值）；工具调用与审批的形状没有账号核对不了，是照 ACP 通用形状写的。

子命令：`--version`、`auth status`（`FAKE_DEVIN_AUTH_STATE` 文件存在或 `FAKE_DEVIN_SIGNED_IN=1` 时报已登录）、`auth logout`（删掉那个文件）、`acp`。`authenticate` 默认失败，用于暴露意外认证；只有测试设了 `FAKE_DEVIN_ALLOW_AUTH=1` 才走合成的登录：等 `FAKE_DEVIN_AUTH_DONE` 文件出现再成功（写下 `FAKE_DEVIN_AUTH_STATE`），或按 `FAKE_DEVIN_AUTH_FAIL` 失败。会话只写入测试指定的 store 目录；`session/load` 先回放存下的历史再回答；harness 负责回收。
