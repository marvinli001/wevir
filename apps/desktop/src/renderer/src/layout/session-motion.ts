// 会话状态与标题的变化动效（desktop-tokens.md §71，跳跃）：记下每个会话上一次看到的状态与标题，只有在这次运行里变了才播，
// 启动时列出的会话一律不播。记在模块里而不是行组件里：按状态分组时会话跑完会从“进行中”挪到“已完成”，行重新挂载，
// 组件里的 ref 记不住；侧栏的行与顶栏标题也共用同一条记录。刚建的会话例外，出现时就播。渲染时调用，同一份会话重复调用结果不变（StrictMode 的二次渲染、
// 两处同时显示都安全）。返回的是变化发生的时刻，挂载晚了的元素用负的 animation-delay 接着播，不从头再来。

import type { Session, SessionState } from '@wevir/protocol';
import { type SessionMarker, sessionMarker } from '@/data/workbench-model';

/** 状态点跳一下的时长：bounce 弹簧（theme.css 的 --spring-bounce-duration）。 */
export const STATUS_JUMP_MS = 600;
/** 跑完的勾：圆圈画出、勾画出、停一会、淡出，合计（theme.css 的 done-mark）。 */
export const DONE_MARK_MS = 2000;

/** 建好多久以内第一次看到的会话算刚建的。 */
const FRESH_MS = 5000;

interface Seen {
  state: SessionState;
  marker: SessionMarker | undefined;
  title: string;
  /** 运行中的标记出现、待审批 / 等回答 / 出错的状态点跳出来的时刻。 */
  markerAt?: number;
  markerFrom?: SessionMarker | undefined;
  doneAt?: number;
  titleAt?: number;
}

const seen = new Map<string, Seen>();

export interface SessionMotion {
  /** 这次的状态标记是新出现的（运行中、待审批、等回答、出错）。 */
  markerAt?: number;
  /** 换过来之前的标记（没有标记是 undefined）。 */
  markerFrom?: SessionMarker | undefined;
  /** 回合正常跑完（运行中直接回到空闲，没有出错，也不是停下的）。 */
  doneAt?: number;
  /** 标题从空白或首条消息换成了生成的标题。 */
  titleAt?: number;
}

export function sessionMotion(session: Session, now = Date.now()): SessionMotion {
  const marker = sessionMarker(session);
  let prev = seen.get(session.id);
  if (prev === undefined) {
    // 刚建的会话（这时才出现在列表里）从空白算起，出现时就播；启动时已有的会话不播。
    if (now - Date.parse(session.createdAt) < FRESH_MS) {
      prev = { state: 'idle', marker: undefined, title: '' };
      seen.set(session.id, prev);
    } else {
      seen.set(session.id, { state: session.state, marker, title: session.title });
      return {};
    }
  }
  if (prev.marker !== marker) {
    prev.markerFrom = prev.marker;
    prev.marker = marker;
    prev.markerAt = marker === undefined ? undefined : now;
  }
  if (prev.state !== session.state) {
    // 停下的回合先经过 cancelling，不算跑完。
    prev.doneAt =
      prev.state === 'running' && session.state === 'idle' && marker === undefined
        ? now
        : undefined;
    prev.state = session.state;
  }
  if (prev.title !== session.title) {
    const reveal =
      session.title !== '' && (prev.title === '' || session.titleSource === 'generated');
    prev.titleAt = reveal ? now : undefined;
    prev.title = session.title;
  }
  return {
    ...(prev.markerAt !== undefined &&
      now - prev.markerAt < STATUS_JUMP_MS && {
        markerAt: prev.markerAt,
        markerFrom: prev.markerFrom,
      }),
    ...(prev.doneAt !== undefined && now - prev.doneAt < DONE_MARK_MS && { doneAt: prev.doneAt }),
    ...(prev.titleAt !== undefined && { titleAt: prev.titleAt }),
  };
}

/** 测试用：清掉记录。 */
export function resetSessionMotion(): void {
  seen.clear();
}
