# Kiro ACP 测试夹具

`fake-kiro.mjs` 是本机假的 Kiro CLI（`kiro-cli`），不登录、不联网、不运行模型或工具。`acp.ndjson` 是按 2026-10-30 核对的 Kiro CLI 2.36.0 合成的样本，**不是带账号的录音**：`--version`、没登录时 `whoami --format json` 的 `{"account":null}`、没登录时 `kiro-cli acp` 在 stderr 打印 “Not logged in…” 并以 1 退出、`login --use-device-flow` 打印的三行（码与网址）是在空的 HOME 里对官方程序读到的；`initialize` 的 `loadSession` 与 `promptCapabilities.image` 取自官方文档（kiro.dev/docs/cli/acp）；登录后 `session/new` 的 `models`、`session/set_model`、工具调用、审批与 `session/load` 找不到会话的错误都没有账号核对不了，是照 ACP 通用形状写的。

子命令：`--version`；`whoami --format json`；`login … --use-device-flow` 打印与真 CLI 相同的三行，等 `FAKE_KIRO_AUTH_DONE` 文件出现再写下登录状态并以 0 退出，`FAKE_KIRO_AUTH_FAIL=1` 时以 1 退出；`logout`；`acp --agent-engine v2`。登录状态是 `FAKE_KIRO_STATE` 文件（真 CLI 存在 data.sqlite3 里），或 `FAKE_KIRO_SIGNED_IN=1`。`authenticate` 一律失败，用于暴露意外认证。会话只写入测试指定的 store 目录；`session/load` 先回放存下的历史再回答。
