import type {
  AssistantDeltaEvent,
  AssistantStreamEndedEvent,
  DeltaBlockRef,
} from '@wevir/runtime-adapter';

// 增量与已提交消息的对齐（T3.2，domain-model.md §6.3，ADR-0001 §3）。一个会话一个，按回合重置。
//
// 两条管道之间没有顺序保证：增量来自 stream-tap 的 fd 3（插件异步写），已提交消息来自 ACP 的 stdout。
// dsh 那边的顺序是确定的：一个 attempt 的增量全部写出之后才提交 assistant/message，ACP 再按块顺序为每个
// 非空的文本块发一条 agent_message_chunk、每个非空的推理块发一条 agent_thought_chunk（同一 messageId），
// 取消时只保留含非空白字符的块（上游 `dsh-acp/src/updates.ts`、`dsh-llm/src/assembler.ts`）。但 Host
// 读两条管道的先后不定，所以：
//
// 1. attempt 按第一次出现增量的顺序排队，等待已提交消息；ACP 出现新的 messageId 时，取队列里第一个内容
//    对得上的 attempt（它的某个同类块的文本是已提交文本的前缀；前缀而不是相等，因为尾部增量可能还在 fd 3
//    里）。排在它前面的 attempt 不会再有已提交消息（重试丢弃、没有内容的结算），一并出队。
// 2. 配对之后该 attempt 再到的增量丢弃：已提交内容已经替换了它。
// 3. 已提交消息到达时一个对得上的 attempt 都没有（增量整个落在消息后面），记下这条消息；之后出现的
//    attempt 若第一段增量是它的前缀，就认定属于这条已经发出的消息，增量全部丢弃。
// 4. `abandoned` 的 end 帧让 attempt 出队；它的增量不会被替换（Host 收到 stream_ended 即可丢弃）。
// 5. 回合结束时清空；上一回合的 attempt 迟到的帧丢弃。回合结束后仍没被替换的增量由 Host 兜底丢弃
//    （domain-model.md §6.3 规则 4），所以任何对不上的情况都不会在回合结束后留下重复文本。

type BlockKind = AssistantDeltaEvent['kind'];

interface Block {
  index: number;
  kind: BlockKind;
  text: string;
  replaced: boolean;
}

interface Attempt {
  id: string;
  /** waiting：等已提交消息；paired：已配对，之后的增量丢弃；dropped：不会被替换。 */
  state: 'waiting' | 'paired' | 'dropped';
  /** 至少发出过一个增量；没发出过的 attempt 不发 stream_ended。 */
  emitted: boolean;
  /** 按首次出现的顺序。 */
  blocks: Block[];
}

/** 没有配上 attempt 的已提交块。 */
interface Orphan {
  messageId: string;
  kind: BlockKind;
  text: string;
}

export class DeltaMerger {
  #attempts = new Map<string, Attempt>();
  #waiting: Attempt[] = [];
  #orphans: Orphan[] = [];
  /** messageId → 配上的 attempt；null 表示没配上。 */
  #paired = new Map<string, Attempt | null>();
  /** 上一回合的 attemptId，迟到的帧丢弃。 */
  #retired = new Set<string>();

  /** 返回要发出的增量；属于已提交内容或上一回合的返回 undefined。 */
  delta(event: AssistantDeltaEvent): AssistantDeltaEvent | undefined {
    if (this.#retired.has(event.attemptId)) return undefined;
    let attempt = this.#attempts.get(event.attemptId);
    if (attempt === undefined) {
      attempt = { id: event.attemptId, state: 'waiting', emitted: false, blocks: [] };
      this.#attempts.set(attempt.id, attempt);
      const orphan = this.#orphans.findIndex(
        (o) => o.kind === event.kind && o.text.startsWith(event.text),
      );
      if (orphan === -1) {
        this.#waiting.push(attempt);
      } else {
        // 规则 3：已提交消息先到了。这条消息的其余块、以及更早的孤儿都不会再配上。
        const messageId = (this.#orphans[orphan] as Orphan).messageId;
        attempt.state = 'paired';
        this.#paired.set(messageId, attempt);
        this.#orphans = this.#orphans.slice(orphan).filter((o) => o.messageId !== messageId);
      }
    }
    if (attempt.state !== 'waiting') return undefined;
    let block = attempt.blocks.find((b) => b.index === event.blockIndex);
    if (block === undefined) {
      block = { index: event.blockIndex, kind: event.kind, text: '', replaced: false };
      attempt.blocks.push(block);
    }
    block.text += event.text;
    attempt.emitted = true;
    return event;
  }

  /** 返回要发出的 stream_ended；attempt 没发出过增量时返回 undefined。 */
  ended(event: AssistantStreamEndedEvent): AssistantStreamEndedEvent | undefined {
    const attempt = this.#attempts.get(event.attemptId);
    if (attempt === undefined || !attempt.emitted) return undefined;
    if (event.outcome === 'abandoned' && attempt.state === 'waiting') {
      attempt.state = 'dropped';
      this.#waiting = this.#waiting.filter((a) => a !== attempt);
    }
    return event;
  }

  /** 一条已提交的块（ACP `agent_message_chunk` / `agent_thought_chunk`）替换哪些增量块。 */
  commit(kind: BlockKind, messageId: string, text: string): DeltaBlockRef[] {
    // 同一条消息的前一个块没配上（例如推理没有增量）时，这个块再找一次。
    let attempt = this.#paired.get(messageId) ?? undefined;
    if (attempt === undefined) {
      const at = this.#waiting.findIndex((a) => matchBlock(a, kind, text) !== undefined);
      if (at !== -1) {
        attempt = this.#waiting[at] as Attempt;
        // 规则 1：排在前面的 attempt 不会再有已提交消息。
        for (const skipped of this.#waiting.slice(0, at)) skipped.state = 'dropped';
        this.#waiting = this.#waiting.slice(at + 1);
        this.#orphans = this.#orphans.filter((o) => o.messageId !== messageId);
        attempt.state = 'paired';
        this.#paired.set(messageId, attempt);
      }
    }
    if (attempt === undefined) {
      this.#paired.set(messageId, null);
      this.#orphans.push({ messageId, kind, text });
      return [];
    }
    const { id: attemptId, blocks } = attempt;
    const block = matchBlock(attempt, kind, text);
    if (block === undefined) return [];
    // 取消时 dsh 丢掉只含空白的块，它们排在匹配块前面时一并替换掉。
    const replaced = blocks
      .slice(0, blocks.indexOf(block))
      .filter((b) => !b.replaced && b.kind === kind && b.text.trim() === '');
    replaced.push(block);
    for (const b of replaced) b.replaced = true;
    return replaced.map((b) => ({ attemptId, blockIndex: b.index }));
  }

  /** 回合结束：清空，记下本回合的 attemptId 以丢弃迟到的帧。 */
  reset(): void {
    this.#retired = new Set(this.#attempts.keys());
    this.#attempts = new Map();
    this.#waiting = [];
    this.#orphans = [];
    this.#paired = new Map();
  }
}

/** attempt 里第一个没被替换、同类、且文本是 `text` 前缀的块。 */
function matchBlock(attempt: Attempt, kind: BlockKind, text: string): Block | undefined {
  return attempt.blocks.find((b) => !b.replaced && b.kind === kind && text.startsWith(b.text));
}
