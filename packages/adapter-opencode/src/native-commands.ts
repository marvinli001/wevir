// SPDX-License-Identifier: MIT
// 参数展开取自 anomalyco/opencode packages/opencode/src/session/prompt.ts（SessionPrompt.command）
// 与 src/config/markdown.ts，提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52，Copyright (c) 2025 opencode。
// 只用展开结果检查 OpenCode 在进入会话权限系统前会执行的指令；执行仍由 session.command 负责。
import type { EngineToolClass, PermissionMode } from '@wevir/runtime-adapter';
import type { Command } from './sdk.js';

export function commandAllowed(
  command: Command,
  raw: string,
  settings: {
    permissionMode?: PermissionMode;
    deniedTools?: EngineToolClass[];
  },
): boolean {
  if (!command.name || /\s/.test(command.name)) return false;
  if (settings.permissionMode === 'full_access' && !settings.deniedTools?.length) return true;
  if (command.source === 'mcp' || typeof command.template !== 'string') return false;
  const template = command.template;
  if (!/[!@]/.test(template) && !/[!@]/.test(raw)) return true;

  const placeholders = [...template.matchAll(/\$(\d+)/g)];
  const last = placeholders.reduce((highest, slot) => Math.max(highest, Number(slot[1])), 0);
  const args = (raw.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []).map((arg) =>
    arg.replace(/^["']|["']$/g, ''),
  );
  const expanded = template.replace(/\$(\d+)/g, (_, slot: string) => {
    const index = Number(slot) - 1;
    return index + 1 === last ? args.slice(index).join(' ') : (args[index] ?? '');
  });
  let text = expanded.replaceAll('$ARGUMENTS', raw);
  if (!placeholders.length && !template.includes('$ARGUMENTS')) text += `\n${raw}`;
  // 动态命令的内联 shell 和隐式 @文件读取不经过 OpenCode 的 permission.asked。
  return !/!`[^`]+`|(?<![\w`])@(?=[^\s`,])/.test(text);
}
