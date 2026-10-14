# adapter-dsh 的测试夹具

| 路径 | 内容 |
|---|---|
| `fake-dsh.mjs` | 假 dsh：按 ACP 的 NDJSON 帧回应，`FAKE_DSH_MODE` 决定行为（文件头有说明）；DshProcess 与 DshAdapter 的单元测试、契约测试的回放层（T3.6：`replay:permission` 按审批的回复在 B / C / D 之间分支，`FAKE_DSH_STORE=1` 把会话记在 DSH_HOME）用 |
| `mock-model.ts` | 本地脚本化的 OpenAI Chat Completions 流式服务，真实 dsh 的集成测试用，不需要 Key；经 `../testing.ts`（子路径 `@wevir/adapter-dsh/testing`）导出给 Host 的端到端测试 |
| `real-model.ts` | 真实模型的配置。`realModelSetup`：overlay，设了 `WEVIR_TEST_API_KEY` 的集成测试共用（默认 DeepSeek 官方路由，`WEVIR_TEST_BASE_URL` / `WEVIR_TEST_MODEL` 改走 OpenAI 兼容服务）；`realProviderFromEnv`：契约测试第 3 层的 ProviderConfig，另需 `WEVIR_TEST_PROVIDER` |
| `escalation.ts` | 触发审批的提示词与 mock 脚本（工作区外写入 → 沙箱拒绝 → 升级重试，T3.3），审批的集成测试与契约测试共用 |
| `contract.ts` | 三层契约测试（`../dsh-adapter.contract*.test.ts`，T3.6）共用：临时目录、引擎退出与资源释放的钩子、提示词、mock Provider 的脚本与 ProviderConfig |
| `outside-dir.ts` | 审批用例的目标目录：工作区外、且不在系统临时目录（本包的 `.test-outside/`，gitignore） |
| `acp/` | ACP 样本，见下 |
| `stream-tap/frames.sample.json` | stream-tap 旁路帧的抽样（`spikes/dsh-acp/fixtures/stream-tap/mock/`，T0.3） |
| `acp-fixtures.ts` | 读样本、按 DshAdapter 的路径回放录制的工具 |
| `dsh-mapping.ts` | 绑上 `DSH_ENGINE` 的通用映射（`mapAcpUpdate`、`sessionConfigInfo`）与会话队列（`SessionEventQueue`，`streamTap` 是通用队列的 `incremental`）：DshAdapter 经 `@wevir/adapter-acp` 的 `AcpAdapter` 用的是同一份配置，这里给直接回放样本的测试用（R7） |

## `acp/`

`spikes/dsh-acp/fixtures/acp/` 在 `2ce30c0`（T0.3）的原样副本：真实 dsh `0.2.1-alpha.2` + 本地 mock 模型录制，路径与密钥已脱敏（`<TMP>`、`<DSH_HOME>`）。产品代码不引用 `spikes/`（AGENTS.md），所以复制进本包；根 `biome.json` 排除了这个目录，保持录制原样。

另有 T3.2 补录的 5 个 Provider 错误 `errors/prompt-provider-*.json`（每个文件的 `recordedBy` 写明来源）：真实 dsh + 本地 mock Provider，响应体由 mock 给出，由 `../turn-error.integration.test.ts` 复现并逐字比对。

T3.5 补录的 3 个 `session/resume` 错误 `errors/resume-not-resumable.json`、`resume-format-newer.json`、`resume-log-corrupt.json`：真实 dsh 上关闭会话后删掉、改写或写坏它的会话日志，由 `../dsh-adapter.resume.integration.test.ts` 复现并逐字比对（`<SESSION_ID>`、`<DSH_HOME>`、`<CWD>` 是占位符；`WEVIR_RECORD_FIXTURES=1` 时改写样本）。`fake-dsh.mjs` 对 `gone-` / `newer-` / `corrupt-` 开头的会话 ID 回放它们，`<SESSION_ID>` 换成请求里的 ID。

重新录制（dsh 升级，`docs/upstream/UPSTREAM.md` §7 第 3 步）时，来自 T0.3 的文件用 `spikes/dsh-acp` 的 `npm run spike:mock` 重录后替换，`errors/` 下 T3.2、T3.5 补录的 8 个按上面的方法各自重录或核对；然后跑 `acp-mapping.test.ts`：快照的变化就是映射结果的变化；新增的样本文件要在该测试里归到某条用例，或写明由别处覆盖、为什么不属于当前任务。契约测试的回放层（`../dsh-adapter.contract.test.ts`）直接用 `mock/transcripts/` 的 A、B、C、D、F，重录后它要照样通过。
