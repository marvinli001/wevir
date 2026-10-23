import { randomUUID } from 'node:crypto';
import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type {
  ApprovalId,
  ApprovalOption,
  ApprovalRequest,
  ApprovalRuleScope,
  CollaborationMode,
  MethodParams,
  PendingDelivery,
  PendingMessageId,
  QuestionAnswer,
  QuestionId,
  QuestionRequest,
  Session,
  SessionId,
  SessionSnapshot,
  SessionState,
  TurnId,
  UserQuestion,
  WevirEvent,
} from '@wevir/protocol';
import { parsePermission } from './commands/automation.js';
import type { Context } from './context.js';
import { describeError } from './errors.js';
import { alwaysAllow, optionLabel, padEnd, permissionLabel, stateLabel } from './format.js';
import { t } from './i18n/index.js';
import { EventRenderer, pendingPreview } from './render.js';
import { LineConsole } from './terminal.js';

export interface AttachOptions {
  /** 追平后先发出的消息（`session new` 的提示）。 */
  firstMessage?: string;
  /** 这条消息的协作模式（`session new --plan`）。 */
  firstMode?: CollaborationMode;
}

const MESSAGE_PROMPT = '› ';
/** 回合进行中的输入框（R11）：回车按设置插话或排队。 */
const busyPrompt = (delivery: PendingDelivery): string => t(`attach.busyPrompt.${delivery}`);
const deliveryLabel = (delivery: PendingDelivery): string => t(`attach.delivery.${delivery}`);
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
 *
 * 回合进行中也能输入（R11，Host 有 pending_messages 时）：回车按 Host 设置“回合进行中按回车”插话或排队，Tab 用另一种；
 * 回合没正常结束而暂停的待发消息，输入 /resume 继续发送。管道输入照旧等会话空闲再发。
 *
 * 审批之后是 Agent 的提问（0.10.0）：逐题回答，答完一组一次 `question.respond`。斜杠命令见 `SLASH_COMMANDS`。
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
  /** 会话现在的设置（模型、档位、权限、标题）：快照之后跟着事件改。 */
  #session: Session;
  /** 未决审批，按到达顺序。 */
  readonly #pending = new Map<ApprovalId, ApprovalRequest>();
  /** 未结束的提问，按到达顺序；`#answers` 是正在回答的那一组已答的题。 */
  readonly #questions = new Map<QuestionId, QuestionRequest>();
  #answers: { id: QuestionId; answers: Record<string, QuestionAnswer> } | undefined;
  readonly #answering = new Set<QuestionId>();
  /** 这条连接能加审批规则（`policy.write`，0.98.0）。 */
  readonly #canRemember: boolean;
  /** 本终端发出、还没有响应的 `approval.respond`；值为是否由本终端决定。 */
  readonly #inflight = new Map<ApprovalId, Promise<boolean>>();
  readonly #decidedHere = new Set<ApprovalId>();
  /** 本终端发出的消息，屏幕上已经有了（输入框留下的那一行）。 */
  readonly #echoed = new Set<string>();
  #firstMessage: string | undefined;
  readonly #firstMode: CollaborationMode | undefined;
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
  /** Host 支持回合进行中发消息（R11）。 */
  readonly #pendingSupported: boolean;
  /** 回合进行中按回车的方式（Host 设置，R11）。 */
  #busyDelivery: PendingDelivery = 'steer';
  /** 暂停的待发消息（R11）：追平时提示一次，/resume 继续。 */
  readonly #held = new Map<PendingMessageId, string>();
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
    this.#session = snapshot.session;
    this.#state = snapshot.session.state;
    this.#readOnly = snapshot.session.readOnly !== undefined;
    this.#firstMessage = options.firstMessage;
    this.#firstMode = options.firstMode;
    this.#pendingSupported = client.supports('pending_messages');
    this.#canRemember = client.supports('approval_rules') && client.can('policy.write');
    this.#renderer = new EventRenderer({
      sink: term,
      styles: ctx.styles,
      isEchoed: (id) => this.#echoed.has(id),
      decidedHere: (id) => this.#decidedHere.has(id),
      canRemember: this.#canRemember,
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
        this.#term.line(this.#ctx.styles.yellow(t('attach.reconnecting')));
      } else if (state.status === 'connected' && this.#disconnected) {
        this.#disconnected = false;
        this.#term.line(this.#ctx.styles.green(t('attach.reconnected')));
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
            this.#questions.clear();
            this.#answers = undefined;
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

    const offSettings = this.#client.watchSettings((settings) => {
      this.#busyDelivery = settings.sendWhileBusy;
      this.#refresh();
    });
    this.#term.onLine((line) => this.#onLine(line));
    this.#term.onTab((line) => this.#onTab(line));
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
      offSettings();
      subscription.close();
      this.#term.setPrompt(null);
      const s = this.#ctx.styles;
      const id = this.#sessionId;
      this.#term.line(
        s.dim(this.#busy() ? t('attach.exitedBusy', { id }) : t('attach.exited', { id })),
      );
    });
  }

  #header(snapshot: SessionSnapshot): void {
    const { session } = snapshot;
    const s = this.#ctx.styles;
    const title = session.title ? ` · ${session.title}` : '';
    const state = session.readOnly ? t('state.readOnly') : stateLabel(session.state);
    this.#term.line(s.bold(t('attach.header', { id: session.id, state, title })));
    this.#term.line(
      s.dim(
        t('attach.headerDetail', {
          cwd: session.cwd,
          model: `${session.providerId}/${session.modelId}`,
        }),
      ),
    );
    for (const pending of snapshot.pendingMessages ?? []) {
      if (pending.status === 'held') this.#held.set(pending.id, pendingPreview(pending));
    }
  }

  async #apply(event: WevirEvent): Promise<void> {
    switch (event.type) {
      case 'session.state_changed':
        this.#state = event.payload.to;
        break;
      case 'session.configured': {
        const { modelId, reasoningEffort, permissionMode } = event.payload;
        const { reasoningEffort: _effort, permissionMode: _mode, ...rest } = this.#session;
        this.#session = {
          ...rest,
          modelId,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(permissionMode !== undefined && { permissionMode }),
        };
        break;
      }
      case 'session.handoff': {
        const { to, reasoningEffort, permissionMode } = event.payload;
        const { reasoningEffort: _effort, permissionMode: _mode, ...rest } = this.#session;
        this.#session = {
          ...rest,
          providerId: to.providerId,
          modelId: to.modelId,
          ...(reasoningEffort !== undefined && { reasoningEffort }),
          ...(permissionMode !== undefined && { permissionMode }),
        };
        break;
      }
      case 'session.title_changed':
        this.#session = { ...this.#session, title: event.payload.title };
        break;
      case 'question.requested':
        this.#questions.set(event.payload.question.id, event.payload.question);
        break;
      case 'question.resolved':
        this.#questions.delete(event.payload.questionId);
        if (this.#answers?.id === event.payload.questionId) this.#answers = undefined;
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
      case 'subagent.started':
      case 'subagent.updated': {
        // 子会话的审批（R4）：在父会话里回答，审批属于子会话，摘要的 pendingApprovals 是它们当前的全部。
        const { sessionId, pendingApprovals } = event.payload.subagent;
        for (const [id, approval] of this.#pending) {
          const still = pendingApprovals.some((pending) => pending.id === id);
          if (approval.sessionId === sessionId && !still && !this.#inflight.has(id)) {
            this.#pending.delete(id);
          }
        }
        for (const approval of pendingApprovals) this.#pending.set(approval.id, approval);
        break;
      }
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
      case 'pending.added':
      case 'pending.updated': {
        const { pending } = event.payload;
        if (pending.status === 'held') this.#held.set(pending.id, pendingPreview(pending));
        else this.#held.delete(pending.id);
        break;
      }
    }
    this.#renderer.render(event);
  }

  #afterCatchUp(): void {
    const s = this.#ctx.styles;
    if (this.#readOnly) {
      this.#term.line(s.yellow(t('attach.readOnly')));
    } else if (this.#state === 'error') {
      this.#term.line(s.dim(t('attach.errorState')));
    }
    if (this.#held.size > 0) {
      this.#term.line(s.yellow(t('attach.held', { count: this.#held.size })));
      for (const text of this.#held.values()) this.#term.line(s.dim(`  ⋯ ${text}`));
    }
    const first = this.#firstMessage;
    this.#firstMessage = undefined;
    if (first !== undefined) void this.#send(first, false, undefined, this.#firstMode);
  }

  #busy(): boolean {
    return BUSY_STATES.has(this.#state) || this.#sending || this.#awaitingTurn !== undefined;
  }

  /** 正在回答的提问与题目（审批都答完之后；本终端已提交、等结果的除外）。 */
  #nextQuestion(): { request: QuestionRequest; index: number } | undefined {
    if (!this.#caughtUp) return undefined;
    for (const request of this.#questions.values()) {
      if (this.#answering.has(request.id)) continue;
      const answered = this.#answers?.id === request.id ? this.#answers.answers : {};
      const index = request.questions.findIndex((question) => !(question.id in answered));
      if (index >= 0) return { request, index };
    }
    return undefined;
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
    const question = approval ? undefined : this.#nextQuestion();
    if (!this.#caughtUp) {
      this.#term.setPrompt(null);
    } else if (approval) {
      this.#term.setPrompt(approvalPrompt(approval.options, this.#always(approval) !== undefined));
    } else if (question) {
      this.#term.setPrompt(
        questionPrompt(question.request.questions[question.index] as UserQuestion, {
          index: question.index + 1,
          total: question.request.questions.length,
        }),
      );
    } else if (this.#busy() && this.#pendingSupported && this.#term.interactive) {
      // 回合进行中也能输入（R11）：输入框说明回车用哪种方式；流式输出的半行期间照旧不显示。
      this.#term.setPrompt(busyPrompt(this.#busyDelivery));
    } else if (this.#busy() || this.#firstMessage !== undefined) {
      this.#term.setPrompt(null);
    } else {
      this.#term.setPrompt(MESSAGE_PROMPT);
      if (this.#draft) {
        this.#term.fillInput(this.#draft);
        this.#draft = '';
      }
    }
    const waiting = approval !== undefined || question !== undefined;
    if (this.#inputEnded && this.#caughtUp && this.#queued.length === 0) {
      if (waiting && !this.#toldInputEnded) {
        this.#toldInputEnded = true;
        this.#term.line(this.#ctx.styles.dim(t('attach.inputEnded', { id: this.#sessionId })));
      }
      if (!waiting && !this.#busy() && this.#firstMessage === undefined) this.#finish(0);
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
        this.#nextQuestion() !== undefined ||
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
    const question = this.#nextQuestion();
    if (question) {
      this.#answerQuestion(question.request, question.index, text);
      return;
    }
    if (text === '') {
      this.#refresh();
      return;
    }
    if (text.startsWith('//')) {
      this.#sendTyped(text.slice(1), this.#busyDelivery);
      return;
    }
    if (text.startsWith('/')) {
      this.#command(text);
      return;
    }
    this.#sendTyped(text, this.#busyDelivery);
  }

  /** 斜杠命令（`SLASH_COMMANDS`）；`//` 开头的按原文发送（去掉一个 `/`）。 */
  #command(text: string): void {
    const space = text.search(/\s/);
    const name = (space < 0 ? text : text.slice(0, space)).slice(1).toLowerCase();
    const arg = space < 0 ? '' : text.slice(space + 1).trim();
    const s = this.#ctx.styles;
    const sessionId = this.#sessionId;
    switch (name) {
      case 'exit':
      case 'quit':
        this.#finish(0);
        return;
      case 'resume':
        this.#resumePending();
        return;
      case 'help':
        for (const command of SLASH_COMMANDS) {
          const usage = padEnd(t(`slash.${command}.usage`), 34);
          this.#term.line(`  ${s.bold(usage)} ${s.dim(t(`slash.${command}`))}`);
        }
        this.#refresh();
        return;
      case 'plan':
        if (arg === '') {
          this.#usage(t('slash.plan.usage'));
          return;
        }
        this.#sendTyped(arg, this.#busyDelivery, 'plan');
        return;
      case 'undo':
      case 'redo':
        this.#run(
          this.#client.request(name === 'undo' ? 'session.undo' : 'session.redo', { sessionId }),
        );
        return;
      case 'compact':
        this.#run(this.#client.request('session.compact', { sessionId }));
        return;
      case 'rename':
        if (arg === '') {
          this.#usage(t('slash.rename.usage'));
          return;
        }
        this.#run(this.#client.request('session.rename', { sessionId, title: arg }), () =>
          t('attach.renamed', { title: arg }),
        );
        return;
      case 'fork':
        this.#run(this.#client.request('session.fork', { sessionId }), ({ session }) =>
          t('attach.forked', { id: session.id }),
        );
        return;
      case 'model':
        this.#model(arg);
        return;
      case 'effort':
        if (arg === '') {
          this.#showConfig();
          return;
        }
        this.#configure({ reasoningEffort: arg === 'default' ? null : arg });
        return;
      case 'permission': {
        if (arg === '') {
          this.#showConfig();
          return;
        }
        let permissionMode: MethodParams<'session.configure'>['permissionMode'];
        try {
          permissionMode = parsePermission(arg);
        } catch (error) {
          this.#report(error);
          this.#refresh();
          return;
        }
        this.#configure({ permissionMode });
        return;
      }
      case 'goal':
        this.#goal(arg);
        return;
      default:
        this.#term.line(s.red(t('attach.unknownCommand', { command: `/${name}` })));
        this.#term.line(s.dim(t('error.hint', { hint: t('attach.unknownCommand.hint') })));
        this.#refresh();
    }
  }

  #usage(usage: string): void {
    this.#term.line(this.#ctx.styles.dim(t('cli.usage', { usage })));
    this.#refresh();
  }

  /** 发一个请求，成功时（有说法的）说一声，失败时报错；结果的事件由渲染器显示。 */
  #run<T>(request: Promise<T>, done?: (result: T) => string): void {
    request
      .then((result) => {
        if (done) this.#term.line(this.#ctx.styles.dim(done(result)));
      })
      .catch((error: unknown) => this.#report(error))
      .finally(() => this.#refresh());
  }

  #configure(change: Omit<MethodParams<'session.configure'>, 'sessionId'>): void {
    this.#run(this.#client.request('session.configure', { sessionId: this.#sessionId, ...change }));
  }

  #showConfig(): void {
    const session = this.#session;
    this.#term.line(
      t('attach.config', {
        model: `${session.providerId}/${session.modelId}`,
        effort: session.reasoningEffort ?? t('attach.effortDefault'),
        permission: permissionLabel(session.permissionMode ?? 'on_request'),
      }),
    );
    this.#refresh();
  }

  /** `/model`：不带参数列出会话所用 Provider 的模型；`<模型>` 换模型，`<Provider>/<模型>` 接力到别的来源。 */
  #model(arg: string): void {
    if (arg !== '') {
      const slash = arg.indexOf('/');
      if (slash > 0 && arg.slice(0, slash) !== this.#session.providerId) {
        const modelId = arg.slice(slash + 1);
        this.#configure({
          providerId: arg.slice(0, slash),
          ...(modelId !== '' && { modelId }),
        });
      } else {
        this.#configure({ modelId: slash > 0 ? arg.slice(slash + 1) : arg });
      }
      return;
    }
    this.#client
      .request('provider.list')
      .then(({ providers }) => {
        this.#showConfig();
        const provider = providers.find((p) => p.id === this.#session.providerId);
        for (const model of provider?.models ?? []) {
          const mark = model.id === this.#session.modelId ? '●' : ' ';
          const name =
            model.displayName && model.displayName !== model.id
              ? ` ${this.#ctx.styles.dim(model.displayName)}`
              : '';
          this.#term.line(`  ${mark} ${model.id}${name}`);
        }
      })
      .catch((error: unknown) => this.#report(error))
      .finally(() => this.#refresh());
  }

  /** `/goal <目标>` 设目标；`/goal pause|resume|clear`；不带参数显示现在的目标。 */
  #goal(arg: string): void {
    const sessionId = this.#sessionId;
    const word = arg.toLowerCase();
    if (word === 'pause' || word === 'resume') {
      this.#run(
        this.#client.request('session.updateGoal', {
          sessionId,
          status: word === 'pause' ? 'paused' : 'active',
        }),
      );
    } else if (word === 'clear') {
      this.#run(this.#client.request('session.clearGoal', { sessionId }), ({ cleared }) =>
        t(cleared ? 'render.goalCleared' : 'attach.noGoal'),
      );
    } else if (arg === '') {
      this.#client
        .request('session.get', { sessionId })
        .then(({ session }) => {
          const goal = session.goal;
          this.#term.line(
            goal === undefined
              ? t('attach.noGoal')
              : t('render.goal', {
                  status: t(`goalStatus.${goal.status}`),
                  objective: goal.objective,
                }),
          );
        })
        .catch((error: unknown) => this.#report(error))
        .finally(() => this.#refresh());
    } else {
      this.#run(this.#client.request('session.setGoal', { sessionId, objective: arg }));
    }
  }

  /** Tab（R11）：回合进行中、有内容时用另一种方式发出；返回 true 表示接下了这一行。 */
  #onTab(line: string): boolean {
    const text = line.trim();
    if (this.#done || !this.#caughtUp || !this.#pendingSupported || !this.#busy()) return false;
    if (text === '' || this.#nextApproval() !== undefined) return false;
    this.#sendTyped(text, this.#busyDelivery === 'steer' ? 'queue' : 'steer');
    return true;
  }

  #sendTyped(text: string, delivery: PendingDelivery, mode?: CollaborationMode): void {
    if (this.#term.interactive && (this.#busy() || mode !== undefined)) {
      // 回合运行中输入框常被流式输出盖住，补一行让用户看到自己发了什么、用的哪种方式。
      const how = this.#pendingSupported
        ? this.#ctx.styles.dim(t('common.parenAfter', { text: deliveryLabel(delivery) }))
        : '';
      const tag = mode === 'plan' ? this.#ctx.styles.dim(t('render.planTag')) : '';
      this.#term.line(`${this.#ctx.styles.dim(MESSAGE_PROMPT)}${text}${tag}${how}`);
    }
    void this.#send(text, this.#term.interactive, delivery, mode);
  }

  #resumePending(): void {
    if (this.#held.size === 0) {
      this.#term.line(this.#ctx.styles.dim(t('attach.noHeld')));
      this.#refresh();
      return;
    }
    this.#client
      .request('pending.resume', { sessionId: this.#sessionId })
      .then(() => this.#term.line(this.#ctx.styles.dim(t('attach.resumingHeld'))))
      .catch((error: unknown) => this.#report(error))
      .finally(() => this.#refresh());
  }

  async #send(
    text: string,
    echoed: boolean,
    delivery?: PendingDelivery,
    mode?: CollaborationMode,
  ): Promise<void> {
    const clientMessageId = `cli-${randomUUID()}`;
    if (echoed) this.#echoed.add(clientMessageId);
    const params = {
      sessionId: this.#sessionId,
      content: [{ type: 'text' as const, text }],
      clientMessageId,
      // 会话空闲时 Host 不看它；回合进行中成为待发消息（R11）。旧 Host 没有这项功能时不带，照旧 SESSION_BUSY。
      ...(this.#pendingSupported && delivery !== undefined && { delivery }),
      ...(mode !== undefined && { collaborationMode: mode }),
    };
    this.#exitArmed = false;
    this.#sending = true;
    this.#refresh();
    try {
      let result: { turnId?: TurnId };
      try {
        result = await this.#client.request('session.send', params);
      } catch (error) {
        const state = isRpcError(error, 'INVALID_STATE') ? error.data : undefined;
        if (!state || state.readOnly || (state.state !== 'error' && state.state !== 'closed')) {
          throw error;
        }
        this.#term.line(this.#ctx.styles.dim(t('attach.recovering')));
        await this.#client.request('session.resume', { sessionId: this.#sessionId });
        result = await this.#client.request('session.send', params);
      }
      // 成为待发消息时没有回合（R11）：它的去向看 pending.* 事件。
      if (result.turnId !== undefined && !this.#finishedTurns.has(result.turnId)) {
        this.#awaitingTurn = result.turnId;
      }
    } catch (error) {
      this.#report(error);
      if (isRpcError(error, 'SESSION_BUSY')) this.#draft = text;
    } finally {
      this.#sending = false;
      this.#refresh();
    }
  }

  #always(approval: ApprovalRequest): ApprovalOption | undefined {
    return this.#canRemember ? alwaysAllow(approval)?.option : undefined;
  }

  #answer(approval: ApprovalRequest, text: string): void {
    const always = this.#always(approval);
    const choice = parseApprovalChoice(approval.options, text, always);
    if (!choice) {
      this.#term.line(
        this.#ctx.styles.dim(
          t(always ? 'attach.answerHintAlways' : 'attach.answerHint', {
            count: approval.options.length,
          }),
        ),
      );
      this.#refresh();
      return;
    }
    const { option, remember } = choice;
    const id = approval.id;
    const reply = (async () => {
      try {
        await this.#client.request('approval.respond', {
          approvalId: id,
          optionId: option.optionId,
          ...(remember !== undefined && { remember }),
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

  /** 回答一组提问里的第 `index` 题；答完最后一题时提交整组。 */
  #answerQuestion(request: QuestionRequest, index: number, text: string): void {
    const question = request.questions[index] as UserQuestion;
    const answer = parseQuestionAnswer(question, text);
    if (answer === undefined) {
      this.#term.line(
        this.#ctx.styles.dim(
          t(question.multiSelect ? 'attach.questionHintMulti' : 'attach.questionHint', {
            count: question.options.length,
          }),
        ),
      );
      this.#refresh();
      return;
    }
    const draft =
      this.#answers?.id === request.id ? this.#answers : { id: request.id, answers: {} };
    draft.answers[question.id] = { answers: answer };
    this.#answers = draft;
    if (request.questions.some((item) => !(item.id in draft.answers))) {
      this.#refresh();
      return;
    }
    this.#answers = undefined;
    this.#answering.add(request.id);
    this.#client
      .request('question.respond', { questionId: request.id, answers: draft.answers })
      .catch((error: unknown) => this.#report(error))
      .finally(() => {
        this.#answering.delete(request.id);
        this.#refresh();
      });
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
        this.#term.line(s.dim(t('attach.cancellingAgain')));
        return;
      }
      this.#term.line(s.yellow(t('attach.cancelling')));
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
    this.#term.line(s.dim(t('attach.pressAgain')));
  }

  #report(error: unknown): void {
    const { message, hint } = describeError(error);
    const s = this.#ctx.styles;
    this.#term.line(s.red(message));
    if (hint) this.#term.line(s.dim(t('error.hint', { hint })));
  }

  #finish(code: number): void {
    if (this.#done) return;
    this.#done = true;
    this.#resolve(code);
  }
}

/** attach 的斜杠命令：用法与说明，`/help` 列出。 */
export const SLASH_COMMANDS = [
  'help',
  'plan',
  'undo',
  'redo',
  'model',
  'effort',
  'permission',
  'compact',
  'goal',
  'rename',
  'fork',
  'resume',
  'exit',
] as const;

/** 审批的输入框：`审批 [1 允许一次 / 2 拒绝 / a 总是允许·本项目 / g 总是允许·所有项目] › `。 */
export function approvalPrompt(options: readonly ApprovalOption[], always = false): string {
  const choices = options.map((o, i) => `${i + 1} ${optionLabel(o)}`);
  if (always) choices.push(t('attach.alwaysProject'), t('attach.alwaysGlobal'));
  return t('attach.approvalPrompt', { options: choices.join(' / ') });
}

/**
 * 解析审批的回答：同 `parseApprovalAnswer`；有“总是允许”（`always` 是它用的允许类选项）时另认 `a`（本项目）与 `g`
 * （所有项目）。
 */
export function parseApprovalChoice(
  options: readonly ApprovalOption[],
  text: string,
  always?: ApprovalOption,
): { option: ApprovalOption; remember?: ApprovalRuleScope } | undefined {
  const answer = text.trim().toLowerCase();
  if (always !== undefined && (answer === 'a' || answer === 'g')) {
    return { option: always, remember: answer === 'a' ? 'project' : 'global' };
  }
  const option = parseApprovalAnswer(options, text);
  return option === undefined ? undefined : { option };
}

/** 提问的输入框：`回答 1/2 [1–2 / 文字 / 回车跳过] › `。 */
export function questionPrompt(
  question: Pick<UserQuestion, 'options' | 'multiSelect' | 'allowOther'>,
  position: { index: number; total: number },
): string {
  const parts: string[] = [];
  const count = question.options.length;
  if (count > 0) {
    parts.push(
      t(question.multiSelect ? 'attach.questionPick.multi' : 'attach.questionPick', { count }),
    );
  }
  if (question.allowOther === true || count === 0) parts.push(t('attach.questionText'));
  parts.push(t('attach.questionSkip'));
  return t('attach.questionPrompt', { ...position, hint: parts.join(' / ') });
}

/**
 * 解析一题的回答：空行跳过（`[]`）；序号（多选题可用逗号或空格分隔多个）或选项原文选选项；可以自己填写（`allowOther`，
 * 与桌面端一样省略即不能）或没有选项时，其余文字原样作答。认不出时 undefined。
 */
export function parseQuestionAnswer(
  question: Pick<UserQuestion, 'options' | 'multiSelect' | 'allowOther'>,
  text: string,
): string[] | undefined {
  const answer = text.trim();
  if (answer === '') return [];
  const { options } = question;
  if (/^\d+(\s*[,，、\s]\s*\d+)*$/.test(answer)) {
    const picks = [...new Set(answer.split(/[\s,，、]+/).map(Number))];
    if (picks.length > 1 && !question.multiSelect) return undefined;
    const labels = picks.map((pick) => options[pick - 1]?.label);
    if (labels.every((label): label is string => label !== undefined)) return labels;
    if (options.length > 0) return undefined;
  }
  const byLabel = options.find((option) => option.label.toLowerCase() === answer.toLowerCase());
  if (byLabel) return [byLabel.label];
  if (question.allowOther !== true && options.length > 0) return undefined;
  return [answer];
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
