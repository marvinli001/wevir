// 写作风格（0.95.0，Host 功能 `writing_style`，domain-model §3.43）：Host 设置的 `writingStyle` 打开后，Agent 经得用户同意读用户
// 自己写过的东西（Wevir 里的聊天记录、用户指给它的文件与已连接的应用），总结成一份写作风格档案存在 Host；之后起草以用户名义发出的
// 文字时按档案写。档案只有一份、对所有项目有效，用户在设置 → 个性化里看、改、删。

import { z } from 'zod';
import { IsoTimeSchema } from './common.js';

/** 档案正文最长多少个字符。 */
export const WRITING_STYLE_MAX_LENGTH = 16_000;
export const WritingStyleContentSchema = z.string().min(1).max(WRITING_STYLE_MAX_LENGTH);

/** 谁最后写的：`agent` 是会话里的 Agent 用 `wevir_writing_style_save` 存的，`user` 是用户在设置里改的。 */
export const WritingStyleAuthorSchema = z.enum(['agent', 'user']);
export type WritingStyleAuthor = z.infer<typeof WritingStyleAuthorSchema>;

export const WritingStyleProfileSchema = z.object({
  content: WritingStyleContentSchema,
  updatedAt: IsoTimeSchema,
  updatedBy: WritingStyleAuthorSchema,
  /** 建档流程走完了（Agent 最后一次保存带了 `setup_complete`，或用户在设置里改过）。 */
  setupComplete: z.boolean(),
  /** 这一版的标识（正文与元数据的散列），每次保存都会变。 */
  revision: z.string().min(1),
});
export type WritingStyleProfile = z.infer<typeof WritingStyleProfileSchema>;

/** `writingStyle.get`：没有档案时省略 `profile`。 */
export const WritingStyleGetResultSchema = z.object({
  profile: WritingStyleProfileSchema.optional(),
});
export type WritingStyleGetResult = z.infer<typeof WritingStyleGetResultSchema>;

/**
 * `writingStyle.update`：用户改写档案（没有时新建）。带 `revision` 时，档案在那之后被改过就不写，结果是现在的档案加 `conflict`。
 */
export const WritingStyleUpdateParamsSchema = z.object({
  content: WritingStyleContentSchema,
  revision: z.string().min(1).optional(),
});
export type WritingStyleUpdateParams = z.infer<typeof WritingStyleUpdateParamsSchema>;

export const WritingStyleUpdateResultSchema = z.object({
  profile: WritingStyleProfileSchema,
  conflict: z.literal(true).optional(),
});
export type WritingStyleUpdateResult = z.infer<typeof WritingStyleUpdateResultSchema>;

/** `writingStyle.delete`：删掉档案，连同建档时的样本工作副本。没有档案时也成功。 */
export const WritingStyleDeleteResultSchema = z.object({});

export const WritingStyleMethodSchemas = {
  'writingStyle.get': {
    params: z.object({}),
    result: WritingStyleGetResultSchema,
    permission: 'session.read',
  },
  'writingStyle.update': {
    params: WritingStyleUpdateParamsSchema,
    result: WritingStyleUpdateResultSchema,
    permission: 'host.manage',
  },
  'writingStyle.delete': {
    params: z.object({}),
    result: WritingStyleDeleteResultSchema,
    permission: 'host.manage',
  },
} as const;
