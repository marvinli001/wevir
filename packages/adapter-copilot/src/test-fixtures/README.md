# GitHub Copilot ACP 测试夹具

`fake-copilot.mjs` 是本机假的 GitHub Copilot CLI，不登录、不联网、不运行模型或工具。`acp.ndjson` 是按 2026-10-25 核对的 Copilot CLI 1.0.103 合成的样本，**不是带账号的录音**：`initialize` 的形状与没登录时 `session/new` 的 “Authentication required” 是在空配置目录、断网的官方 CLI 上读到的；登录后的模型选项（ID 没有公开，只知道类别是 `model`）、工具调用、审批、`session/load` 找不到会话的错误与 `assistant.usage` 的额度都没有账号核对不了，是照 ACP 通用形状与 CLI 自带的 session-events schema 写的。

子命令：`--version`；`login --device-code` 打印与真 CLI 相同的两行（网址与码），等 `FAKE_COPILOT_AUTH_DONE` 文件出现再写下登录状态并以 0 退出，`FAKE_COPILOT_AUTH_FAIL=1` 时打印 “Login failed: …” 以 1 退出；`--acp --stdio`。登录状态是 `<COPILOT_HOME>/config.json` 里的 `lastLoggedInUser`（与真 CLI 记账号的位置相同；真 CLI 的令牌在系统钥匙串里），或 `FAKE_COPILOT_SIGNED_IN=1`。ACP 的 `logout` 删掉 `lastLoggedInUser`；`authenticate` 一律失败，用于暴露意外认证。会话只写入测试指定的 store 目录；`session/load` 先回放存下的历史再回答；`FAKE_COPILOT_USAGE=1` 时每个回合发一条 `github.com/copilot/sessionEvent` 的 `assistant.usage`。
