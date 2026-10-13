import { randomUUID } from 'node:crypto';
import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type {
  ApprovalId,
  ApprovalOption,
  ApprovalRequest,
  SessionId,
  SessionSnapshot,
  SessionState,
  TurnId,
  WevirEvent,
} from '@wevir/protocol';
import type { Context } from './context.js';
import { describeError } from './errors.js';
import { optionLabel, STATE_LABEL } from './format.js';
import { EventRenderer } from './render.js';
import { LineConsole } from './terminal.js';

export interface AttachOptions {
  /** 追平后先发出的消息（`session new` 的提示）。 */
  firstMessage?: string;
}

const MESSAGE_PROMPT = '› ';
const BUSY_STATES: ReadonlySet<SessionState> = new Set([
  'running',
  'awaiting_approval',
  'cancelling',
]);

/**
 * `wevir session attach`：订阅会话（从头回放，再接实时），渲染输出，交互式审批，在输入框里继续对话。
 * 返回退出码。退出 attach 不影响会话，回合照常在 Host 里运行。
 *
 * Ctrl-C：回合运行中第一次取消当前运行，第二次退出；空闲时输入框有内容就清空，否则第一次提示、第二次退出。
 * 新回合开始后重新计数。Ctrl-D（或管道读到 EOF 且会话空闲）退出。
 */
export async function attachSession(
  ctx: Context,
  client: WevirClient,
  sessionId: SessionId,
  options: AttachOptions = {},
): Promise<number> {
  const snapshot = await client.request('session.get', { sessionId });
  const term = new LineConsole(ctx.io);
  try {
    return await new AttachView(ctx, client, term, snapshot, options).run();
  } finally {
    term.close();
  }
}

class AttachView {
  readonly #ctx: Context;
  readonly #client: WevirClient;
  readonly #term: LineConsole;
  readonly #sessionId: SessionId;
  readonly #renderer: EventRenderer;
  #state: SessionState;
  #readOnly: boolean;
  #caughtUp = false;
  /** 未决审批，按到达顺序。 */
  readonly #pending = new Map<ApprovalId, ApprovalRequest>();
  /** 本终端发出、还没有响应的 `approval.respond`；值为是否由本终端决定。 */
  readonly #inflight = new Map<ApprovalId, Promise<boolean>>();
  readonly #decidedHere = new Set<ApprovalId>();
  /** 本终端发出的消息，屏幕上已经有了（输入框留下的那一行）。 */
  readonly #echoed = new Set<string>();
  #firstMessage: string | undefined;
  #sending = false;
  /** `session.send` 已被接受、还没看到它的 `turn.finished` 的回合。 */
  #awaitingTurn: TurnId | undefined;
  readonly #finishedTurns = new Set<TurnId>();
  #exitArmed = false;
  #inputEnded = false;
  #toldInputEnded = false;
  #draft = '';
  /** 还没处理的输入行：追平之前到达的，以及非 TTY 时等到需要输入（审批或空闲）才取用的。 */
  readonly #queued: string[] = [];
  #disconnected = false;
  #done = false;
  #resolve: (code: number) => void = () => {};

  constructor(
    ctx: Context,
    client: WevirClient,
    term: LineConsole,
    snapshot: SessionSnapshot,
    options: AttachOptions,
  ) {
    this.#ctx = ctx;
    this.#client = client;
    this.#term = term;
    this.#sessionId = snapshot.session.id;
    this.#state = snapshot.session.state;
    this.#readOnly = snapshot.session.readOnly !== undefined;
    this.#firstMessage = options.firstMessage;
    this.#renderer = new EventRenderer({
      sink: term,
      styles: ctx.styles,
      isEchoed: (id) => this.#echoed.has(id),
      decidedHere: (id) => this.#decidedHere.has(id),
    });
    this.#header(snapshot);
  }

  run(): Promise<number> {
    const result = new Promise<number>((resolve) => {
      this.#resolve = resolve;
    });
    const offState = this.#client.onStateChange((state) => {
      if (state.status === 'reconnecting' && !this.#disconnected) {
        this.#disconnected = true;
        this.#term.line(
          this.#ctx.styles.yellow(
            '与 Host 的连接断开，正在重连…（Host 已停止时，在另一个终端运行 wevir host start）',
          ),
        );
      } else if (state.status === 'connected' && this.#disconnected) {
        this.#disconnected = false;
        this.#term.line(this.#ctx.styles.green('已重新连接到 Host。'));
      } else if (state.status === 'closed' && state.error !== undefined) {
        this.#report(state.error);
        this.#finish(1);
      }
    });
    const subscription = this.#client.subscribe(this.#sessionId);
    void (async () => {
      try {
        for await (const item of subscription) {
          if (this.#done) break;
          if (item.type === 'reset') {
            this.#pending.clear();
            this.#caughtUp = false;
            this.#renderer.reset();
          } else if (item.type === 'caught_up') {
            this.#caughtUp = true;
            this.#renderer.caughtUp();
            this.#afterCatchUp();
          } else {
            await this.#apply(item.event);
          }
          this.#refresh();
        }
        this.#finish(0);
      } catch (error) {
        this.#report(error);
        this.#finish(1);
      }
    })();

    this.#term.onLine((line) => this.#onLine(line));
    this.#term.onInterrupt(() => this.#onInterrupt());
    this.#term.onClose(() => {
      if (this.#term.interactive) {
        this.#finish(0);
        return;
      }
      this.#inputEnded = true;
      this.#refresh();
    });
    this.#refresh();

    return result.finally(() => {
      offState();
      subscription.close();
      this.#term.setPrompt(null);
      const s = this.#ctx.styles;
      this.#term.line(
        s.dim(
          `已退出 attach${this.#busy() ? '，当前运行仍在继续' : ''}。会话保留在 Host 中，重新连接：wevir session attach ${this.#sessionId}`,
        ),
      );
    });
  }

  #header(snapshot: SessionSnapshot): void {
    const { session } = snapshot;
    const s = this.#ctx.styles;
    const title = session.title ? ` · ${session.title}` : '';
    const state = session.readOnly ? '只读' : STATE_LABEL[session.state];
    this.#term.line(s.bold(`会话 ${session.id} · ${state}${title}`));
    this.#term.line(s.dim(`工作区 ${session.cwd} · 模型 ${session.providerId}/${session.modelId}`));
    if (this.#term.interactive) {
      this.#term.line(
        s.dim('Enter 发送 · Ctrl-C 取消当前运行（连按两次退出 attach） · Ctrl-D 退出 attach'),
      );
    }
  }

  async #apply(event: WevirEvent): Promise<void> {
    switch (event.type) {
      case 'session.state_changed':
        this.#state = event.payload.to;
        break;
      case 'turn.started':
        this.#exitArmed = false;
        break;
      case 'turn.finished':
        this.#finishedTurns.add(event.payload.turnId);
        if (this.#awaitingTurn === event.payload.turnId) this.#awaitingTurn = undefined;
        break;
      case 'approval.requested':
        this.#pending.set(event.payload.approval.id, event.payload.approval);
        break;
      case 'approval.resolved': {
        // 本终端的回复还在路上时，等它回来再显示：成功是本终端处理的，ALREADY_DECIDED 是别人先处理了。
        const inflight = this.#inflight.get(event.payload.approvalId);
        if (inflight) await inflight;
        this.#pending.delete(event.payload.approvalId);
        break;
      }
      case 'session.read_only':
        this.#readOnly = true;
        break;
      case 'session.resumed':
        this.#readOnly = false;
        break;
    }
    this.#renderer.render(event);
  }

  #afterCatchUp(): void {
    const s = this.#ctx.styles;
    if (this.#readOnly) {
      this.#term.line(s.yellow('这个会话是只读的：可以查看历史，不能再发送消息。'));
    } else if (this.#state === 'error') {
      this.#term.line(s.dim('会话处于出错状态；发送消息时会先尝试恢复。'));
    }
    const first = this.#firstMessage;
    this.#firstMessage = undefined;
    if (first !== undefined) void this.#send(first, false);
  }

  #busy(): boolean {
    return BUSY_STATES.has(this.#state) || this.#sending || this.#awaitingTurn !== undefined;
  }

  /** 下一条要在输入框里回答的审批（本终端已回复、等结果的除外）。 */
  #nextApproval(): ApprovalRequest | undefined {
    if (!this.#caughtUp) return undefined;
    for (const approval of this.#pending.values()) {
      if (!this.#inflight.has(approval.id)) return approval;
    }
    return undefined;
  }

  #refresh(): void {
    if (this.#done) return;
    this.#drain();
    if (this.#done) return;
    const approval = this.#nextApproval();
    if (!this.#caughtUp) {
      this.#term.setPrompt(null);
    } else if (approval) {
      this.#term.setPrompt(approvalPrompt(approval.options));
    } else if (this.#busy() || this.#firstMessage !== undefined) {
      this.#term.setPrompt(null);
    } else {
      this.#term.setPrompt(MESSAGE_PROMPT);
      if (this.#draft) {
        this.#term.fillInput(this.#draft);
        this.#draft = '';
      }
    }
    if (this.#inputEnded && this.#caughtUp && this.#queued.length === 0) {
      if (approval && !this.#toldInputEnded) {
        this.#toldInputEnded = true;
        this.#term.line(
          this.#ctx.styles.dim(
            `输入已结束，这条审批请在另一个终端处理：wevir session attach ${this.#sessionId}`,
          ),
        );
      }
      if (!approval && !this.#busy() && this.#firstMessage === undefined) this.#finish(0);
    }
  }

  #onLine(line: string): void {
    if (this.#done) return;
    // TTY 上用户看着屏幕输入，追平之后立即处理（回合运行中发送会得到 SESSION_BUSY）；管道输入是一份
    // 预先写好的回答，按需取用：有审批时回答审批，空闲时作为下一条消息。
    if (this.#term.interactive && this.#caughtUp) this.#handleLine(line);
    else {
      this.#queued.push(line);
      this.#refresh();
    }
  }

  #drain(): void {
    while (this.#queued.length > 0 && this.#caughtUp && !this.#done) {
      const ready =
        this.#term.interactive ||
        this.#nextApproval() !== undefined ||
        (!this.#busy() && this.#firstMessage === undefined);
      if (!ready) return;
      this.#handleLine(this.#queued.shift() as string);
    }
  }

  #handleLine(line: string): void {
    const text = line.trim();
    const approval = this.#nextApproval();
    if (approval) {
      this.#answer(approval, text);
      return;
    }
    if (text === '') {
      this.#refresh();
      return;
    }
    if (text === '/exit' || text === '/quit') {
      this.#finish(0);
      return;
    }
    if (this.#term.interactive && this.#busy()) {
      // 回合运行中输入框是隐藏的，补一行让用户看到自己发了什么。
      this.#term.line(`${this.#ctx.styles.dim(MESSAGE_PROMPT)}${text}`);
    }
    void this.#send(text, this.#term.interactive);
  }

  async #send(text: string, echoed: boolean): Promise<void> {
    const clientMessageId = `cli-${randomUUID()}`;
    if (echoed) this.#echoed.add(clientMessageId);
    const params = {
      sessionId: this.#sessionId,
      content: [{ type: 'text' as const, text }],
      clientMessageId,
    };
    this.#exitArmed = false;
    this.#sending = true;
    this.#refresh();
    try {
      let result: { turnId: TurnId };
      try {
        result = await this.#client.request('session.send', params);
      } catch (error) {
        const state = isRpcError(error, 'INVALID_STATE') ? error.data : undefined;
        if (!state || state.readOnly || (state.state !== 'error' && state.state !== 'closed')) {
          throw error;
        }
        this.#term.line(this.#ctx.styles.dim('会话需要先恢复，正在恢复…'));
        await this.#client.request('session.resume', { sessionId: this.#sessionId });
        result = await this.#client.request('session.send', params);
      }
      if (!this.#finishedTurns.has(result.turnId)) this.#awaitingTurn = result.turnId;
    } catch (error) {
      this.#report(error);
      if (isRpcError(error, 'SESSION_BUSY')) this.#draft = text;
    } finally {
      this.#sending = false;
      this.#refresh();
    }
  }

  #answer(approval: ApprovalRequest, text: string): void {
    const option = parseApprovalAnswer(approval.options, text);
    if (!option) {
      this.#term.line(
        this.#ctx.styles.dim(`输入选项序号（1–${approval.options.length}），或 y 允许、n 拒绝。`),
      );
      this.#refresh();
      return;
    }
    const id = approval.id;
    const reply = (async () => {
      try {
        await this.#client.request('approval.respond', {
          approvalId: id,
          optionId: option.optionId,
        });
        this.#decidedHere.add(id);
        // 不必等 approval.resolved 到达：它已经不再等待回答。
        this.#pending.delete(id);
        return true;
      } catch (error) {
        // 别人先处理了：随后的 approval.resolved 会显示是谁、怎么处理的。
        if (isRpcError(error, 'ALREADY_DECIDED')) this.#pending.delete(id);
        else this.#report(error);
        return false;
      } finally {
        this.#inflight.delete(id);
        this.#refresh();
      }
    })();
    this.#inflight.set(id, reply);
    this.#refresh();
  }

  #onInterrupt(): void {
    if (this.#done) return;
    const s = this.#ctx.styles;
    if (this.#exitArmed) {
      this.#finish(0);
      return;
    }
    if (this.#busy()) {
      this.#exitArmed = true;
      if (this.#state === 'cancelling') {
        this.#term.line(s.dim('正在取消…（再按一次 Ctrl-C 退出 attach）'));
        return;
      }
      this.#term.line(s.yellow('正在取消当前运行…（再按一次 Ctrl-C 退出 attach）'));
      this.#client
        .request('session.cancel', { sessionId: this.#sessionId })
        .catch((error: unknown) => this.#report(error));
      return;
    }
    if (this.#term.input !== '') {
      this.#term.clearInput();
      return;
    }
    this.#exitArmed = true;
    this.#term.line(s.dim('再按一次 Ctrl-C 退出 attach（会话保留在 Host 中），或按 Ctrl-D。'));
  }

  #report(error: unknown): void {
    const { message, hint } = describeError(error);
    const s = this.#ctx.styles;
    this.#term.line(s.red(message));
    if (hint) this.#term.line(s.dim(`下一步：${hint}`));
  }

  #finish(code: number): void {
    if (this.#done) return;
    this.#done = true;
    this.#resolve(code);
  }
}

/** 审批的输入框：`审批 [1 允许一次 / 2 拒绝] › `。 */
export function approvalPrompt(options: readonly ApprovalOption[]): string {
  return `审批 [${options.map((o, i) => `${i + 1} ${optionLabel(o)}`).join(' / ')}] › `;
}

/** 解析审批的回答：序号、optionId，或 y / n（第一个允许 / 拒绝类选项）。 */
export function parseApprovalAnswer(
  options: readonly ApprovalOption[],
  text: string,
): ApprovalOption | undefined {
  const answer = text.trim().toLowerCase();
  if (/^\d+$/.test(answer)) return options[Number(answer) - 1];
  const byId = options.find((o) => o.optionId.toLowerCase() === answer);
  if (byId) return byId;
  if (['y', 'yes', '允许', '是'].includes(answer))
    return options.find((o) => o.category === 'allow');
  if (['n', 'no', '拒绝', '否'].includes(answer))
    return options.find((o) => o.category === 'reject');
  return undefined;
}
