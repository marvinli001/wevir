// 工作区的 Git：diff 的范围与对象 ID（0.20.0 起在 methods.ts，0.67.0 移到这里，形状不变）。

import { z } from 'zod';
import { TurnIdSchema } from './common.js';

/**
 * 读哪一段改动：`uncommitted` 是工作树加暂存区对 HEAD（含未跟踪文件），`branch` 是工作树对默认分支的 merge-base，`turn` 是
 * 会话一个回合前后的快照（host-api.md §3.1）。
 */
export const DiffSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uncommitted') }),
  z.object({ kind: z.literal('branch') }),
  z.object({ kind: z.literal('turn'), turnId: TurnIdSchema }),
]);
export type DiffSource = z.infer<typeof DiffSourceSchema>;

/** 提交或树对象的完整 SHA（SHA-1 40 位、SHA-256 64 位，小写）。 */
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
