import type {
  ApprovalId,
  ApprovalRequest,
  PendingFallbackReason,
  PendingMessage,
  SessionId,
  SubagentSummary,
  ToolDisplay,
  TurnId,
  WevirEvent,
  WevirEventOf,
} from '@wevir/protocol';
import {
  APPROVAL_END_LABEL,
  clientLabel,
  ENGINE_ERROR_HINT,
  ENGINE_ERROR_LABEL,
  formatDuration,
  optionLabel,
  READ_ONLY_LABEL,
  STATE_REASON_LABEL,
  SUBAGENT_END_LABEL,
  TOOL_STATUS_LABEL,
  TURN_OUTCOME_LABEL,
  truncate,
} from './format.js';
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
    if (this.#replayed > 1) this.#sink.line(this.#s.dim('── 以上为历史，以下为实时 ──'));
    for (const [key, block] of this.#blocks) {
      if (block.text === '') continue;
      this.#printDelta(key, block, block.text);
    }
  }

  /** 订阅被重置（Host 的数据比本地旧）：之后从头回放。 */
  reset(): void {
    this.#sink.endLine();
    this.#sink.line(this.#s.yellow('Host 上的会话历史与本地看到的不一致，重新回放。'));
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
        this.#sink.line(this.#s.dim(`（引擎会话已恢复${version ? `，${version}` : ''}）`));
        return;
      }
      case 'session.read_only':
        this.#sink.line(
          this.#s.yellow(
            `会话只读：${READ_ONLY_LABEL[event.payload.reason]}（${event.payload.message}）`,
          ),
        );
        this.#sink.line(this.#s.dim('历史仍可查看；要继续对话请新建会话。'));
        return;
      case 'session.state_changed': {
        const { to, reason } = event.payload;
        if (to === 'error') {
          const why = STATE_REASON_LABEL[reason];
          this.#sink.line(
            this.#s.red(`会话出错${why ? `：${why}` : ''}。再发一条消息会尝试恢复。`),
          );
        } else if (to === 'closed') {
          this.#sink.line(this.#s.dim('会话已关闭。'));
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
      case 'approval.requested':
        this.#approvalRequested(event.payload.approval);
        return;
      case 'approval.resolved':
        this.#approvalResolved(event);
        return;
      case 'engine.error': {
        const { category, message } = event.payload;
        this.#sink.line(this.#s.red(`引擎错误（${ENGINE_ERROR_LABEL[category]}）：${message}`));
        this.#sink.line(this.#s.dim(`下一步：${ENGINE_ERROR_HINT[category]}`));
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
          paint(`── 本轮${TURN_OUTCOME_LABEL[outcome]} · ${formatDuration(durationMs)} ──`),
        );
        return;
      }
    }
  }

  #userMessage(event: WevirEventOf<'user.message'>): void {
    const { clientMessageId, content, sentBy } = event.payload;
    if (this.#live && clientMessageId && this.#options.isEchoed?.(clientMessageId)) return;
    const text = content.map((part) => part.text).join('\n');
    const from = sentBy.clientKind === 'cli' ? '' : this.#s.dim(`（来自 ${clientLabel(sentBy)}）`);
    this.#sink.line();
    this.#sink.line(`${this.#s.bold(this.#s.cyan('›'))} ${text}${from}`);
  }

  /** 插话进了回合（R11）：像用户消息一样显示，标上“插话”。 */
  #steered(event: WevirEventOf<'user.steered'>): void {
    const { clientMessageId, content, sentBy } = event.payload;
    if (this.#live && clientMessageId && this.#options.isEchoed?.(clientMessageId)) {
      this.#sink.line(this.#s.dim('（插话已插进本回合）'));
      return;
    }
    const text = content.map((part) => part.text).join('\n');
    const from = sentBy.clientKind === 'cli' ? '' : `，来自 ${clientLabel(sentBy)}`;
    this.#sink.line();
    this.#sink.line(`${this.#s.bold(this.#s.cyan('›'))} ${text}${this.#s.dim(`（插话${from}）`)}`);
  }

  #pending(type: 'pending.added' | 'pending.updated', pending: PendingMessage): void {
    const text = pendingPreview(pending);
    const fallback = pending.fallback ? PENDING_FALLBACK_LABEL[pending.fallback.reason] : undefined;
    if (type === 'pending.added') {
      const how =
        pending.delivery === 'steer'
          ? '插话：等这一步结束后插进本回合'
          : (fallback ?? '已排队：本回合结束后发出');
      this.#sink.line(this.#s.dim(`⋯ ${how} · ${text}`));
      return;
    }
    if (pending.status === 'held') {
      this.#sink.line(this.#s.yellow(`⋯ 已暂停 · ${text}（输入 /resume 继续发送）`));
    } else if (pending.status === 'cancelled') {
      this.#sink.line(this.#s.dim(`⋯ 已删除待发消息 · ${text}`));
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
      if (block.kind === 'reasoning') this.#sink.write(this.#s.dim('思考：'));
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
          ? this.#s.dim(`思考：${text}`)
          : this.#s.dim(`（思考过程 ${[...text].length} 字，已折叠）`),
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
      this.#sink.line(this.#s.dim('（上面这段输出被模型放弃，以后续内容为准）'));
    }
  }

  #toolFinished(event: WevirEventOf<'tool.finished'>): void {
    const { toolCallId, status, output } = event.payload;
    const name = this.#tools.get(toolCallId) ?? '工具';
    const label = `${name} ${TOOL_STATUS_LABEL[status]}`;
    const detail = output && status !== 'completed' ? firstLines(output.text) : '';
    const paint =
      status === 'completed'
        ? this.#s.green
        : status === 'failed'
          ? this.#s.red
          : status === 'cancelled'
            ? this.#s.yellow
            : this.#s.dim;
    this.#sink.line(`  ${paint(`⎿ ${label}`)}${detail ? this.#s.dim(`：${detail}`) : ''}`);
  }

  /**
   * 子会话（R4）：开始、离开“运行中”（完成、失败、已关闭、已取消）、又开始工作各一行；它的审批在这里显示，由父会话的
   * attach 回答（审批属于子会话，结果随摘要的 `pendingApprovals` 去掉）。
   */
  #subagent(summary: SubagentSummary): void {
    const previous = this.#subagents.get(summary.sessionId);
    this.#subagents.set(summary.sessionId, summary);
    const title = this.#s.bold(summary.title || '子 agent');
    if (previous === undefined) {
      const model = [summary.modelId, summary.reasoningEffort].filter(Boolean).join(' · ');
      this.#sink.endLine();
      this.#sink.line(
        `${this.#s.cyan('↳')} 子 agent 开始工作：${title}${this.#s.dim(`（${model}）`)}`,
      );
    } else if (previous.status !== 'running' && summary.status === 'running') {
      this.#sink.line(`${this.#s.cyan('↳')} 子 agent 继续工作：${title}`);
    }
    if (summary.status !== 'running' && previous?.status !== summary.status) {
      const paint = summary.status === 'completed' ? this.#s.green : this.#s.yellow;
      this.#sink.line(paint(`↳ 子 agent ${SUBAGENT_END_LABEL[summary.status]}：`) + title);
    }
    const before = new Set(previous?.pendingApprovals.map((approval) => approval.id));
    for (const approval of summary.pendingApprovals) {
      if (!before.has(approval.id)) this.#approvalRequested(approval, summary.title || '子 agent');
    }
    for (const id of before) {
      if (summary.pendingApprovals.some((approval) => approval.id === id)) continue;
      this.#sink.line(this.#s.dim(`（子 agent ${summary.title || ''} 的审批已结束）`));
    }
  }

  #approvalRequested(approval: ApprovalRequest, subagent?: string): void {
    this.#approvals.set(approval.id, approval);
    const detail = approval.detail;
    const what = detail ? `${detail.toolName}${describeTool(detail.display)}` : '一次工具调用';
    const from = subagent === undefined ? '' : `（来自子 agent ${subagent}）`;
    this.#sink.line(this.#s.yellow(`⚠ 需要审批${from}：${what}`));
    if (detail?.justification) this.#sink.line(`  理由：${detail.justification}`);
    if (detail?.sandboxPermissions) this.#sink.line(`  申请权限：${detail.sandboxPermissions}`);
    this.#sink.line(
      `  选项：${approval.options.map((option, i) => `${i + 1}) ${optionLabel(option)}`).join('  ')}`,
    );
  }

  #approvalResolved(event: WevirEventOf<'approval.resolved'>): void {
    const { approvalId, resolution, status } = event.payload;
    const approval = this.#approvals.get(approvalId);
    if (approval) {
      approval.status = status;
      approval.resolution = resolution;
    }
    if (resolution.reason !== 'user') {
      this.#sink.line(this.#s.dim(APPROVAL_END_LABEL[resolution.reason]));
      return;
    }
    const option = approval?.options.find((o) => o.optionId === resolution.optionId);
    const decision = option ? optionLabel(option) : (resolution.optionId ?? status);
    const paint = status === 'approved' ? this.#s.green : this.#s.yellow;
    if (this.#live && this.#options.decidedHere?.(approvalId)) {
      this.#sink.line(paint(`✓ 本终端已处理：${decision}`));
    } else if (resolution.decidedBy) {
      this.#sink.line(paint(`✓ 已由 ${clientLabel(resolution.decidedBy)} 处理：${decision}`));
    } else {
      this.#sink.line(paint(`✓ 已处理：${decision}`));
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
const PENDING_FALLBACK_LABEL: Record<PendingFallbackReason, string> = {
  unsupported: '这个引擎不能插话，已转为排队',
  rejected: '模型这一轮不能插话，已转为排队',
  turn_ended: '这一轮结束时还没插进去，已转为排队',
};

/** 待发消息的一行预览：首行，过长截断。 */
export function pendingPreview(pending: PendingMessage): string {
  const text = pending.content
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
