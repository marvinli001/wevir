# spikes/codex-app-server：以 codex app-server 为运行时，直连 Responses 或经网关转 Chat Completions

一次性验证代码，不属于 pnpm workspace，不进入产品构建，没有 npm 依赖（Node ≥ 22.19 直接跑 `.ts`）。结论见 [docs/research/codex-notes.md](../../docs/research/codex-notes.md) §7，设计见 [ADR-0005 草案](../../docs/adr/0005-agent-runtime-and-model-gateway.md)。

## 运行

```bash
bash scripts/fetch-binary.sh   # 下载 codex-app-server rust-v0.162.1（与 upstream.lock 的 codex 行同一提交），校验 sha256，放到 .bin/
node src/run-all.ts            # 全部场景 × 三种接法，模型是本地 mock，不需要 Key（约 15 秒）
node src/network-audit.ts      # 外连审计：默认配置与各加固项各跑一个回合（约 1 分钟）
WEVIR_SPIKE_KEY=… node src/real.ts   # 真实模型（默认 DeepSeek），没有 Key 时打印“跳过”后退出
```

`run-all.ts` 的参数：`--only=<场景,...>`、`--transport=direct,gateway,passthrough`、`--trace`（打印每一行收发）、`--keep`（保留临时目录）。三种接法都跑完时把每项检查的结果写进 `fixtures/results.json`（本机路径与 uuid 已换成占位符）。

`real.ts` 的可选变量：`WEVIR_SPIKE_RESPONSES_BASE_URL`、`WEVIR_SPIKE_CHAT_BASE_URL`（默认都是 `https://api.deepseek.com`）、`WEVIR_SPIKE_MODEL`（默认 `deepseek-flash`）、`WEVIR_SPIKE_CHAT_MODEL`、`WEVIR_SPIKE_CHAT_EXTRA`（JSON，网关发给 Chat 上游的额外字段）。Key 只从环境变量读，不写盘、不打印。

大陆网络下载二进制可设 `WEVIR_GITHUB_MIRROR`，与 `scripts/upstream-sync.sh` 相同。

## 三种接法

| 接法 | 链路 | Codex 拿到的凭据 |
|---|---|---|
| `direct` | Codex → Responses 上游 | 上游 Key（经 `env_key` 的环境变量） |
| `passthrough` | Codex → 网关 → Responses 上游（原样透传，只剥掉 `client_metadata` 与 `x-codex-*` 等请求头） | 网关的一次性令牌 |
| `gateway` | Codex → 网关 → Chat Completions 上游（协议转换，`src/gateway.ts`） | 网关的一次性令牌 |

## 隔离

- 每个场景一个临时目录（系统临时区，结束删除），里面是 `CODEX_HOME`（事先建好）、工作区和假 `HOME`；app-server 进程的 cwd 是 `CODEX_HOME`。
- 子进程环境按白名单构造（`codex-home.ts` 的 `childEnv`），不继承调用方 shell 里的 `OPENAI_API_KEY` 等。
- `config.toml` 只写 Provider 地址与 Key 的变量名，外加加固项 `HARDENING`：`features.plugins=false`（唯一产生外连的开关，见 `network-audit.ts`）、`web_search="disabled"`、`analytics.enabled=false`、`check_for_update_on_startup=false`、`[shell_environment_policy]` 排除 `WEVIR_*`（否则模型跑的命令能读到 Key）。
- 审批用例的“工作区外”目标在 `.run/outside/`（gitignore）：Codex 的 workspace-write 把 `$TMPDIR` 与 `/tmp` 也列为可写。

## 目录

| 路径 | 内容 |
|---|---|
| `scripts/fetch-binary.sh` | 按平台下载锁定版本的 `codex-app-server` 并校验 sha256 |
| `src/app-server.ts` | 最小客户端：起子进程、逐行 JSON、请求 / 通知 / 服务端请求（审批）、stdin EOF → SIGTERM → SIGKILL 回收 |
| `src/codex-home.ts` | 临时目录、`config.toml`、白名单环境、加固项 |
| `src/model-script.ts` | 场景脚本的公共类型：场景只说“模型这一步做什么”，由两个 mock 各自渲染成线上格式 |
| `src/mock-responses.ts` | 脚本化的 Responses SSE 服务（事件格式照 upstream codex 的测试帮手） |
| `src/mock-chat.ts` | 脚本化的 Chat Completions SSE 服务（推理放在 `reasoning_content`，工具参数分片发） |
| `src/gateway.ts` | 最小网关：Responses → Chat 的请求与流式响应转换，以及 Responses 透传 |
| `src/harness.ts` | 一个场景的运行环境（临时目录 + 模型后端 + app-server），模型目录 `mockCatalog` |
| `src/run-all.ts` | 场景：流式、apply_patch 与文件审批、命令审批、跨回合推理、子 agent、取消、resume、计划、上游报错、密钥 |
| `src/network-audit.ts` | 外连审计（只记录目标主机、一律拒绝的代理 + lsof 抓 TCP 对端） |
| `src/real.ts` | 真实模型：补丁、跨回合、子 agent、取消 |
| `fixtures/results.json` | 最近一次全量运行的每项检查与备注 |
