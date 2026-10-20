// 跳到消息流里的一处（0.77.0，会话搜索的结果）：搜索浮窗打开会话前把目标放进这里，那个会话的消息流（主窗格或子智能体窗格）
// 挂上、事件追到那条之后滚过去、闪一下命中的文字，然后清掉。按会话 ID 认领，不经路由：子会话在父会话的窗格里打开也一样。

import { createStore } from '@/lib/store';

export interface TranscriptFocus {
  sessionId: string;
  /** 事件的 `seq`：消息流追到它之后滚到它所在的消息（turn-model.ts 的 `messageIndexForSeq`）。 */
  seq: number;
  /** 命中的原文：在那条消息里找到它就滚到它并高亮。 */
  text?: string;
  /** 每次跳转不同，同一处再点一次也会再滚一次。 */
  nonce: number;
}

export const transcriptFocus = createStore<TranscriptFocus | undefined>(undefined);

let nonce = 0;

export function focusTranscript(target: Omit<TranscriptFocus, 'nonce'>): void {
  nonce += 1;
  transcriptFocus.set({ ...target, nonce });
}

/** CSS Custom Highlight 的名字（styles/session.css）。 */
export const FOCUS_HIGHLIGHT = 'wevir-search-hit';
/** 高亮停留多久。 */
export const FOCUS_HIGHLIGHT_MS = 2400;

/** 元素里第一处 `text`（不分大小写，可跨文本节点）的 Range；找不到时 `undefined`。 */
export function findTextRange(root: Element, text: string): Range | undefined {
  const needle = text.toLowerCase();
  if (needle === '') return undefined;
  const nodes: Text[] = [];
  let joined = '';
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    nodes.push(node as Text);
    joined += (node as Text).data;
  }
  const at = joined.toLowerCase().indexOf(needle);
  if (at < 0) return undefined;
  const range = root.ownerDocument.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const end = offset + node.data.length;
    if (!started && at < end) {
      range.setStart(node, at - offset);
      started = true;
    }
    if (started && at + needle.length <= end) {
      range.setEnd(node, at + needle.length - offset);
      return range;
    }
    offset = end;
  }
  return undefined;
}
