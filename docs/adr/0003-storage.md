# ADR-0003：本地存储：`node:sqlite` 与骨架阶段的密钥文件

- 状态：Accepted（2026-10-12）
- 日期：2026-10-12
- 任务：T0.6；影响 T2.1、T2.2、T2.5、T3.4、T5.1、T6.2
- 依据：Node.js 文档 `sqlite` 模块（v22.23.3、v24.21.0、v26.11.1 三个版本线）；better-sqlite3 13.0.3 的 npm 包内容与 v13.0.0 发布说明；Electron 发布时间表（releases.electronjs.org/schedule）；dsh `0.2.1-alpha.2` 的 `@deepseek-ai/dsh-session-query-sqlite`；本 ADR 的实测（2026-10-12，macOS arm64，Node v26.10.0，pnpm 12.6.0）

## 背景

- 计划 §1.3 冻结“SQLite + 文件系统”。存储由 `packages/storage` 承担（T2.1）：事件表只追加，`(session_id, seq)` 唯一且 `seq` 原子分配（T2.2）；其余是工作区、Provider、会话、审批几张小表。
- **只有 Host 进程打开数据库**：CLI 与桌面都经 Host 的 RPC 访问数据，一个数据目录同时只有一个 Host（ADR-0002 的 `host.json`）。所以是单进程、单写者。
- Host 跑在 Node ≥ 22.19 上（与 dsh 相同）；骨架只做开发模式，打包后跑在哪个 Node 上未定（ADR-0002 未决事项 1）。
- 计划原来担心的是：选 `better-sqlite3` 就要为 Electron 重编译原生模块（计划 §8）。

## 核实的事实

| 项 | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| 形态 | Node 内置，零依赖 | npm 包，13.0.3（2026-08-05），`engines.node >=22` |
| 稳定性 | 22.5.0 加入；22.13.0 / 23.4.0 起不再需要 `--experimental-sqlite`；**Node 22.x 文档仍为 Stability 1.1（Active development）**；24.15.0 与 25.7.0 起为 **1.2（Release candidate）**。本机 v26.10.0 导入时不打印警告 | 长期稳定的成熟库 |
| 原生模块 | 无 | 有。13.0.0（2026-07-21）起改用 N-API（node-addon-api），各平台预编译的 `.node` 直接放在 npm 包里（darwin / win32 / linux(glibc、musl) × x64 / arm64，解包 27 MB），不再从 GitHub 下载；发布说明的原话是预编译二进制“should theoretically work across different versions of Node.js and Electron” |
| pnpm 12 | 无需处理 | 实测 `pnpm add better-sqlite3@13.0.3` 以 `ERR_PNPM_IGNORED_BUILDS` 失败（包里有 `binding.gyp`，pnpm 视为构建脚本），要在 `allowBuilds` 里登记 `better-sqlite3: false` 才能装上并使用自带的预编译文件 |
| Electron | 取决于 Electron 内置的 Node：Electron 40 起为 Node 24.x，当前稳定版 44 为 24.18.1（≥ 24.15，即 RC 阶段）。**本 ADR 没有在 Electron 里实测** | N-API 理论上不需要重编译，同样没有实测 |
| API | 同步 API：`DatabaseSync`、`prepare`、`exec`、`run/get/all/iterate`。**没有事务辅助函数**，只有 `isTransaction`。API 仍在变：`timeout` 选项 22.16 加入，`defensive` 选项 24.12 加入（22.x 文档里没有），Node 26.11 的文档把类改名为 `Database`，`DatabaseSync` 成为弃用别名（DEP0210；本机 26.10.0 还只有 `DatabaseSync`） | 同步 API，带 `db.transaction(fn)`（含 `.immediate()`） |
| 内置 SQLite | 3.53.4（Node 26.10.0） | 3.53.4 |
| 与 dsh 的关系 | **dsh 自己就用 `node:sqlite`**：`@deepseek-ai/dsh-session-query-sqlite` 以 `await import("node:sqlite")` 打开全文索引，README 专门讲了如何推迟“SQLite 的实验性警告”。能跑 dsh 的 Node 必然提供 `node:sqlite` | dsh 不用 |

性能实测：两种驱动各跑 3 轮，每项 20,000 条事件；表 `events(session_id, seq, ts, type, payload)`，主键 `(session_id, seq)`，`WITHOUT ROWID`；`journal_mode=WAL`、`synchronous=NORMAL`；每条约 0.5 KB 的 JSON；`seq` 在 `BEGIN IMMEDIATE` 事务里以 `MAX(seq)+1` 分配后写入。

| 场景 | `node:sqlite` | `better-sqlite3` |
|---|---|---|
| 每个事件一个事务（实时追加） | 38,000–49,000 条/s | 31,000–38,000 条/s |
| 一个事务写 20,000 条（批量落库） | 178,000–221,000 条/s | 198,000–206,000 条/s |
| 读回 20,000 条（`readSince` 全量回放） | 32–68 ms | 28 ms |

两者在同一个数量级，都远高于需求：增量按短窗口合并后（ADR-0002 决策 3），一个会话每秒最多几十条事件。

## 决策

### 1. 驱动：`node:sqlite`

- `packages/storage` 用 `node:sqlite`；只有 storage 里的一个驱动模块 import 它，其他包只用 storage 的仓储接口。将来换驱动只改这一个模块。
- 驱动模块同时兼容 `Database`（Node 26.11 起的名字）与 `DatabaseSync`；只用 Node 22.19 已有的 API，较新的选项（如 `defensive`）先判断是否存在再用。
- 连接设置：`journal_mode=WAL`、`synchronous=NORMAL`（WAL 下进程崩溃不丢已提交事务，掉电或系统崩溃最多丢最后几个事务，不会损坏数据库）、外键开启（`node:sqlite` 默认开启，仍显式设置）、busy timeout 5000 ms。
- 事务：storage 自己提供 `transaction(fn)`：`BEGIN IMMEDIATE` → `fn()` → `COMMIT`，抛错则 `ROLLBACK`。**`fn` 必须是同步函数**，事务里不允许 `await`，否则别的调用会插进同一个连接的事务里。骨架不支持嵌套事务。
- 文件位置：`<数据目录>/wevir.db`（及 `-wal`、`-shm`）。迁移用手写 SQL 文件加版本表，Host 启动时在事务里执行（T2.1）。

### 2. Node 版本

- `engines.node` 保持 `>=22.19`，与 dsh 一致，不因存储提高下限。
- 开发与 CI 的基线是 `.node-version` 的 Node 24（24.15 起 `node:sqlite` 为 RC）。在 Node 22 上 `node:sqlite` 仍是 1.1 阶段，可能打印实验性警告，可接受。

### 3. 密钥：骨架阶段 0600 文件

- storage 提供 `SecretStore` 接口（`get / set / delete(secretRef)`）。数据库只存 `secretRef`，不存密钥本身。
- 骨架实现：`<数据目录>/secrets.json`，文件 0600；写入时先以 0600 创建临时文件再 rename，保证任何时刻都没有宽权限的中间文件。
- 密钥不进日志、事件、测试快照，也不进 `DSH_HOME`（ADR-0001：只经子进程环境变量传给 dsh）。
- Windows 上 `chmod` 只能改只读位，0600 不生效；骨架依赖 `%APPDATA%` 目录的按用户 ACL，在 T2.1 的测试与 T6.1 的安全说明里写明。
- **后续迁移到系统钥匙串**（macOS Keychain、Windows 凭据管理器）。迁移时 `SecretStore` 换实现，把 `secrets.json` 中的条目搬进钥匙串后删除文件；`secretRef` 不变。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| `better-sqlite3` 13 | 不采纳（可随时切换） | 13 版已消除“Electron 重编译”与“从 GitHub 下载预编译文件”两个老问题，性能也相当；但它仍是 Wevir 自身的第一个原生依赖，要在 pnpm 的 `allowBuilds` 里登记，包体 27 MB；N-API 版本发布不到三个月，跨 Electron 可用只是“理论上”。它的优势（成熟、自带事务函数）在 Wevir 只有一个包、十几条语句的用法里很小。**切换条件**：`node:sqlite` 出现阻塞性缺陷或缺少必需功能，或打包方案选定的 Electron 内置 Node 不提供 `node:sqlite`。代价只限于 storage 的驱动模块 |
| `sqlite3`（node-sqlite3，异步回调 API） | 不采纳 | 同样是原生模块；异步 API 对单写者的追加场景没有好处，反而让“事务里不能插入别的调用”更难保证 |
| JSON / JSONL 文件（Paseo N9） | 不采纳 | 没有事务和唯一约束，`seq` 原子分配与重启一致性都要自己做；计划 §1.3 已冻结 SQLite |
| 事件只存在 dsh 的会话日志里 | 不采纳 | Wevir 事件库是唯一事实来源（计划 §2.1、ADR-0001） |
| 现在就接系统钥匙串 | 推迟 | Host 是独立进程，用不了 Electron 的 `safeStorage`（OpenWork #25 的做法需要桌面主进程代管，CLI 启动的 Host 又没有桌面）；跨平台钥匙串库要评估维护状态，而且又是原生模块。骨架阶段的范围不需要 |

## 后果

- 到目前为止 Wevir 自己的包没有原生模块（dsh 仍有，见 ADR-0001），`pnpm install` 不需要为 storage 放行任何构建脚本。
- 要自己维护事务辅助函数，并在代码审查里守住“事务内同步”这条规则。
- `node:sqlite` 的 API 在 Node 22 / 24 / 26 之间有差异：驱动模块是唯一的适配点；T6.2 的 CI 除 `.node-version` 外，建议再跑一次 `engines` 下限 Node 22.19，覆盖这些差异。
- 密钥文件在 Windows 上的保护弱于 POSIX，需要在文档里如实说明，直到迁移到钥匙串。
- 计划 §8 “Electron 原生模块（SQLite）”一行的风险随之消失，改为“`node:sqlite` 仍在 RC / 实验阶段”。

## 未决事项

1. **Electron 内置 Node 能否用 `node:sqlite`**：只有打包方案选了 ADR-0002 未决事项 1 的 (a) 或 (c) 才需要；届时用 `ELECTRON_RUN_AS_NODE=1 <electron> -e "require('node:sqlite')"` 实测并补记。
2. **钥匙串迁移方案**（原生钥匙串库，还是由桌面主进程用 `safeStorage` 代管主密钥）：Phase 1 前另写 ADR。

## 补记

1. **2026-10-13，T2.1：实现时定下的细节。**
   - **加载方式**：驱动模块用 `process.getBuiltinModule('node:sqlite')`（Node 22.3 加入）在第一次打开数据库时才加载，而不是文件顶部的静态 `import`。原因：Node 22 上加载 `node:sqlite` 会打印实验性警告，只用 `SecretStore` 等不开库的场景不该出现；ESM 命名空间导入还会读到全部导出，包括 26.11 起弃用的 `DatabaseSync` 别名。仍然只有 `src/driver.ts` 加载它，测试会检查。
   - **busy timeout 与 defensive**：busy timeout 用 `PRAGMA busy_timeout = 5000` 设置（任何版本都有），不依赖 22.16 才有的 `timeout` 选项；`enableDefensive(true)`（24.12 加入）存在才调用。
   - **迁移文件在运行时读取**：`migrate()` 从 `<包根>/migrations/` 读 SQL（`src/` 与 `dist/` 都在包根下一层），`package.json` 的 `files` 包含 `migrations`。将来把 Host 打成单文件或放进 asar 时，要么一起带上这个目录，要么改成构建期内联；只改 `src/migrate.ts`。
   - **`SecretStore` 是异步接口**（`Promise`）：文件实现用不到，但系统钥匙串的 API 多是异步的，迁移时接口不变。
   - **`clientMessageId` 回执**（表 `send_receipts`）的 `status`：`accepted`（已写 `user.message`、未确认引擎收到）→ `confirmed`；Host 启动对账时仍是 `accepted` 的标为 `unknown`，不自动重发（ADR-0002 §4）。请求指纹由 `requestFingerprint()` 计算：对象键排序后的 JSON 的 SHA-256。何时置 `confirmed` 由 T2.3 决定。
   - **未在 Node 22.19 上实测**：本机只有 Node 26.10。驱动只用了 22.19 文档里已有的 API（`DatabaseSync`、`exec` / `prepare`、`isOpen` / `isTransaction`、命名参数），T6.2 的 CI 按“后果”一节再跑一次 `engines` 下限。

2. **2026-10-14，T6.2：在 Node 22.19 上实测。** CI 的 `node-min` job 在 macOS 与 Windows 上用 Node 22.19.0 跑全部测试（含 storage 与 host），与 `.node-version`（24）的 job 一样通过；补记 1 末条的“未在 Node 22.19 上实测”就此关闭。22.19 上加载 `node:sqlite` 照预期打印 `ExperimentalWarning: SQLite is an experimental feature`，不影响结果。
