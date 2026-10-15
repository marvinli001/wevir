// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/transportFailure.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只改了命名与注释，逻辑未改。
//
// Cursor 有时不报 run 失败，而是把传输错误当成助手的回答写出来（`Error: ConnectError: [unavailable] …`）。整段回答只有这种诊断时，
// 回合按失败结算（docs/architecture/cursor-event-mapping.md §5）；回答里引用了同样的文字（解释、代码示例）不算。

const MAX_LINE_LENGTH = 4096;
// Cursor 也用 RetriableError 报 agent 循环里的失败，那些保留原文（[internal] 不算传输错误）。
const TRANSPORT_ERROR =
  /^Error: (?:RetriableError: (?!\[internal\]).+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/;
const SERVER_ERROR = 'Something went wrong communicating with the server. Please try again.';

interface ReplyState {
  disqualified: boolean;
  failure: string | undefined;
}

function consumeLine(state: ReplyState, line: string): void {
  if (state.disqualified) return;
  const text = line.trimEnd();
  if (TRANSPORT_ERROR.test(text) || text === SERVER_ERROR) {
    state.failure = text;
  } else if (text.trim() !== '' && !(state.failure && /^\s+at\s/.test(text))) {
    state.disqualified = true;
    state.failure = undefined;
  }
}

/** 跟着流式回答认出单独的一段传输诊断，不保留整段回答。 */
export class CursorTransportFailure {
  #state: ReplyState = { disqualified: false, failure: undefined };
  #line = '';

  push(text: string): void {
    for (const [index, part] of text.split('\n').entries()) {
      if (this.#state.disqualified) return;
      if (index > 0) {
        consumeLine(this.#state, this.#line);
        this.#line = '';
      }
      if (this.#line.length + part.length > MAX_LINE_LENGTH) {
        this.#state.disqualified = true;
        this.#state.failure = undefined;
        this.#line = '';
        return;
      }
      this.#line += part;
    }
  }

  get failure(): string | undefined {
    const state = { ...this.#state };
    consumeLine(state, this.#line);
    return state.failure;
  }
}
