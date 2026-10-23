import type {
  ApprovalId,
  ApprovalRequest,
  PendingFallbackReason,
  PendingMessage,
  SessionId,
  SubagentSummary,
  ToolDisplay,
  TurnId,
  UserContentPart,
  WevirEvent,
  WevirEventOf,
} from '@wevir/protocol';
import {
  alwaysAllow,
  approvalEndLabel,
  clientLabel,
  engineErrorHint,
  engineErrorLabel,
  filesRestoreLabel,
  formatDuration,
  optionLabel,
  permissionLabel,
  readOnlyLabel,
  stateReasonLabel,
  subagentEndLabel,
  toolStatusLabel,
  truncate,
  turnOutcomeLabel,
} from './format.js';
import { joinList, t } from './i18n/index.js';
import type { Styles } from './style.js';

/** 渲染的去处（attach 的 `LineConsole`；测试里是字符串）。 */
export interface Sink {
  /** 一段文字，可以是半行。 */
  write(text: string): void;
  /** 从新的一行开始写一整行。 */
  line(text?: string): void;
  /** 结束当前的半行。 */
  endLine(): void;
}

export interface RendererOptions {
  sink: Sink;
  styles: Styles;
  /** 本终端发出、已经显示在屏幕上的消息（`clientMessageId`），收到 `user.message` 时不再重复显示。 */
  isEchoed?: (clientMessageId: string) => boolean;
  /** 这条审批是不是本终端处理的。 */
  decidedHere?: (approvalId: ApprovalId) => boolean;
  /** 这条连接能加审批规则（`policy.write`）：有提议的审批显示“总是允许”。 */
  canRemember?: boolean;
}

interface Block {
  turnId: TurnId;
  kind: 'text' | 'reasoning';
  text: string;
  /** 已经显示在屏幕上（实时阶段的增量）。 */
  printed: boolean;
}

/**
 * 把会话事件渲染成终端文字。
 *
 * 增量与已提交消息（domain-model §6.3）：实时阶段增量到达即显示；`assistant.message` / `assistant.thought`
 * 替换的增量块已经显示过时不再重复，否则显示全文。回放阶段（订阅追平之前）不显示增量，只显示已提交的
 * 消息；追平时仍未被替换的增量（正在生成的那一段）一次补上，之后接着实时显示。
 *
 * 回放的历史里思考过程折叠成一行，实时的思考以暗色显示。
 */
export class EventRenderer {
  readonly #sink: Sink;
  readonly #s: Styles;
  readonly #options: RendererOptions;
  #live = false;
  #replayed = 0;
  /** `${streamId}:${blockIndex}` → 块，按到达顺序。 */
  readonly #blocks = new Map<string, Block>();
  /** 正在显示的增量块。 */
  #current: string | undefined;
  readonly #tools = new Map<string, string>();
  readonly #approvals = new Map<ApprovalId, ApprovalRequest>();
  /** 子会话上一次的摘要（R4），用来只在状态与审批变了时显示。 */
  readonly #subagents = new Map<SessionId, SubagentSummary>();

  constructor(options: RendererOptions) {
    this.#sink = options.sink;
    this.#s = options.styles;
    this.#options = options;
  }

  /** 订阅追平：此后的事件都是实时的。 */
  caughtUp(): void {
    if (this.#live) return;
    this.#live = true;
    if (this.#replayed > 1) this.#sink.line(this.#s.dim(t('render.liveDivider')));
    for (const [key, block] of this.#blocks) {
      if (block.text === '') continue;
      this.#printDelta(key, block, block.text);
    }
  }

  /** 订阅被重置（Host 的数据比本地旧）：之后从头回放。 */
  reset(): void {
    this.#sink.endLine();
    this.#sink.line(this.#s.yellow(t('render.reset')));
    this.#live = false;
    this.#replayed = 0;
    this.#blocks.clear();
    this.#current = undefined;
  }

  /** 已知的审批（含已处理的），供输入框显示选项。 */
  approval(id: ApprovalId): ApprovalRequest | undefined {
    return this.#approvals.get(id);
  }

  render(event: WevirEvent): void {
    if (!this.#live) this.#replayed += 1;
    switch (event.type) {
      case 'session.created':
      case 'session.title_changed':
      case 'turn.started':
      case 'tool.updated':
      case 'usage.updated':
      case 'engine.raw':
        return;
      case 'session.resumed': {
        const version = event.payload.engineVersion;
        this.#sink.line(
          this.#s.dim(version ? t('render.resumedVersion', { version }) : t('render.resumed')),
        );
        return;
      }
      case 'session.configured': {
        // 0.9.0：只在实时时说一声（回放时开头已显示会话现在的模型）。
        if (!this.#live) return;
        const { modelId, reasoningEffort, permissionMode } = event.payload;
        const parts = [modelId, reasoningEffort, permissionLabel(permissionMode ?? 'on_request')];
        this.#sink.line(
          this.#s.dim(t('render.configured', { config: parts.filter(Boolean).join(' · ') })),
        );
        return;
      }
      case 'session.goal_changed': {
        if (!this.#live) return;
        const { goal } = event.payload;
        this.#sink.line(
          this.#s.dim(
            goal === null
              ? t('render.goalCleared')
              : t('render.goal', {
                  status: t(`goalStatus.${goal.status}`),
                  objective: goal.objective,
                }),
          ),
        );
        return;
      }
      case 'turn.undone':
        this.#sink.line(
          this.#s.dim(`↶ ${t('render.undone', { files: filesRestoreLabel(event.payload.files) })}`),
        );
        return;
      case 'turn.redone':
        this.#sink.line(
          this.#s.dim(`↷ ${t('render.redone', { files: filesRestoreLabel(event.payload.files) })}`),
        );
        return;
      case 'turn.rewound':
        this.#sink.line(this.#s.dim(t('render.rewound')));
        return;
      case 'session.handoff':
        // 0.25.0：换到了别的来源（接力）；交给新模型的摘要不显示。
        this.#sink.line(
          this.#s.dim(
            t('render.handoff', {
              provider: event.payload.to.providerId,
              model: event.payload.to.modelId,
            }),
          ),
        );
        return;
      case 'session.moved':
        // 0.81.0：会话换了目录（移到工作树或移回本地）。
        this.#sink.line(
          this.#s.dim(
            t(event.payload.to === 'local' ? 'render.movedToLocal' : 'render.movedToWorktree', {
              cwd: event.payload.cwd,
            }),
          ),
        );
        return;
      case 'session.read_only':
        this.#sink.line(
          this.#s.yellow(
            t('render.readOnly', {
              reason: readOnlyLabel(event.payload.reason),
              message: event.payload.message,
            }),
          ),
        );
        return;
      case 'session.state_changed': {
        const { to, reason } = event.payload;
        if (to === 'error') {
          const why = stateReasonLabel(reason);
          this.#sink.line(
            this.#s.red(why ? t('render.sessionErrorWhy', { why }) : t('render.sessionError')),
          );
        } else if (to === 'closed') {
          this.#sink.line(this.#s.dim(t('render.sessionClosed')));
        }
        return;
      }
      case 'user.message':
        this.#userMessage(event);
        return;
      case 'user.steered':
        this.#steered(event);
        return;
      case 'pending.added':
      case 'pending.updated':
        // 待发消息（R11）只在实时时提示；回放时看最后的状态（attach 追平后单独说暂停的）。
        if (this.#live) this.#pending(event.type, event.payload.pending);
        return;
      case 'assistant.delta':
        this.#delta(event);
        return;
      case 'assistant.message':
      case 'assistant.thought':
        this.#committed(event);
        return;
      case 'assistant.stream_ended':
        this.#streamEnded(event);
        return;
      case 'tool.started':
        this.#tools.set(event.payload.toolCallId, event.payload.toolName);
        this.#sink.line(
          `${this.#s.cyan('●')} ${this.#s.bold(event.payload.toolName)}${describeTool(event.payload.display)}`,
        );
        return;
      case 'tool.finished':
        this.#toolFinished(event);
        return;
      case 'todo.updated':
        for (const item of event.payload.items) {
          const mark =
            item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐';
          this.#sink.line(this.#s.dim(`  ${mark} ${item.content}`));
        }
        return;
      case 'plan.proposed':
        // 计划（0.36.0）：标题一行，Markdown 原样缩进两格。
        this.#sink.line(`${this.#s.cyan('▣')} ${this.#s.bold(t('render.plan'))}`);
        for (const line of event.payload.text.split('\n')) this.#sink.line(`  ${line}`);
        return;
      case 'approval.requested':
        this.#approvalRequested(event.payload.approval);
        return;
      case 'approval.resolved':
        this.#approvalResolved(event);
        return;
      case 'question.requested': {
        // 0.10.0：问题在这里列出，attach 的输入框逐题回答。
        const { questions } = event.payload.question;
        this.#sink.line(this.#s.yellow(t('render.question')));
        for (const item of questions) {
          this.#sink.line(
            `  ${item.header ? t('render.questionWithHeader', { header: item.header, question: item.question }) : item.question}`,
          );
          item.options.forEach((option, index) => {
            const note = option.description ? this.#s.dim(` — ${option.description}`) : '';
            this.#sink.line(`    ${index + 1}) ${option.label}${note}`);
          });
        }
        return;
      }
      case 'question.resolved': {
        const { status, resolution } = event.payload;
        if (status === 'cancelled') {
          this.#sink.line(this.#s.dim(t('render.questionCancelled')));
          return;
        }
        const answers = Object.entries(resolution.answers ?? {})
          .map(([id, answer]) => `${id}=${joinList(answer.answers) || t('render.answerSkipped')}`)
          .join(t('list.semicolon'));
        const key = resolution.reason === 'timeout' ? 'render.answeredTimeout' : 'render.answered';
        this.#sink.line(this.#s.dim(t(key, { answers })));
        return;
      }
      case 'engine.error': {
        const { category, message } = event.payload;
        this.#sink.line(
          this.#s.red(t('err.engineCategory', { category: engineErrorLabel(category), message })),
        );
        this.#sink.line(this.#s.dim(t('error.hint', { hint: engineErrorHint(category) })));
        return;
      }
      case 'subagent.started':
      case 'subagent.updated':
        this.#subagent(event.payload.subagent);
        return;
      case 'turn.finished': {
        const { outcome, durationMs, turnId } = event.payload;
        this.#dropTurn(turnId);
        const paint = outcome === 'completed' ? this.#s.dim : this.#s.yellow;
        this.#sink.line(
          paint(
            t('render.turnFinished', {
              outcome: turnOutcomeLabel(outcome),
              duration: formatDuration(durationMs),
            }),
          ),
        );
        return;
      }
    }
  }

  #userMessage(event: WevirEventOf<'user.message'>): void {
    const { clientMessageId, content, sentBy, collaborationMode } = event.payload;
    if (this.#live && clientMessageId && this.#options.isEchoed?.(clientMessageId)) return;
    const text = contentText(content, '\n');
    const from =
      sentBy.clientKind === 'cli'
        ? ''
        : this.#s.dim(t('render.from', { client: clientLabel(sentBy) }));
    const mode = collaborationMode === 'plan' ? this.#s.dim(t('render.planTag')) : '';
    this.#sink.line();
    this.#sink.line(`${this.#s.bold(this.#s.cyan('›'))} ${text}${mode}${from}`);
  }

  /** 插话进了回合（R11）：像用户消息一样显示，标上“插话”。 */
  #steered(event: WevirEventOf<'user.steered'>): void {
    const { clientMessageId, content, sentBy } = event.payload;
    if (this.#live && clientMessageId && this.#options.isEchoed?.(clientMessageId)) {
      this.#sink.line(this.#s.dim(t('render.steerEchoed')));
      return;
    }
    const text = contentText(content, '\n');
    const tag =
      sentBy.clientKind === 'cli'
        ? t('render.steerTag')
        : t('render.steerTagFrom', { client: clientLabel(sentBy) });
    this.#sink.line();
    this.#sink.line(`${this.#s.bold(this.#s.cyan('›'))} ${text}${this.#s.dim(tag)}`);
  }

  #pending(type: 'pending.added' | 'pending.updated', pending: PendingMessage): void {
    const text = pendingPreview(pending);
    const fallback = pending.fallback ? pendingFallbackLabel(pending.fallback.reason) : undefined;
    if (type === 'pending.added') {
      const how =
        pending.delivery === 'steer'
          ? t('render.pendingSteer')
          : (fallback ?? t('render.pendingQueued'));
      this.#sink.line(this.#s.dim(`⋯ ${how} · ${text}`));
      return;
    }
    if (pending.status === 'held') {
      this.#sink.line(this.#s.yellow(`⋯ ${t('render.pendingHeld', { text })}`));
    } else if (pending.status === 'cancelled') {
      this.#sink.line(this.#s.dim(`⋯ ${t('render.pendingCancelled', { text })}`));
    } else if (pending.status === 'waiting' && fallback !== undefined) {
      this.#sink.line(this.#s.dim(`⋯ ${fallback} · ${text}`));
    }
  }

  #delta(event: WevirEventOf<'assistant.delta'>): void {
    const { streamId, blockIndex, kind, text, turnId } = event.payload;
    const key = `${streamId}:${blockIndex}`;
    let block = this.#blocks.get(key);
    if (!block) {
      block = { turnId, kind, text: '', printed: false };
      this.#blocks.set(key, block);
    }
    block.text += text;
    if (this.#live) this.#printDelta(key, block, text);
  }

  #printDelta(key: string, block: Block, text: string): void {
    if (this.#current !== key) {
      this.#sink.endLine();
      if (block.kind === 'reasoning') this.#sink.write(this.#s.dim(t('render.thinking')));
      this.#current = key;
    }
    block.printed = true;
    this.#sink.write(block.kind === 'reasoning' ? this.#s.dim(text) : text);
  }

  #committed(event: WevirEventOf<'assistant.message'> | WevirEventOf<'assistant.thought'>): void {
    const { replaces, text } = event.payload;
    let shown = false;
    for (const ref of replaces) {
      const key = `${ref.streamId}:${ref.blockIndex}`;
      if (this.#blocks.get(key)?.printed) shown = true;
      this.#blocks.delete(key);
    }
    const thought = event.type === 'assistant.thought';
    if (shown) {
      // 增量已经显示过：只结束那一段。
      this.#sink.endLine();
      this.#current = undefined;
      return;
    }
    this.#current = undefined;
    if (text.trim() === '') return;
    if (thought) {
      this.#sink.line(
        this.#live
          ? this.#s.dim(`${t('render.thinking')}${text}`)
          : this.#s.dim(t('render.thoughtCollapsed', { count: [...text].length })),
      );
    } else {
      this.#sink.line(text);
    }
  }

  #streamEnded(event: WevirEventOf<'assistant.stream_ended'>): void {
    if (event.payload.outcome !== 'abandoned') return;
    let printed = false;
    for (const [key, block] of this.#blocks) {
      if (!key.startsWith(`${event.payload.streamId}:`)) continue;
      printed ||= block.printed;
      this.#blocks.delete(key);
    }
    if (printed) {
      this.#current = undefined;
      this.#sink.line(this.#s.dim(t('render.abandoned')));
    }
  }

  #toolFinished(event: WevirEventOf<'tool.finished'>): void {
    const { toolCallId, status, output } = event.payload;
    const name = this.#tools.get(toolCallId) ?? t('render.tool');
    const label = `${name} ${toolStatusLabel(status)}`;
    const detail = output && status !== 'completed' ? firstLines(output.text) : '';
    const paint =
      status === 'completed'
        ? this.#s.green
        : status === 'failed'
          ? this.#s.red
          : status === 'cancelled'
            ? this.#s.yellow
            : this.#s.dim;
    this.#sink.line(
      `  ${paint(`⎿ ${label}`)}${detail ? this.#s.dim(t('common.colonDetail', { detail })) : ''}`,
    );
  }

  /**
   * 子会话（R4）：开始、离开“运行中”（完成、失败、已关闭、已取消）、又开始工作各一行；它的审批在这里显示，由父会话的
   * attach 回答（审批属于子会话，结果随摘要的 `pendingApprovals` 去掉）。
   */
  #subagent(summary: SubagentSummary): void {
    const previous = this.#subagents.get(summary.sessionId);
    this.#subagents.set(summary.sessionId, summary);
    const name = summary.title || t('render.subagent');
    const title = this.#s.bold(name);
    if (previous === undefined) {
      const model = [summary.modelId, summary.reasoningEffort].filter(Boolean).join(' · ');
      this.#sink.endLine();
      this.#sink.line(
        `${this.#s.cyan('↳')} ${t('render.subagentStarted', {
          title,
          model: this.#s.dim(t('common.parenAfter', { text: model })),
        })}`,
      );
    } else if (previous.status !== 'running' && summary.status === 'running') {
      this.#sink.line(`${this.#s.cyan('↳')} ${t('render.subagentResumed', { title })}`);
    }
    if (summary.status !== 'running' && previous?.status !== summary.status) {
      const paint = summary.status === 'completed' ? this.#s.green : this.#s.yellow;
      this.#sink.line(
        paint(t('render.subagentEnded', { status: subagentEndLabel(summary.status) })) + title,
      );
    }
    const before = new Set(previous?.pendingApprovals.map((approval) => approval.id));
    for (const approval of summary.pendingApprovals) {
      if (!before.has(approval.id)) this.#approvalRequested(approval, name);
    }
    for (const id of before) {
      if (summary.pendingApprovals.some((approval) => approval.id === id)) continue;
      this.#sink.line(this.#s.dim(t('render.subagentApprovalEnded', { title: summary.title })));
    }
  }

  #approvalRequested(approval: ApprovalRequest, subagent?: string): void {
    this.#approvals.set(approval.id, approval);
    const detail = approval.detail;
    const what = detail
      ? `${detail.toolName}${describeTool(detail.display)}`
      : t('render.oneToolCall');
    const from =
      subagent === undefined ? '' : t('render.approvalFromSubagent', { title: subagent });
    this.#sink.line(this.#s.yellow(t('render.approvalNeeded', { from, what })));
    if (detail?.justification) {
      this.#sink.line(`  ${t('render.justification', { text: detail.justification })}`);
    }
    if (detail?.sandboxPermissions) {
      this.#sink.line(`  ${t('render.sandboxPermissions', { text: detail.sandboxPermissions })}`);
    }
    const options = approval.options
      .map((option, i) => `${i + 1}) ${optionLabel(option)}`)
      .join('  ');
    this.#sink.line(`  ${t('render.options', { options })}`);
    const always = this.#options.canRemember ? alwaysAllow(approval) : undefined;
    if (always) this.#sink.line(`  ${t('render.alwaysAllow', { prefix: always.prefix })}`);
  }

  #approvalResolved(event: WevirEventOf<'approval.resolved'>): void {
    const { approvalId, resolution, status } = event.payload;
    const approval = this.#approvals.get(approvalId);
    if (approval) {
      approval.status = status;
      approval.resolution = resolution;
    }
    if (resolution.reason !== 'user') {
      this.#sink.line(this.#s.dim(approvalEndLabel(resolution.reason)));
      return;
    }
    const option = approval?.options.find((o) => o.optionId === resolution.optionId);
    const decision = option ? optionLabel(option) : (resolution.optionId ?? status);
    const paint = status === 'approved' ? this.#s.green : this.#s.yellow;
    const ruled = (resolution.ruleIds?.length ?? 0) > 0 ? this.#s.dim(t('render.ruleAdded')) : '';
    if (this.#live && this.#options.decidedHere?.(approvalId)) {
      this.#sink.line(paint(t('render.decidedHere', { decision })) + ruled);
    } else if (resolution.decidedBy) {
      this.#sink.line(
        paint(t('render.decidedBy', { client: clientLabel(resolution.decidedBy), decision })) +
          ruled,
      );
    } else {
      this.#sink.line(paint(t('render.decided', { decision })) + ruled);
    }
  }

  /** 回合结束：本回合没被替换的增量一律丢弃（domain-model §6.3 规则 4）。 */
  #dropTurn(turnId: TurnId): void {
    for (const [key, block] of this.#blocks) {
      if (block.turnId === turnId) this.#blocks.delete(key);
    }
    this.#current = undefined;
    this.#sink.endLine();
  }
}

/** 工具调用的一行摘要（前面带空格）；没有可显示的内容时为空串。 */
export function describeTool(display: ToolDisplay): string {
  const summary = display.summary ?? display.command ?? display.paths?.join(' ') ?? display.query;
  return summary ? ` ${truncate(summary, 100)}` : '';
}

function firstLines(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return truncate(lines.slice(0, 2).join(' '), 160);
}

/** 插话没成、转为排队的原因（R11，domain-model §3.3.2）。 */
const pendingFallbackLabel = (reason: PendingFallbackReason): string =>
  t(`pendingFallback.${reason}`);

/** 用户消息的文本：图片写成“[图片]”（0.28.0）。 */
function contentText(content: readonly UserContentPart[], separator: string): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : t('render.image')))
    .join(separator);
}

/** 待发消息的一行预览：首行，过长截断。 */
export function pendingPreview(pending: PendingMessage): string {
  const text = contentText(pending.content, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
