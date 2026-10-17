import { projectTranscript } from '@wevir/client-sdk';
import type { SessionId, TurnId, WevirEvent, WevirEventOf, WevirEventType } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { filesNotice, promptOfTurn } from './undo-model';

const SES: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN2: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQS';
const self = { clientId: 'cli_desktop', clientKind: 'desktop', deviceId: 'dev_x' } as const;

function transcript() {
  let seq = 0;
  const list: WevirEvent[] = [];
  const add = (type: WevirEventType, payload: unknown) => {
    seq += 1;
    list.push({
      seq,
      sessionId: SES,
      ts: new Date(Date.UTC(2026, 9, 17, 8, 0, seq)).toISOString(),
      type,
      source: 'host',
      payload,
    } as WevirEventOf<typeof type>);
  };
  return { list, add };
}

describe('promptOfTurn', () => {
  it('回合里用户写的文字；多段文字合在一起', () => {
    const { list, add } = transcript();
    add('user.message', {
      turnId: TURN,
      content: [
        { type: 'text', text: '第一行\n第二行' },
        { type: 'text', text: '第三段' },
      ],
      sentBy: self,
    });
    add('turn.started', { turnId: TURN });
    expect(promptOfTurn(projectTranscript(list).messages, TURN)).toBe('第一行\n第二行\n第三段');
  });

  it('不是用户写的回合（命令、父 agent 的输入、别的回合）没有文字', () => {
    const { list, add } = transcript();
    add('turn.started', { turnId: TURN, command: { kind: 'compact' } });
    add('turn.started', { turnId: TURN2, input: [{ type: 'text', text: '派给子 agent 的任务' }] });
    const messages = projectTranscript(list).messages;
    expect(promptOfTurn(messages, TURN)).toBeUndefined();
    expect(promptOfTurn(messages, TURN2)).toBeUndefined();
    expect(promptOfTurn(messages, 'trn_01JA2B3C4D5E6F7G8H9JKMNP99' as TurnId)).toBeUndefined();
  });

  it('只有图片的消息没有文字', () => {
    const { list, add } = transcript();
    add('user.message', {
      turnId: TURN,
      content: [
        {
          type: 'image',
          imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR',
          mimeType: 'image/png',
          size: 3,
          name: 'a.png',
        },
      ],
      sentBy: self,
    });
    expect(promptOfTurn(projectTranscript(list).messages, TURN)).toBeUndefined();
  });
});

describe('filesNotice', () => {
  it('文件还原了、本来就一样时不提示', () => {
    expect(filesNotice({ status: 'restored', fileCount: 2 })).toBeUndefined();
    expect(filesNotice({ status: 'unchanged' })).toBeUndefined();
  });

  it('没动文件时写明原因，不认识的原因写“无法还原”', () => {
    expect(filesNotice({ status: 'unavailable', reason: 'not_git' })).toBe(
      '文件未还原：目录不在 Git 仓库中',
    );
    expect(filesNotice({ status: 'unavailable', reason: 'no_checkpoint' })).toBe(
      '文件未还原：此回合无快照',
    );
    expect(filesNotice({ status: 'unavailable', reason: 'head_moved' })).toBe(
      '文件未还原：此回合之后 HEAD 已变化',
    );
    expect(filesNotice({ status: 'unavailable', reason: 'sparse_checkout' })).toBe(
      '文件未还原：无法还原',
    );
    expect(filesNotice({ status: 'unavailable' })).toBe('文件未还原：无法还原');
  });
});
