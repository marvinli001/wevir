// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts（parseCodexGoalCommand）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 在服务端解析，Wevir 在桌面端解析后调 `session.setGoal` / `updateGoal` / `clearGoal`；类型名与注释改写。
//
// 输入框里的 `/goal`（0.35.0，desktop-tokens §48）：照 Codex 终端界面的写法解析——不带参数（或 `edit`）是看目标，`clear`、`pause`、
// `resume` 管当前的目标，其余文字是新的目标。

export type GoalCommand =
  | { type: 'show' }
  | { type: 'clear' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set'; objective: string };

/** `/goal …` 的命令；不是 `/goal` 开头的消息返回 `undefined`（照原样发出）。 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return undefined;
  const argument = (match[1] ?? '').trim();
  switch (argument.toLowerCase()) {
    case '':
    case 'edit':
      return { type: 'show' };
    case 'clear':
      return { type: 'clear' };
    case 'pause':
      return { type: 'pause' };
    case 'resume':
      return { type: 'resume' };
    default:
      return { type: 'set', objective: argument };
  }
}
