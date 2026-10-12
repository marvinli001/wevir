# spikes/dsh-acp — T0.3：Wevir 以 ACP 接入 DeepSeek Harness

一次性验证代码，不属于 pnpm workspace，不进入产品构建。结论见 [docs/research/dsh-integration-spike.md](../../docs/research/dsh-integration-spike.md)。

## 运行

```bash
npm install          # 精确版本：@deepseek-ai/dsh@0.2.1-alpha.2、@agentclientprotocol/sdk@1.4.0（与 dsh-acp 锁定的版本相同）
npm run spike:mock   # 全流程，模型换成本地脚本化 mock，不需要 Key（约 25 秒）
npm run spike:keyless
npm run spike        # 真实模型，需要 WEVIR_SPIKE_API_KEY；缺少时打印设置说明并退出
npm run check-secrets
```

`npm run spike` 的可选变量：`WEVIR_SPIKE_BASE_URL`（默认 `https://api.deepseek.com`）、`WEVIR_SPIKE_MODEL`（默认 `deepseek-flash`）。附加参数：`--only=<step,...>` 只跑指定步骤，`--keep-home` 不清空 `.dsh-home`。

npm 11 默认不运行依赖的安装脚本；dsh 依赖其中 5 个（`dsh-subprocess-local` 给 node-pty 的 spawn-helper 加执行位、`koffi`、`node-pty`、`protobufjs`、`@google/genai`），已登记在 `package.json` 的 `allowScripts`。

## 隔离

- `DSH_HOME=spikes/dsh-acp/.dsh-home`（gitignore），每次运行先清空；`DSH_AGENTS_HOME` 指向其中的空目录，避免读入 `~/.agents` 的 skills 与 AGENTS.md。
- dsh 进程 cwd 为 `.dsh-home`：dsh 会读取 `<进程 cwd>/.env` 作为凭据回退。
- 子进程环境按白名单继承，只额外注入 `DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_TELEMETRY_DISABLED=1` 和 `WEVIR_SPIKE_API_KEY`。
- 临时工作区建在系统临时目录，结束时删除；“工作区外写入”用 `.dsh-home/wevir-spike/outside-*`（dsh 的 workspace-write 允许写系统临时区）。

## 目录

| 路径 | 内容 |
|---|---|
| `src/run-all.ts` | 入口：模式选择、步骤编排、清理 |
| `src/acp.ts` | 启动 `dsh --profile acp`，用 ACP SDK 连接并逐帧录制 JSON-RPC |
| `src/mock-llm.ts`、`src/scenarios.ts` | 本地 OpenAI Chat Completions（及最小 Anthropic Messages）mock 与各场景脚本 |
| `src/steps/*.ts` | measure、lifecycle、providers、env-hygiene、acp-flow、stream-tap、concurrency、sdk-compare、check-secrets |
| `overlays/` | 可复制的 `--patch` 样例（密钥用环境变量名引用） |
| `stream-tap/` | 原型 Cordis 插件：把 `agent/assistant-stream` 增量帧写到额外 fd |
| `fixtures/` | 脱敏后的真实 JSON 样本与完整帧记录（`*.jsonl`），`summary.<mode>.json` 是每项检查的结果；根 `biome.json` 排除了此目录，保持录制原样 |
