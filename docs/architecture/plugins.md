# 插件：连接器与 Skills（P1，0.41.0）

插件是 Host 的全局配置，所有会话共用。P1 只提供协议与引擎接入，没有设置页、输入框 `$` 菜单、插件市场或 OAuth 登录。

连接器是用户登记的 MCP 服务，使用 stdio（command、args、env、cwd）或 Streamable HTTP（url、headers）。共同字段为 enabled、toolTimeoutSec。名字只允许 `[a-z0-9_-]+`，`wevir` 开头保留给内置服务。用户工具按会话权限模式批准，不写 Codex 的 `default_tools_approval_mode = "approve"`。

Skill 是含 `SKILL.md` 的文件夹。沿用 Codex `rust-v0.162.1`、提交 `092d3acd`（Apache-2.0）的格式：YAML frontmatter、name、description、可选 metadata.short-description；名字最多 64 个 Unicode 字符，描述最多 1024 个，扫描最多 6 层、每个根最多 2000 个目录。`agents/openai.yaml` 的显示、图标、默认提示、工具依赖随文件夹原样保留，具体解释交给 Codex，不从依赖自动安装服务。格式依据是 `skills/src/parser.rs`、`ext/skills/src/loader/` 与 `ext/skills/src/host_roots.rs`，移植登记在 [UPSTREAM.md](../upstream/UPSTREAM.md)。

## 数据与安装

`<数据目录>/plugins/registry.json` 保存连接器、托管 skill 与外部 skill 的开关；目录 0700，JSON 0600，临时文件写完再原子替换，写操作串行。托管 skills 在 `plugins/skills/<name>/`（普通名字直接使用，路径特殊字符编码；过长或平台保留名使用稳定散列目录）。路径按 realpath 规范化，数据目录经符号链接访问也不会把启用规则误认成另一条路径。env、headers 的值只保存在 Host，协议结果以 `{ KEY: true }` 表示已设置；更新省略的键保留，传 null 删除。HTTP URL 不接受内嵌用户名或密码，凭据用 headers。

`skill.install { path }` 接受一个目录、单个 SKILL.md、ZIP，或含 `.codex-plugin/plugin.json` / `.claude-plugin/plugin.json` 的插件包目录。插件包读取 name、version、description、skills（默认 ./skills）、mcpServers（默认 ./.mcp.json，可行内对象）、interface，展开为独立 skills 与连接器；不保存包层。MCP JSON 采用 `{ "mcpServers": { "name": { "command": "…" } } }`，HTTP 项使用 url / headers（兼容 Codex 的 http_headers）。不执行安装脚本、不展开环境变量、不导入不支持的字段。

安装先复制 / 解压到私有暂存目录，验证全部条目后发布。拒绝名字冲突、绝对或越界的包内路径、ZIP 路径穿越、符号链接与特殊文件，限制 2000 个条目、总计 64 MiB 与 32 层复制深度；失败清理暂存与已发布的本次目录。安装成功默认启用。移除只删除 Wevir 托管的 skill；用户与项目的原始文件不由 Host 删除，只可改开关。

## 外部 skills 与 Codex

`plugins.list` 还列出用户 `~/.agents/skills` 和已登记项目（含祖先）的 `.agents/skills`、`.codex/skills`，source 分别为 user、project；Wevir 安装的为 wevir。外部项默认禁用，开关按 SKILL.md 的规范绝对路径保存。外部文件后来变化时在列出、会话开始 / 恢复、发送前重新发现。Codex 自己还发现的其他根目录同样默认禁用。

Codex 两种适配实现（直接 CodexAdapter 与双进程 CodexRuntime）都接收相同注册表。启动前写 `[mcp_servers.<name>]` 和 `[[skills.config]]`，启动后用 `skills/extraRoots/set` 加入 Wevir 根与明确启用的外部项所在目录（项目配置未被 Codex 信任时也能使用）；打开 skills.include_instructions，保持 skills.bundled.enabled、features.plugins、features.apps 关闭。每次开始 / 恢复会话和发送前先用 skills/list 核对 Codex 发现的全部条目，把未获 Host 启用的路径设为禁用。

前置实测已通过：真实 app-server 0.162.1 + 本机假模型，独立临时 HOME、用户 / 项目 / Wevir 三个 canary；禁用项不进自动目录，显式 `$name` 也不注入正文；启用项可列出、显式注入。详见 [codex-event-mapping.md §10](codex-event-mapping.md#10-插件-p1skills-隔离的前置实测)。这控制后续注入，不抹除会话已有的历史上下文。

注册表变化后通知适配器：Codex 用 config/batchWrite（reloadUserConfig: true）与 config/mcpServer/reload 更新已加载会话；skills 通过额外根目录、开关与 forceReload 重扫。进行中的调用按 Codex 的生命周期收尾，后续回合使用新配置。更新失败记录不含密钥的诊断并保留注册表，下次会话 / 发送重试；重启后仍从 Host 注册表重建。状态来自 mcpServerStatus/list（detail: toolsAndAuthOnly，分页），仅向客户端投影 runtimeStatus、authStatus 与工具名 / 描述；尚未启动的引擎没有实时状态。mcpServer/startupStatus/updated、skills/changed 触发 plugins.changed。

## 支持与协议

Host feature `plugins` 表示注册表 API 可用，与引擎分开；EngineFeatures.mcpServers / skills 表示是否注入。Codex 两者支持；echo 支持最小测试实现，可在含 plugins 的回答里报告收到的启用连接器与 skills；Claude、OpenCode、Grok、Antigravity、Cursor、dsh 本期均为 false，后续见 TODO.md。

方法：plugins.list；connector.add / update / remove / setEnabled；skill.install / remove / setEnabled。读需要 host.manage（包含目录与命令配置），写同样需要 host.manage。plugins.changed 是无负载的全局通知，发给调过插件方法的连接；client-sdk 的 watchPlugins 在首次连接、重连与通知后重读，并避免旧响应覆盖新结果。注册表变化不写会话事件流。

验证：协议兼容样本；Host 安装、拒绝、持久化、密钥脱敏、echo 交付；真实 Codex + 本机假模型验证 MCP 工具调用、审批、skills 列表、禁用项与热更新。真实外部 MCP 服务与 OAuth 不属于本期验收。
