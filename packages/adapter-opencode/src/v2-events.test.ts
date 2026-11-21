import { describe, expect, it } from 'vitest';
import { OpenCodeTurnMapper } from './mapping.js';
import { OpenCodeV2Events, v2Form, v2Message, v2Session } from './v2-events.js';

const sessionID = 'ses_one';
const messageID = 'msg_assistant';
const model = { providerID: 'mock', id: 'model' };
const tokens = { input: 100, output: 40, reasoning: 5, cache: { read: 10, write: 0 } };
const wire = (type: string, data: Record<string, unknown>, created = 1000) => ({
  id: `evt_${type}`,
  type,
  created,
  data: { sessionID, ...data },
});

describe('OpenCode 2 events', () => {
  it('links delivered inputs, streams each block and completes only on the execution terminal', () => {
    const events = new OpenCodeV2Events();
    const mapper = new OpenCodeTurnMapper(sessionID);
    const step = { assistantMessageID: messageID };
    const ingest = (frame: unknown) =>
      events.translate(frame).flatMap((event) => {
        if (event.type === 'message.part.updated') return mapper.part(event.properties.part);
        if (event.type === 'message.part.delta') return mapper.delta(event.properties);
        if (event.type === 'message.updated') return mapper.message(event.properties.info);
        return [];
      });

    expect(events.translate(wire('server.connected', {}))).toMatchObject([
      { type: 'server.connected' },
    ]);
    expect(events.translate(wire('session.execution.started', {}))).toMatchObject([
      { type: 'session.status', properties: { status: { type: 'busy' } } },
    ]);
    expect(
      events.translate(
        wire('session.inbox.enqueued', {
          inboxID: 'msg_user',
          item: { type: 'user', delivery: 'steer', payload: { text: 'Hello' } },
        }),
      ),
    ).toEqual([]);
    expect(
      events.translate(wire('session.inbox.delivered', { inboxID: 'msg_user' })),
    ).toMatchObject([
      { type: 'message.updated', properties: { info: { id: 'msg_user', role: 'user' } } },
      { type: 'message.part.updated', properties: { part: { text: 'Hello' } } },
    ]);
    expect(
      events.translate(
        wire('session.step.started', { ...step, agent: 'build', model, started: 900 }),
      ),
    ).toMatchObject([
      { type: 'message.updated', properties: { info: { parentID: 'msg_user', modelID: 'model' } } },
    ]);
    expect(ingest(wire('session.reasoning.started', { ...step, ordinal: 0 }))).toEqual([]);
    expect(
      ingest(wire('session.reasoning.delta', { ...step, ordinal: 0, delta: 'Thinking' })),
    ).toMatchObject([{ type: 'assistant.delta', kind: 'reasoning', text: 'Thinking' }]);
    expect(
      ingest(wire('session.reasoning.ended', { ...step, ordinal: 0, text: 'Thinking' })),
    ).toMatchObject([
      {
        type: 'assistant.thought',
        text: 'Thinking',
        replaces: [{ attemptId: messageID, blockIndex: 0 }],
      },
    ]);
    expect(
      ingest(wire('session.text.delta', { ...step, ordinal: 0, delta: 'Hello' })),
    ).toMatchObject([{ type: 'assistant.delta', kind: 'text', text: 'Hello' }]);
    expect(
      ingest(wire('session.text.ended', { ...step, ordinal: 0, text: 'Hello!' })),
    ).toMatchObject([
      { type: 'assistant.delta', text: '!' },
      {
        type: 'assistant.message',
        text: 'Hello!',
        replaces: [{ attemptId: messageID, blockIndex: 1 }],
      },
    ]);
    expect(
      ingest(wire('session.step.ended', { ...step, finish: 'stop', cost: 0, tokens }, 1100)),
    ).toMatchObject([
      { type: 'assistant.stream_ended' },
      {
        type: 'usage.recorded',
        model: 'model',
        upstream: 'mock',
        inputTokens: 100,
        outputTokens: 45,
        cacheReadTokens: 10,
      },
    ]);
    expect(events.translate(wire('session.execution.succeeded', {}))).toMatchObject([
      { type: 'session.idle' },
    ]);
  });

  it('maps a tool result and its approval without confusing the two wire identifiers', () => {
    const events = new OpenCodeV2Events();
    const call = { assistantMessageID: messageID, id: 'tool_one' };

    events.translate(wire('session.tool.input.started', { ...call, name: 'shell' }));
    expect(
      events.translate(wire('session.tool.called', { ...call, input: { command: 'pwd' } })),
    ).toMatchObject([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            type: 'tool',
            tool: 'shell',
            callID: 'tool_one',
            state: { status: 'running', input: { command: 'pwd' } },
          },
        },
      },
    ]);
    expect(
      events.translate(
        wire('permission.asked', {
          id: 'perm_one',
          action: 'shell',
          resources: ['pwd'],
          save: ['pwd *'],
          source: { type: 'tool', id: 'tool_one', messageID },
        }),
      ),
    ).toMatchObject([
      {
        type: 'permission.asked',
        properties: {
          id: 'perm_one',
          permission: 'shell',
          patterns: ['pwd'],
          always: ['pwd *'],
          tool: { callID: 'tool_one', messageID },
        },
      },
    ]);
    expect(
      events.translate(wire('permission.replied', { requestID: 'perm_one', reply: 'once' })),
    ).toMatchObject([
      { type: 'permission.replied', properties: { requestID: 'perm_one', reply: 'once' } },
    ]);
    expect(
      events.translate(
        wire('session.tool.success', {
          ...call,
          content: [
            { type: 'text', text: '/workspace' },
            { type: 'text', text: 'next' },
          ],
          metadata: { exit: 1 },
        }),
      ),
    ).toMatchObject([
      {
        type: 'message.part.updated',
        properties: {
          part: {
            callID: 'tool_one',
            state: { status: 'completed', output: '/workspace\nnext', metadata: { exit: 1 } },
          },
        },
      },
    ]);
    expect(
      events.translate(wire('session.execution.interrupted', { reason: 'user' })),
    ).toMatchObject([
      { type: 'session.error', properties: { error: { name: 'MessageAbortedError' } } },
    ]);
    expect(
      events.translate(
        wire('session.execution.failed', {
          error: { type: 'provider.go-limit', message: 'Limited' },
        }),
      ),
    ).toMatchObject([
      {
        type: 'session.error',
        properties: { error: { name: 'APIError', data: { statusCode: 429, message: 'Limited' } } },
      },
    ]);
  });

  it('uses the native form field keys and values when replying to the displayed labels', () => {
    const form = {
      id: 'form_one',
      sessionID,
      title: 'Selection',
      fields: [
        {
          key: 'colour',
          type: 'string',
          title: 'Colour',
          description: 'Pick a colour',
          options: [{ label: 'Red', value: 'red' }],
        },
        {
          key: 'items',
          type: 'multiselect',
          title: 'Items',
          custom: true,
          options: [{ label: 'Apple', value: 'apple' }],
        },
      ],
    };
    const parsed = v2Form(form);
    if (parsed === undefined || 'unsupported' in parsed)
      throw new Error('Expected a supported form');
    expect(parsed.answer([['Red'], ['Apple', 'Kiwi']])).toEqual({
      colour: 'red',
      items: ['apple', 'Kiwi'],
    });
    expect(new OpenCodeV2Events().translate(wire('form.created', { form }))).toMatchObject([
      {
        type: 'question.asked',
        properties: {
          id: 'form_one',
          questions: [
            { header: 'Colour', question: 'Pick a colour', custom: false },
            { header: 'Items', multiple: true, custom: true },
          ],
        },
      },
    ]);
    expect(v2Form({ ...form, fields: [{ key: 'link', type: 'external' }] })).toMatchObject({
      unsupported: true,
    });
  });
});

describe('OpenCode 2 projected history', () => {
  it('maps session hierarchy and message content without leaking it across sessions', () => {
    expect(
      v2Session({
        id: sessionID,
        parentID: 'ses_parent',
        projectID: 'project',
        location: { directory: '/workspace' },
        permissions: [{ action: 'shell', effect: 'ask', resource: '*' }],
      }),
    ).toMatchObject({
      id: sessionID,
      parentID: 'ses_parent',
      directory: '/workspace',
      permission: [{ permission: 'shell', action: 'ask', pattern: '*' }],
    });
    expect(
      v2Message(
        {
          type: 'assistant',
          id: messageID,
          agent: 'build',
          model,
          tokens,
          time: { created: 900, completed: 1100 },
          content: [
            { type: 'reasoning', text: 'Working' },
            { type: 'text', text: 'Answer' },
            {
              type: 'tool',
              id: 'tool_child',
              name: 'subagent',
              state: {
                status: 'completed',
                input: { agent: 'explore' },
                metadata: { sessionID: 'ses_child' },
                content: [{ type: 'text', text: 'Child result' }],
              },
            },
          ],
        },
        sessionID,
        'msg_user',
      ),
    ).toMatchObject({
      info: { id: messageID, sessionID, parentID: 'msg_user', role: 'assistant', tokens },
      parts: [
        { type: 'reasoning', id: `${messageID}:reasoning:0`, text: 'Working' },
        { type: 'text', id: `${messageID}:text:0`, text: 'Answer' },
        {
          type: 'tool',
          tool: 'task',
          state: {
            input: { subagent_type: 'explore' },
            output: 'Child result',
            metadata: { sessionID: 'ses_child' },
          },
        },
      ],
    });
  });
});
