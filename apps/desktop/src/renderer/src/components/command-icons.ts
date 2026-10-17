// 命令与目标用的两枚图标，沿用 lucide 的 24 格、2 描边，所以和别的图标并排时粗细一致：lucide 的 Slash 是满格 45° 斜线，
// 在菜单里偏斜；这里的斜杠更陡更短。目标是靶子加一支从右上射向靶心的箭（照 Codex），靶圈在箭经过的一角留出缺口。

import { createLucideIcon } from 'lucide-react';

export const SlashIcon = createLucideIcon('slash-steep', [['path', { d: 'M15 4 9 20', key: 'a' }]]);

export const GoalIcon = createLucideIcon('goal-arrow', [
  ['path', { d: 'M22 12a10 10 0 1 1-10-10', key: 'outer' }],
  ['path', { d: 'M18 12a6 6 0 1 1-6-6', key: 'inner' }],
  ['path', { d: 'm12 12 9-9', key: 'shaft' }],
  ['path', { d: 'M18 3v3h3', key: 'fletch' }],
]);
