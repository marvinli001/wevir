// 交给 `claude` 的环境（claude-event-mapping.md §2）。照 T3 继承 Host 的环境（用户的 `ANTHROPIC_API_KEY`、Bedrock 等设置照常
// 生效），只做两件事：PATH 补上 `claude` 所在的目录与常见的安装目录（executable.ts 的 `claudePath`）；去掉“正运行在另一个
// Claude Code 会话里”的标记——Host 本身由 Claude Code 拉起时（开发时常见）这些变量会让 `claude` 当成嵌套会话。

import { claudePath } from './executable.js';

/** 另一个 Claude Code 会话留下的标记，交给 `claude` 前去掉。 */
export const NESTED_SESSION_ENV: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
]);

export function claudeEnv(
  parent: NodeJS.ProcessEnv,
  executable: string | undefined,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...parent };
  for (const name of NESTED_SESSION_ENV) delete env[name];
  env.PATH = claudePath(executable, parent);
  // 子 agent 与后台命令都在回合里跑完（claude-event-mapping.md §6.4）：Claude 默认把 Agent 工具放到后台、做完后自己再开一轮
  // 回答，Wevir 的顶层会话没有引擎自己开的回合，那一轮的输出会丢。
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (process.platform === 'win32') delete env.Path;
  return env;
}
