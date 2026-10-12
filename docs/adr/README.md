# 架构决策记录（ADR）

记录 Wevir 中影响多个任务、改动成本高、或推翻过计划假设的决定。计划（[SKELETON_PLAN.md](../SKELETON_PLAN.md)）说“做什么、按什么顺序做”，ADR 说“为什么这样定”。两者冲突时先改 ADR，再改计划和 [TASK_PROMPTS.md](../TASK_PROMPTS.md)（计划 §0 第 4 条）。

## 索引

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](./0001-runtime-integration.md) | dsh 接入路径：ACP 子进程 + 增量流式旁路 | Accepted | 2026-10-12 |
| [0002](./0002-host-transport-and-process-model.md) | Host 传输与进程模型 | Accepted | 2026-10-12 |
| [0003](./0003-storage.md) | 本地存储：`node:sqlite` 与骨架阶段的密钥文件 | Accepted | 2026-10-12 |
| [0004](./0004-repo-tooling.md) | 仓库工具链 | Accepted | 2026-10-12 |

## 文件格式

文件名 `NNNN-短横线标题.md`，编号四位、递增、不复用。正文用下面的结构：

```markdown
# ADR-NNNN：标题

- 状态：Proposed | Accepted | Superseded by ADR-XXXX | Deprecated（附日期）
- 日期：YYYY-MM-DD
- 任务：写这份 ADR 的任务 ID；受影响的任务 ID
- 依据：研究报告、Spike、源码或文档的位置

## 背景
要解决什么问题，有哪些约束，已知的事实（带出处）。

## 决策
定了什么。写成可以照着执行、可以被检查的条目。

## 备选方案
考虑过但没选的方案，各自的理由。

## 后果
采用之后的收益、代价、风险与对策；哪些任务要因此改做法。

## 未决事项（可选）
本 ADR 刻意不决定的问题：写明由哪个任务或哪次 Spike 决定，在那之前的默认做法。

## 补记（可选）
Accepted 之后不推翻决策的补充，一条一行：日期、任务 ID、内容。
```

## 状态与修改规则

- **Proposed**：草稿，可以随意改。
- **Accepted**：生效。之后只允许两种修改：
  - 在「补记」里追加不改变决策的事实，例如 T3.1 实测确认了单进程多会话、真实模型补跑了 Spike 的待验证项。
  - 决策本身要变时，新开一份 ADR，旧 ADR 状态改为 `Superseded by ADR-XXXX`，正文保留不删。
- **Deprecated**：问题本身不存在了（例如对应模块被移除），不再有替代决策。
- 修改 ADR 的提交同时更新本页索引；决策变化时，同一个提交里同步改计划和 prompt。

## 引用约定

- “计划 §x.y”指 SKELETON_PLAN.md；“T0.3 §x”“Paseo Ax”“OpenWork #x”分别指 [dsh 接入 Spike](../research/dsh-integration-spike.md)、[Paseo 研读](../research/paseo-notes.md) §9 的条目编号、[OpenWork 研读](../research/openwork-notes.md) §8 的候选编号。
- 依赖上游代码或文档的结论，写明锁定提交下的路径（见 [UPSTREAM.md](../upstream/UPSTREAM.md)）。
