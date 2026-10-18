# WorkBuddy ACP 测试夹具

`fake-codebuddy.mjs` 是本机假服务，不登录、不联网、不运行模型或工具。`acp.ndjson` 是按 2026-10-18 核对的 CodeBuddy Code 2.168.2 ACP 形状合成的样本，**不是带账号的录音**；模型 ID 都是 fixture 值。initialize 的关键能力和未认证错误已在空用户目录的官方 CLI 上核对。

样本覆盖 configOptions（含未知 boolean 选项）、普通审批、AskUserQuestion、plan、工具、usage_update 的积分和未知 `_meta`。`--version`、登录错误与配置失败由 `FAKE_WORKBUDDY_*` 测试变量控制。`authenticate` 总是失败，用于暴露意外认证。会话只写入测试指定的 store 目录；harness 负责回收。
