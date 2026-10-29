# adapter-codex 的测试夹具

| 路径 | 内容 |
|---|---|
| `app-server/<场景>.jsonl` | 真实 `codex-app-server`（`rust-v0.163.0`）+ 网关（Responses 透传）+ `mock-model.ts` 录下的通知序列，映射单元测试（`../mapping.test.ts`）与假的 app-server 的输入。每个文件第一行是 `{"_meta": …}`（版本、场景、说明、提示词），其余每行一条 `{"method", "params"}`，只含属于该会话及其子 thread 的通知；工作区、数据目录、家目录、临时目录换成了 `<workspace>`、`<data>`、`<home>`、`<tmp>`。场景：`stream`、`tool-read`、`tool-search`、`tool-shell`、`apply-patch`、`upstream-error`、`cancel`、`subagent`、`plan` |
| `app-server/approval-<exec\|patch>.jsonl`、`approval-<…>.<分支>.jsonl` | 审批对话（R3）：同一场景跑几遍、每遍在审批请求之后做不同的决定。前缀到审批请求为止（请求写成 `{"serverRequest": {"id", "method", "params"}}`），每个分支是请求之后的部分：命令有 `accept`、`decline`、`cancel` 与 `interrupt`（审批挂起时 `turn/interrupt`），补丁有 `accept` 与 `cancel`。thread、回合、item 与请求的 ID 换成 `<thread>`、`<turn>`、`<item:N>`（按首次出现的顺序）、`<request>`，分支之间对得上；工作区外的目录换成 `<outside>` |
| `app-server/elicitation-<form\|url>.jsonl`、`elicitation-<…>.<accept\|decline>.jsonl` | 用户接入的 MCP 服务在工具调用里要用户输入（表单与链接两种 `mcpServer/elicitation/request`）。手写的，照 `rust-v0.163.0` 的 `v2/McpServerElicitationRequestParams.ts`，格式同审批对话；假的 app-server 按回复的 `action` 接分支，把回复记在 `fake-replies.jsonl`。`../codex-adapter.elicitation.test.ts` 用 |
| `app-server/errors/turn-*.json` | 回合失败（R3）：`turn/completed` 的参数（status `failed`），上游 401 / 429 / 500 / 400、Provider 没有 Key（网关 401）、连不上上游（网关 502）。`../turn-error.test.ts` 逐条归类 |
| `app-server/errors/resume-*.json` | 恢复失败（R3）：`thread/resume` 的 JSON-RPC 错误码与原文，没有 rollout、不是 UUID、rollout 损坏。`../resume-error.test.ts` 逐条归类，假的 app-server 回放同样的措辞 |
| `record-app-server.test.ts` | 录上面的样本。平时跳过；升级 Codex 后在仓库根目录运行 `WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server` 重录（`-t` 可以只录其中一组），再跑映射、归类测试与契约第 1 层看差异 |
| `fake-app-server.mjs` | 假的 `codex-app-server`（契约第 1 层，R3）：只用 Node 内置模块，说 app-server 的逐行 JSON，按提示词 `replay:<场景>` 回放上面的样本（其余提示词回放 `stream`），ID 换成当前的；审批按回复接对应的分支，`turn/interrupt` 停止回放或接 interrupt 分支；有过回合的 thread 记在 cwd（CODEX_HOME）下的 `fake-threads.json`，进程被杀后能 `thread/resume`。适配器用 `binary: process.execPath` 与 `binaryArgs: [脚本路径]` 运行它 |
| `mock-model.ts` | 脚本化的 OpenAI Responses 流式服务（改写自 `packages/model-gateway/src/test-fixtures/mock-responses.ts`），默认脚本按提示词里的关键词回答：调 `exec_command`（`ls`）、apply_patch、越出沙箱的 `touch`（审批）、长回答（取消），也回会话标题的请求；`mockProvider()` 给出指向它的 Provider。经 `@wevir/adapter-codex/testing` 导出给 Host 的集成测试与桌面验收用 |
| `contract.ts` | 三层契约测试共用：引擎退出与资源释放的钩子、审批用例的提示词与 mock 脚本（越出沙箱的 `exec_command`） |
| `real-model.ts` | 契约第 3 层的 Provider：从 `WEVIR_TEST_API_KEY`、`WEVIR_TEST_PROVIDER` 等环境变量读，没有就跳过并给出原因 |
| `outside-dir.ts` | 审批用例写的工作区外目录 `packages/adapter-codex/.test-outside/`（不在系统临时目录下，gitignore），用完删掉 |
| `harness.ts` | 真实二进制的测试共用部分：二进制不在时跳过并打印下载命令、临时目录、收集告警的日志、关掉重试的建适配器、收事件与等回合结束 |

样本里有 Codex 内置工具名与它生成的条目（Apache-2.0，docs/upstream/UPSTREAM.md §4.1）。
