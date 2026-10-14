# adapter-codex 的测试夹具

| 路径 | 内容 |
|---|---|
| `app-server/*.jsonl` | 真实 `codex-app-server`（`rust-v0.162.1`）+ 网关（Responses 透传）+ `mock-model.ts` 录下的通知序列，映射单元测试（`../mapping.test.ts`）的输入。每个文件第一行是 `{"_meta": …}`（版本、场景、说明、提示词），其余每行一条 `{"method", "params"}`，只含属于该会话及其子 thread 的通知；工作区、数据目录、家目录、临时目录换成了 `<workspace>`、`<data>`、`<home>`、`<tmp>`。场景：`stream`、`tool-read`、`tool-search`、`tool-shell`、`apply-patch`、`upstream-error`、`cancel`、`subagent` |
| `record-app-server.test.ts` | 录上面的样本。平时跳过；升级 Codex 后在仓库根目录运行 `WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server` 重录，再跑映射测试看差异 |
| `mock-model.ts` | 脚本化的 OpenAI Responses 流式服务（改写自 `packages/model-gateway/src/test-fixtures/mock-responses.ts`），默认脚本按提示词里的关键词回答、调 `exec_command`（`ls`）或 apply_patch；`mockProvider()` 给出指向它的 Provider。经 `@wevir/adapter-codex/testing` 导出给 Host 的集成测试与桌面验收用 |
| `harness.ts` | 真实二进制的测试共用部分：二进制不在时跳过并打印下载命令、临时目录、收集告警的日志、关掉重试的建适配器 |

样本里有 Codex 内置工具名与它生成的条目（Apache-2.0，docs/upstream/UPSTREAM.md §4.1）。
