import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EventPayloadSchemas,
  isKnownEventType,
  WEVIR_EVENT_TYPES,
  type WevirEvent,
  WevirEventEnvelopeSchema,
  WevirEventSchema,
  type WevirEventType,
} from './index.js';
import { eventOf } from './test-samples.js';

// 每加一种事件类型，这里不补分支就编译失败。
function describeEvent(event: WevirEvent): string {
  switch (event.type) {
    case 'session.created':
      return event.payload.cwd;
    case 'session.configured':
      return event.payload.modelId;
    case 'session.handoff':
      return event.payload.to.providerId;
    case 'session.title_changed':
      return event.payload.title;
    case 'session.goal_changed':
      return event.payload.goal?.status ?? 'cleared';
    case 'session.resumed':
      return event.payload.engineVersion ?? '';
    case 'session.read_only':
      return event.payload.reason;
    case 'session.state_changed':
      return `${event.payload.from}->${event.payload.to}`;
    case 'user.message':
      return event.payload.sentBy.clientKind;
    case 'turn.started':
      return event.payload.turnId;
    case 'turn.finished':
      return event.payload.outcome;
    case 'turn.rewound':
      return event.payload.turnId;
    case 'turn.undone':
      return event.payload.turnId;
    case 'turn.redone':
      return event.payload.turnId;
    case 'assistant.delta':
      return event.payload.text;
    case 'assistant.stream_ended':
      return event.payload.outcome;
    case 'assistant.message':
      return event.payload.text;
    case 'assistant.thought':
      return event.payload.text;
    case 'tool.started':
      return event.payload.display.kind;
    case 'tool.updated':
      return event.payload.toolCallId;
    case 'tool.finished':
      return event.payload.status;
    case 'todo.updated':
      return String(event.payload.items.length);
    case 'plan.proposed':
      return event.payload.text;
    case 'plan.delta':
      return event.payload.text;
    case 'approval.requested':
      return event.payload.approval.status;
    case 'approval.resolved':
      return event.payload.resolution.decidedBy?.clientKind ?? event.payload.resolution.reason;
    case 'question.requested':
      return event.payload.question.questions[0]?.question ?? '';
    case 'question.resolved':
      return event.payload.resolution.answeredBy?.clientKind ?? event.payload.resolution.reason;
    case 'usage.updated':
      return String(event.payload.contextUsed);
    case 'context.compacting':
    case 'context.compacted':
      return event.payload.trigger;
    case 'engine.error':
      return event.payload.category;
    case 'engine.raw':
      return event.payload.method;
    case 'subagent.started':
    case 'subagent.updated':
      return event.payload.subagent.status;
    case 'tasks.suggested':
      return event.payload.tasks[0]?.title ?? '';
    case 'tasks.board_updated':
      return event.payload.tasks[0]?.subject ?? '';
    case 'suggestion.updated':
      return event.payload.text;
    case 'task.started':
      return event.payload.sessionId;
    case 'task.reported':
      return event.payload.outcome;
    case 'pending.added':
    case 'pending.updated':
      return event.payload.pending.status;
    case 'user.steered':
      return event.payload.pendingId;
    case 'ui.show':
      return event.payload.target.kind;
    case 'file.shared':
      return event.payload.files[0]?.name ?? '';
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

describe('WevirEvent 判别联合', () => {
  it('联合成员与 payload 表一一对应，没有遗漏或多余', () => {
    const unionTypes = WevirEventSchema.options.flatMap((option) => [...option.shape.type.values]);
    expect([...unionTypes].sort()).toEqual([...WEVIR_EVENT_TYPES].sort());
    expect(new Set(unionTypes).size).toBe(unionTypes.length);
    expect(WEVIR_EVENT_TYPES).toEqual(Object.keys(EventPayloadSchemas));
  });

  it('类型层面也穷尽', () => {
    expectTypeOf<WevirEvent['type']>().toEqualTypeOf<WevirEventType>();
  });

  it('每种事件都能被穷尽的 switch 处理', () => {
    for (const type of WEVIR_EVENT_TYPES) {
      const event = WevirEventSchema.parse(eventOf(type));
      expect(typeof describeEvent(event)).toBe('string');
    }
  });

  it('payload 按 type 校验：类型对不上的 payload 被拒', () => {
    const mismatched = { ...eventOf('turn.started'), payload: eventOf('usage.updated').payload };
    expect(WevirEventSchema.safeParse(mismatched).success).toBe(false);
  });
});

describe('未知事件类型', () => {
  it('信封照常解析，客户端据 isKnownEventType 忽略它', () => {
    const future = { ...eventOf('turn.started', 9), type: 'plan.updated', payload: { steps: [] } };
    const envelope = WevirEventEnvelopeSchema.parse(future);
    expect(envelope.seq).toBe(9);
    expect(isKnownEventType(envelope.type)).toBe(false);
    expect(WevirEventSchema.safeParse(future).success).toBe(false);
  });

  it('isKnownEventType 不认原型链上的键', () => {
    expect(isKnownEventType('toString')).toBe(false);
    expect(isKnownEventType('tool.started')).toBe(true);
  });
});
