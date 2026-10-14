# model-gateway 的测试夹具

| 路径 | 内容 |
|---|---|
| `codex-requests/` | 真实 `codex-app-server`（`rust-v0.162.1`）发出的 4 个请求，脱敏后作映射测试的输入；由 `spikes/codex-app-server/src/record-requests.ts` 录制，每个文件的 `recordedBy`、`description` 写明来源与内容，清单见 docs/architecture/model-gateway.md §8。根 `biome.json` 排除了这个目录 |
| `codex.ts` | 扮演 Codex：读样本、按 Codex 的请求头发请求（`CODEX_METADATA_HEADERS` 是假值）、按 Codex 解析流的规则检查网关发回的事件（`codexProblems`） |
| `model-script.ts` | 脚本化模型的公共部分（改写自 Spike 的同名文件）：用例只写“模型这一步做什么”，另有 finish_reason、流中的错误、提前断开、原样的 chunk |
| `mock-server.ts` | 两个 mock 上游共用的 HTTP 外壳：记录请求（Key 只记方案与长度，另存 Authorization 原值供核对）、是否被中断；`disconnect`、`closedPort` |
| `mock-responses.ts` | 脚本化的 Responses 上游（改写自 Spike）；请求里没有同名 custom 工具时把 custom 调用回成参数为 `{"input"}` 的函数调用，模拟摊平之后的上游 |
| `mock-chat.ts` | 脚本化的 Chat Completions 上游（改写自 Spike），推理按 DeepSeek 的方式放在 `reasoning_content`，函数名按网关摊平的规则得出 |

`src/__snapshots__/codex-requests/*.chat.json` 是四个样本经 Chat 转换后的请求（`chat/request.test.ts` 的文件快照），同样被 biome 排除。样本与快照里含 Codex 内置工具的定义与描述、Codex 注入的权限与 skills 说明（Apache-2.0，docs/upstream/UPSTREAM.md §4.1）。
