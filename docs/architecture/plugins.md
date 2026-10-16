# 插件：连接器、Skills 与插件包（P1 0.41.0，P1a 0.42.0）

插件是 Host 的全局配置，所有会话共用。P1 / P1a 只提供协议与引擎接入；桌面端的“插件”页（P2，不改协议与 Host）见 [desktop-layout.md §23](desktop-layout.md#23-插件页0420)；输入框 `$` 菜单、插件市场与 OAuth 登录仍然没有。

连接器是用户登记的 MCP 服务，使用 stdio（command、args、env、cwd）或 Streamable HTTP（url、headers）。共同字段为 enabled、toolTimeoutSec。名字只允许 `[a-z0-9_-]+`，`wevir` 开头保留给内置服务。用户工具按会话权限模式批准，不写 Codex 的 `default_tools_approval_mode = "approve"`。

Skill 是含 `SKILL.md` 的文件夹。沿用 Codex `rust-v0.162.1`、提交 `092d3acd`（Apache-2.0）的格式：YAML frontmatter、name、description、可选 metadata.short-description；名字最多 64 个 Unicode 字符，描述最多 1024 个，扫描最多 6 层、每个根最多 2000 个目录。`agents/openai.yaml` 的显示、图标、默认提示、工具依赖随文件夹原样保留，具体解释交给 Codex，不从依赖自动安装服务。格式依据是 `skills/src/parser.rs`、`ext/skills/src/loader/` 与 `ext/skills/src/host_roots.rs`，移植登记在 [UPSTREAM.md](../upstream/UPSTREAM.md)。

## 数据与安装

`<数据目录>/plugins/registry.json` 保存连接器、托管 skill 与外部 skill 的开关；目录 0700，JSON 0600，临时文件写完再原子替换，写操作串行。托管 skills 在 `plugins/skills/<name>/`（普通名字直接使用，路径特殊字符编码；过长或平台保留名使用稳定散列目录），插件包在 `plugins/packages/<id>/`（0.42.0）。路径按 realpath 规范化，数据目录经符号链接访问也不会把启用规则误认成另一条路径。env、headers 的值只保存在 Host，协议结果以 `{ KEY: true }` 表示已设置；更新省略的键保留，传 null 删除。HTTP URL 不接受内嵌用户名或密码，凭据用 headers。

`skill.install { path }` 接受一个目录（下面可有多个 skill）、单个 SKILL.md 或 ZIP。0.41.0 时它也接受 Codex / Claude 插件包并展开成散项；0.42.0 起插件包一律走 `plugin.install`（见下节），`skill.install` 遇到含 `wevir-plugin.json`、`.codex-plugin/`、`.claude-plugin/` 的来源回 INVALID_PARAMS。P1 没有发布过，没有展开过的旧数据要迁移；P1 装的散装连接器与 skills 照旧是独立项。

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

## Wevir 插件包（P1a，0.42.0）

插件是 Wevir 自己的单位：一个包可以带多个连接器和多个 skills，有 id、名字、版本和图标，整体开关、整体升级和卸载。以后插件市场上架的就是这种包（市场本期不做）。散装的连接器与 skills 照旧可装；Claude / Codex 格式的包只作为导入来源，装好后同样是 Wevir 插件。

### 清单 `wevir-plugin.json`

放在包的根目录。zod 定义是 `packages/protocol/src/plugins.ts` 的 `WevirPluginManifestSchema`，Host、桌面端和以后的市场共用；同一份定义生成 `packages/protocol/schemas/wevir-plugin.schema.json`，插件作者在清单里写 `$schema` 指向它即可在编辑器里补全。字段名取自 Codex `core-plugins/src/manifest.rs`（`rust-v0.162.1`，`092d3acd`）与 Claude 插件清单，Wevir 用不到的（hooks、commands、agents、apps、interface 等）不搬。清单不接受未知字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `$schema` | string? | 编辑器补全用，Host 不读 |
| `schemaVersion` | `1` | 清单格式版本 |
| `id` | string | `[a-z0-9]` 与单个 `-`，最长 64，不以 `wevir` 开头；市场里的唯一标识，安装后不变 |
| `name` | string | 显示名，最长 128 |
| `version` | string | semver 2.0.0 |
| `description` | string? | 最长 1024 |
| `author` | `{ name, url? }`? | url 为 http(s) |
| `homepage` | string? | http(s) |
| `license` | string? | SPDX 表达式等，最长 128 |
| `icon` | string? | 包内 `.png` / `.svg`，最大 128 KiB；`plugins.list` 以 `data:` URL 回传 |
| `skills` | string? | 包内目录，默认 `./skills`；下面每个含 SKILL.md 的文件夹是一个 skill，规则同 P1 |
| `connectors` | object \| string? | `{ 名字: McpServerConfig }`，或指向包内同样形状的 JSON 文件；名字 `[a-z0-9_-]`，最长 63；字段同 P1 的 McpServerConfig（stdio：command、args、env、cwd；http：url、headers；共同：enabled、toolTimeoutSec），enabled 是安装时的默认开关 |
| `inputs` | array? | 最多 32 项 `{ key, label, description?, secret?, required? }`；key 为 `[A-Za-z_][A-Za-z0-9_]*`，不可重复 |

包内路径一律以 `./` 开头，不许有 `..` 段和反斜杠。两种占位符由 Host 在交给引擎前展开，引擎看不到占位符：

- `${input:KEY}`：只能用在连接器的 args、env、headers 和 url（url 里只能在路径与查询部分，主机名里的占位符过不了 URL 校验）；KEY 必须在 inputs 里声明。没填的可选项展开成空字符串；用到没填的必填项的连接器不交给引擎，`plugins.list` 里的 Connector 带 `missingInputs`。
- `${pluginDir}`：只能用在 stdio 连接器的 command、args、cwd、env，指向安装目录 `<数据目录>/plugins/packages/<id>`（升级后路径不变）。

完整例子（测试样例 `packages/host/src/test-fixtures/wevir-plugin/`，省略了 `$schema`）：

```json
{
  "schemaVersion": 1,
  "id": "sample-tools",
  "name": "Sample tools",
  "version": "1.0.0",
  "description": "Test plugin with a stdio connector and a skill",
  "author": { "name": "Wevir tests" },
  "license": "MIT",
  "icon": "./icon.svg",
  "connectors": {
    "api": {
      "transport": "stdio",
      "command": "node",
      "args": ["${pluginDir}/server/mcp.mjs", "${input:REGION}"],
      "env": { "PACKAGE_TOKEN": "${input:TOKEN}" }
    }
  },
  "inputs": [
    { "key": "TOKEN", "label": "Token", "secret": true, "required": true },
    { "key": "REGION", "label": "Region", "description": "Data region" }
  ]
}
```

包的其余内容：`skills/package-canary/SKILL.md`、`server/mcp.mjs`、`icon.svg`。`$schema` 可写 schemas 文件的相对路径，Host 不读它。

### 安装、升级与卸载

`plugin.install { path, inputs?, replace? }` 接受插件包的文件夹或 ZIP（ZIP 允许一层导出文件夹）。复制 / 解压、条目数与大小上限、路径穿越、符号链接与特殊文件的拒绝全部复用 P1。包先在 `plugins/` 下的私有暂存目录里读清单、扫 skills、检查占位符与图标，再原子改名到 `plugins/packages/<id>/`；失败清理暂存，注册表写失败时把目录改回原样。

- 同 `id` 已装时不带 `replace` 回 INVALID_PARAMS；带 `replace` 是升级：旧目录先挪开，新目录就位并写好注册表后才删除旧目录，任何一步失败都放回旧版本。升级保留插件的整体开关、仍在清单里的输入项的值、按名字对应的连接器与 skills 的开关和 ID；新增项默认打开。
- 名字冲突：插件里的连接器在引擎里叫 `<插件 id>_<名字>`，与散装连接器互相排斥；skill 名字与已装的任何 skill（散装、外部、其他插件）冲突时拒绝安装，错误里写出冲突的名字。
- `plugin.remove { id }` 删除安装目录与注册表里的插件和它的各项。插件里的项不能用 `connector.remove` / `skill.remove` 单独删除（错误提示卸载插件），`connector.update` 对它们只许改 enabled。
- `plugin.setEnabled { id, enabled }` 整体开关；`connector.setEnabled` / `skill.setEnabled` 照旧是单项开关。生效 = 插件开且该项开；列表里的 enabled 是该项自己的开关，插件关着时它的连接器不交给引擎、skills 写成禁用。
- `plugin.setInputs { id, values }` 填写输入项：只认清单声明的键，null 或空字符串清除。安装时也可在 `inputs` 里一并给出。必填项没填时插件照样装上，只是用到它的连接器不启动。值和 P1 的 env / headers 一样只存在 0600 的 `registry.json`；结果里密钥项只有 `set`，非密钥项另给 `value`。密钥项的值随引擎配置交给适配器用于日志打码。

注册表里插件记清单的元数据、来源、开关、输入项声明与值、连接器的原样配置（含占位符）和 skills。引擎拿到的是展开后的配置：Codex 两个适配实现机制不变，连接器来源从“散项”变成“散项 + 启用插件里可启动的项”，插件 skills 所在目录在启用时加入 `skills/extraRoots/set`；echo 照旧报告收到的启用项。

### 导入 Claude / Codex 包

没有 `wevir-plugin.json`、但有 `.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的包按清单转成 Wevir 插件，`source` 记 codex / claude：

- `id` 取清单的 name，转小写，非字母数字换成 `-`；转不出合法 id 时拒绝。显示名取 Codex `interface.displayName`，否则 name；版本缺省 `0.0.0`（导入的版本不要求 semver）；description、author（Claude 的 author，或 Codex 的 `interface.developerName`）、homepage（或 `interface.websiteURL`）照搬，Codex 的 `interface.logo` 是包内 png / svg 时作图标。
- 只取 skills（默认 `./skills`）与 MCP（`mcpServers`，默认 `./.mcp.json`，规则同 P1），连接器名字守插件内的名字规则；stdio 配置里的 `${CLAUDE_PLUGIN_ROOT}`（Claude）或 `${PLUGIN_ROOT}`（Codex）换成 `${pluginDir}`。导入的包没有 inputs，其他 `${…}` 原样保留。
- 清单里其他字段（hooks、commands、agents、apps、outputStyles 等）以及根目录按约定存在的 `commands/`、`agents/`、`hooks/`、`output-styles/` 不安装，写进结果的 `ignored`。

### 验证

`packages/protocol/src/plugin-manifest.test.ts`：清单合法 / 非法样本，JSON Schema 与 zod 源一致。`packages/host/src/plugin-packages.test.ts`：文件夹与 ZIP 安装、升级保留输入与开关、失败升级不动旧版本、卸载清干净、整体与单项开关、缺输入项的连接器不启动、占位符展开、导入 Claude（含 `${CLAUDE_PLUGIN_ROOT}`）与 Codex 包、忽略项报告、名字冲突、单独删除被拒、重启后还在、RPC 与 echo。`plugins.codex.integration.test.ts` 在真实 app-server + 本机假模型上对两个 Codex 实现各跑一遍：装样例包后 agent 经审批调到包里 `${pluginDir}` 的 stdio 工具（收到展开后的输入项），skill 在 Codex 的 skills/list 里且进上下文；关掉插件后下一个回合没有该工具，新会话的上下文里也没有该 skill，config.toml 里没有占位符。

## 在对话里安装（P3）

所有支持应用级工具的引擎都能经 `wevir` MCP 调 Host 的全局注册表；实际使用连接器与 skills 仍取决于引擎的 `mcpServers` / `skills` 能力。沿用 0.42.0 的方法、通知与审批事件，不新增线缆方法或版本。

- `wevir_plugins_list {}`：列出插件、连接器与 skills，只读且不需批准；结果不含输入项密钥、环境变量或 HTTP header 的值。
- `wevir_plugin_install { path, inputs? }`：把会话文件夹里的 Wevir、Claude 或 Codex 插件文件夹 / ZIP 交给 P1a 的安装实现。agent 帮用户做包时先写 `wevir-plugin.json` 与内容；必填输入项必须全部提供，缺失时工具列出键名，让 agent 向用户询问，失败不安装。此工具不升级已有插件。
- `wevir_skill_install { path }`：安装会话文件夹里的 skill 文件夹、单个 `SKILL.md` 或 ZIP，沿用 P1 的解析、限制与发布事务。
- `wevir_connector_add { name, transport, … }`：新增散装连接器，其余字段同协议 `McpServerConfig`（stdio 的 command / args / env / cwd，HTTP 的 url / headers，以及 enabled / toolTimeoutSec）。

两个安装工具的来源按会话 `cwd` 解析相对或绝对路径，并用 realpath 核对边界；不能指向会话文件夹外，符号链接及包内链接照 P1 拒绝。先复制 / 解压到 Host 私有暂存区、验证并生成审批详情，批准后安装这个副本；批准期间源文件变化不会改变已审核内容。暂存不是已安装项，拒绝、取消、验证或安装失败都清理。

三个写工具必须获得用户批准，不进 `APP_TOOLS_NO_APPROVAL`，不标只读。引擎正常请求审批时，Host 在原审批里显示插件名、版本、包含的连接器与 skills，或 skill 名与描述，或连接器命令行 / 地址。密钥输入项、env、headers、地址查询值与疑似凭据参数脱敏后才进入工具事件和审批详情。若引擎未询问（例如完全访问模式），Host 用已有的 `approval.requested` / `approval.respond` 补问；只有用户的允许决定才能写注册表。回合结束、停止、会话关闭、Host 退出或调用取消时不安装。

成功后对所有会话生效。Codex 热更新成功后后续回合可用，下一个新会话会重新加载；当前回合的工具与 skills 目录不能保证立即刷新。禁用 / 移除也不清除旧历史里的 skill 内容。其他引擎目前能帮助安装，使用能力以 P1 的支持表为准。

验证入口：`pnpm vitest run --project host app-tools`（路径、链接、校验、缺输入、脱敏、用户拒绝与取消），`pnpm vitest run --project host plugin-app-tools.codex.integration`（真实锁定 app-server + 本机假模型，在会话文件夹写 skill、批准安装、`plugins.list` 出现它，两个 Codex 实现）。
