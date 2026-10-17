// 撤销与重做（0.51.0，desktop-tokens §58）的纯逻辑：撤销之后放回输入框的文字、文件没还原时的提示。

import type { ChatMessage } from '@wevir/client-sdk';
import type { FilesRestore, TurnId } from '@wevir/protocol';
import { t } from '@/i18n';

/**
 * 一个回合里用户自己写的文字（撤销之后放回输入框，让用户改了再发）：排除插话、父 agent 的输入、命令与目标回合；
 * 没有文字（只有图片，或不是用户写的回合）时 `undefined`。
 */
export function promptOfTurn(messages: readonly ChatMessage[], turnId: TurnId): string | undefined {
  const message = messages.find(
    (candidate) =>
      candidate.role === 'user' &&
      candidate.turnId === turnId &&
      candidate.steered !== true &&
      candidate.fromParentAgent !== true &&
      candidate.command === undefined &&
      candidate.trigger === undefined,
  );
  if (message === undefined || message.role !== 'user') return undefined;
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim();
  return text === '' ? undefined : text;
}

const REASONS: Readonly<
  Record<string, 'undo.reason.not_git' | 'undo.reason.no_checkpoint' | 'undo.reason.head_moved'>
> = {
  not_git: 'undo.reason.not_git',
  no_checkpoint: 'undo.reason.no_checkpoint',
  head_moved: 'undo.reason.head_moved',
};

/**
 * 撤销 / 重做时文件没动（`unavailable`）的提示，写明原因；文件还原了、本来就一样时没有提示（结果直接看得到）。
 * 原因不认识（快照存不了：稀疏检出、未跟踪文件太多）时写“无法还原”。
 */
export function filesNotice(files: FilesRestore): string | undefined {
  if (files.status !== 'unavailable') return undefined;
  const key = (files.reason !== undefined && REASONS[files.reason]) || 'undo.reason.other';
  return t('undo.filesSkipped', { reason: t(key) });
}
