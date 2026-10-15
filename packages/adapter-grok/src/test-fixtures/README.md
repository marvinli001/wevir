# adapter-grok 的测试夹具

| 路径 | 内容 |
|---|---|
| `fake-grok.mjs` | 假 `grok`：回答 `--version`、`grok models`，`agent stdio` 说 ACP 并回放下面的样本（文件头有说明）；`WEVIR_GROK_BIN` 指向它 |
| `harness.ts` | 临时目录、接上假 grok 的适配器、读样本与假 grok 的消息日志、收集事件 |
| `acp/` | ACP 样本，见下 |

## `acp/`

T3 Code（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，MIT，`ec1313c8f8333292506f05a355bb72d308a455d8`）的 `apps/server/src/orchestration-v2/testkit/fixtures/<场景>/grok_transcript.ndjson` 的原样副本，文件名改成场景名：T3 的录制器（`live-grok-recorder`）对着真实 Grok Build 1.0.41（`grok_prompt_error` 是 1.0.44）录的 ACP 往返，会话 ID、工作区、HOME 与 T3 自己的提示词已由 T3 换成占位符；`plan_questions` 是 T3 的形状探测（`live-grok-shape-probe`）合成的。每行一条：`expect_outbound` 是客户端发的，`emit_inbound` 是 Grok 写出的。其中 Grok 的输出受 xAI 的条款约束（docs/upstream/UPSTREAM.md §4.1、`NOTICE` 第 10 节）。

| 样本 | 覆盖 |
|---|---|
| `simple` | 一问一答：逐字的思考与消息、`session_info_update`、`turn_completed` / `prompt_complete` 先于 `session/prompt` 的结果；`initialize` 与 `session/new` 的结果也取自它 |
| `todo_list` | 工具（`search_tool`、`list_dir`、`read_file`）、两次 `todo_write`（第二次 `merge: true`）与随后的 `plan` |
| `tool_call_read_only_on_request` | 写文件的审批（`allow-edits-session` / `allow-once` / `reject-once`） |
| `grok_prompt_error` | 上游 400：`prompt_complete` 的 `error` 先于 `-32603` 的 `session/prompt` 错误；第二个 prompt 恢复 |
| `message_steering` | `session/cancel`（`cancelTrigger: ctrl_c`）与随后的 prompt |
| `plan_questions` | `_x.ai/ask_user_question` 与回答 |
| `grok_background_bash` | 后台命令，以及它结束后 Grok 自己开的回合（`task-completed-*`） |

重新录制要在 T3 Code 里跑它的 `apps/server/scripts/record-grok-acp-replay-fixture.ts`，或者照同样的格式用真实 `grok` 录；换了样本之后跑 `pnpm vitest run --project adapter-grok`。
