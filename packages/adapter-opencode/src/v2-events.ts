import type { Event, Message, Part, PermissionRuleset, Session } from './sdk.js';

type Fields = Record<string, unknown>;
type AssistantMessage = Extract<Message, { role: 'assistant' }>;
type ToolPart = Extract<Part, { type: 'tool' }>;
type QuestionRequest = Extract<Event, { type: 'question.asked' }>['properties'];

function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string');
}

function permissions(value: unknown): PermissionRuleset {
  return list(value).flatMap((entry) => {
    const rule = fields(entry);
    const permission = string(rule.action);
    const pattern = string(rule.resource);
    const action = rule.effect;
    if (permission === undefined || pattern === undefined) return [];
    if (action !== 'allow' && action !== 'deny' && action !== 'ask') return [];
    return [{ permission, pattern, action }];
  });
}

export function v2Session(value: unknown): Session | undefined {
  const session = fields(value);
  const id = string(session.id) ?? string(session.sessionID);
  if (id === undefined) return undefined;
  const location = fields(session.location);
  const time = fields(session.time);
  const created = number(time.created) ?? number(session.created) ?? 0;
  const archived = number(time.archived);
  const parentID = string(session.parentID);
  const agent = string(session.agent);
  const model = fields(session.model);
  const modelID = string(model.id);
  const providerID = string(model.providerID);
  const variant = string(model.variant);
  return {
    id,
    slug: string(session.slug) ?? id,
    projectID: string(session.projectID) ?? '',
    directory: string(location.directory) ?? '',
    title: string(session.title) ?? '',
    version: string(session.version) ?? '2',
    time: {
      created,
      updated: number(time.updated) ?? created,
      ...(archived !== undefined && { archived }),
    },
    ...(parentID !== undefined && { parentID }),
    ...(agent !== undefined && { agent }),
    ...(modelID !== undefined &&
      providerID !== undefined && {
        model: { id: modelID, providerID, ...(variant !== undefined && { variant }) },
      }),
    ...(session.permissions !== undefined && { permission: permissions(session.permissions) }),
  };
}

function errorOf(value: unknown): NonNullable<AssistantMessage['error']> {
  const error = fields(value);
  const type = string(error.type);
  const message = string(error.message) ?? 'OpenCode session failed';
  if (type === 'aborted') return { name: 'MessageAbortedError', data: { message } };
  if (type === 'provider.auth')
    return { name: 'ProviderAuthError', data: { providerID: '', message } };
  const responseBody = string(fields(error.response).body);
  const statusCode =
    number(error.status) ??
    (type?.startsWith('provider.') === true &&
    (type.endsWith('-limit') || type === 'provider.quota')
      ? 429
      : undefined);
  if (statusCode !== undefined || type?.startsWith('provider.') === true) {
    return {
      name: 'APIError',
      data: {
        message,
        isRetryable: error.retryAfterMs !== undefined,
        ...(statusCode !== undefined && { statusCode }),
        ...(responseBody !== undefined && { responseBody }),
      },
    };
  }
  return { name: 'UnknownError', data: { message } };
}

function tokensOf(value: unknown): AssistantMessage['tokens'] {
  const tokens = fields(value);
  const cache = fields(tokens.cache);
  return {
    input: number(tokens.input) ?? 0,
    output: number(tokens.output) ?? 0,
    reasoning: number(tokens.reasoning) ?? 0,
    cache: { read: number(cache.read) ?? 0, write: number(cache.write) ?? 0 },
  };
}

function assistantInfo(input: {
  sessionID: string;
  id: string;
  parentID: string;
  directory: string;
  data: Fields;
  created: number;
  completed?: number;
}): AssistantMessage {
  const { id, sessionID, parentID, directory, data, created, completed } = input;
  const model = fields(data.model);
  const agent = string(data.agent) ?? '';
  const variant = string(model.variant);
  const finish = string(data.finish);
  return {
    id,
    sessionID,
    role: 'assistant',
    parentID,
    agent,
    mode: agent,
    path: { cwd: directory, root: directory },
    modelID: string(model.id) ?? '',
    providerID: string(model.providerID) ?? '',
    time: { created, ...(completed !== undefined && { completed }) },
    cost: number(data.cost) ?? 0,
    tokens: tokensOf(data.tokens),
    ...(variant !== undefined && { variant }),
    ...(finish !== undefined && { finish }),
    ...(data.error !== undefined && { error: errorOf(data.error) }),
  };
}

function textPart(
  sessionID: string,
  messageID: string,
  kind: 'text' | 'reasoning',
  ordinal: number,
  text: string,
  start: number,
  end?: number,
): Part {
  return {
    id: `${messageID}:${kind}:${ordinal}`,
    sessionID,
    messageID,
    type: kind,
    text,
    time: { start, ...(end !== undefined && { end }) },
  };
}

function filePart(
  sessionID: string,
  messageID: string,
  id: string,
  mime: string,
  url: string,
  filename?: string,
): Extract<Part, { type: 'file' }> {
  return {
    id,
    sessionID,
    messageID,
    type: 'file',
    mime,
    url,
    ...(filename !== undefined && { filename }),
  };
}

function toolPart(
  sessionID: string,
  messageID: string,
  callID: string,
  name: string,
  state: ToolPart['state'],
): ToolPart {
  return {
    id: `${messageID}:tool:${callID}`,
    sessionID,
    messageID,
    type: 'tool',
    callID,
    tool: name === 'subagent' ? 'task' : name,
    state:
      name === 'subagent' && typeof state.input.agent === 'string'
        ? { ...state, input: { ...state.input, subagent_type: state.input.agent } }
        : state,
  };
}

function toolResult(
  sessionID: string,
  messageID: string,
  callID: string,
  name: string,
  input: Fields,
  data: Fields,
  start: number,
  end: number,
): ToolPart {
  const metadata = fields(data.metadata);
  if (data.error !== undefined) {
    return toolPart(sessionID, messageID, callID, name, {
      status: 'error',
      input,
      metadata,
      time: { start, end },
      error: string(data.error) ?? string(fields(data.error).message) ?? 'OpenCode tool failed',
    });
  }
  const output: string[] = [];
  const attachments: Extract<Part, { type: 'file' }>[] = [];
  for (const [index, entry] of list(data.content).entries()) {
    const content = fields(entry);
    if (content.type === 'text' && typeof content.text === 'string') output.push(content.text);
    if (content.type !== 'file') continue;
    const mime = string(content.mime);
    const uri = string(content.uri);
    if (mime === undefined || uri === undefined) continue;
    attachments.push(
      filePart(sessionID, messageID, `${callID}:file:${index}`, mime, uri, string(content.name)),
    );
  }
  return toolPart(sessionID, messageID, callID, name, {
    status: 'completed',
    input,
    metadata,
    title: string(metadata.title) ?? name,
    time: { start, end },
    output: output.join('\n'),
    ...(attachments.length > 0 && { attachments }),
  });
}

export function v2Message(
  value: unknown,
  sessionID: string,
  parentID = '',
): { info: Message; parts: Part[] } | undefined {
  const data = fields(value);
  const id = string(data.id);
  if (id === undefined) return undefined;
  const time = fields(data.time);
  const created = number(time.created) ?? 0;
  if (data.type === 'user') {
    const parts: Part[] = [];
    if (typeof data.text === 'string')
      parts.push(textPart(sessionID, id, 'text', 0, data.text, created, created));
    for (const [index, entry] of list(data.files).entries()) {
      const file = fields(entry);
      const mime = string(file.mime);
      const source = fields(file.source);
      const url =
        source.type === 'uri'
          ? string(source.uri)
          : typeof file.data === 'string' && mime !== undefined
            ? `data:${mime};base64,${file.data}`
            : undefined;
      if (mime !== undefined && url !== undefined)
        parts.push(filePart(sessionID, id, `${id}:file:${index}`, mime, url, string(file.name)));
    }
    return {
      info: {
        id,
        sessionID,
        role: 'user',
        time: { created },
        agent: '',
        model: { modelID: '', providerID: '' },
      },
      parts,
    };
  }
  if (data.type !== 'assistant') return undefined;
  const completed = number(time.completed);
  const parts: Part[] = [];
  const ordinal = { text: 0, reasoning: 0 };
  for (const entry of list(data.content)) {
    const part = fields(entry);
    const time = fields(part.time);
    if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') {
      const kind = part.type;
      parts.push(
        textPart(
          sessionID,
          id,
          kind,
          ordinal[kind]++,
          part.text,
          number(time.created) ?? created,
          number(time.completed) ?? completed,
        ),
      );
    } else if (
      part.type === 'tool' &&
      typeof part.id === 'string' &&
      typeof part.name === 'string'
    ) {
      const state = fields(part.state);
      const input = fields(state.input);
      const start = number(time.ran) ?? number(time.created) ?? created;
      const end = number(time.completed) ?? completed ?? start;
      if (state.status === 'completed' || state.status === 'error') {
        parts.push(toolResult(sessionID, id, part.id, part.name, input, state, start, end));
      } else if (state.status === 'running') {
        parts.push(
          toolPart(sessionID, id, part.id, part.name, {
            status: 'running',
            input,
            time: { start },
            metadata: fields(state.metadata),
          }),
        );
      }
    }
  }
  return {
    info: assistantInfo({
      id,
      sessionID,
      parentID,
      directory: '',
      data,
      created,
      ...(completed !== undefined && { completed }),
    }),
    parts,
  };
}

type FormRequest = {
  id: string;
  sessionID: string;
} & (
  | { unsupported: true }
  | {
      questions: QuestionRequest['questions'];
      answer(answers: string[][]): Record<string, string | string[]>;
    }
);

export function v2Form(value: unknown): FormRequest | undefined {
  const form = fields(value);
  const id = string(form.id);
  const sessionID = string(form.sessionID);
  if (id === undefined || sessionID === undefined) return undefined;
  const raw = list(form.fields).map(fields);
  const questions: QuestionRequest['questions'] = [];
  const mappings: Array<{ key: string; values: Map<string, string>; multiple: boolean }> = [];
  for (const [index, field] of raw.entries()) {
    const key = string(field.key);
    const multiple = field.type === 'multiselect';
    if (
      key === undefined ||
      (!multiple && field.type !== 'string') ||
      field.hidden === true ||
      list(field.when).length > 0
    )
      return { id, sessionID, unsupported: true };
    const header =
      string(field.title)?.trim() || string(form.title)?.trim() || `Question ${index + 1}`;
    const values = new Map<string, string>();
    const options = list(field.options).flatMap((entry) => {
      const option = fields(entry);
      const value = string(option.value);
      if (value === undefined) return [];
      let label = string(option.label)?.trim() || value;
      if (values.has(label)) label = value;
      if (values.has(label)) return [];
      values.set(label, value);
      return [{ label, description: string(option.description) ?? '' }];
    });
    questions.push({
      header,
      question: string(field.description)?.trim() || header,
      options,
      multiple,
      custom: field.custom === true || options.length === 0,
    });
    mappings.push({ key, values, multiple });
  }
  if (questions.length === 0) return { id, sessionID, unsupported: true };
  return {
    id,
    sessionID,
    questions,
    answer: (answers) =>
      Object.fromEntries(
        mappings.flatMap(({ key, values, multiple }, index): Array<[string, string | string[]]> => {
          const selected = (answers[index] ?? [])
            .filter((label) => label.trim() !== '')
            .map((label) => values.get(label) ?? label);
          if (selected.length === 0) return [];
          return [[key, multiple ? selected : selected.join(', ')]];
        }),
      ),
  };
}

interface LiveSession {
  parentID: string;
  inbox: Map<string, Fields>;
  steps: Map<string, AssistantMessage>;
  blocks: Map<string, number>;
  tools: Map<string, { name: string; input: Fields; start: number }>;
}

function updatePart(id: string, part: Part, time: number): Event {
  return {
    id,
    type: 'message.part.updated',
    properties: { sessionID: part.sessionID, part, time },
  };
}

/** Native v2 publishes partial updates. Keep the data needed to build a message or part across events. */
export class OpenCodeV2Events {
  readonly #sessions = new Map<string, LiveSession>();

  translate(value: unknown): Event[] {
    const event = fields(value);
    const type = string(event.type);
    if (type === undefined) return [];
    const id = string(event.id) ?? type;
    const data = fields(event.data);
    const at = number(event.created) ?? 0;
    if (type === 'server.connected') return [{ id, type, properties: {} }];
    if (type === 'form.created') {
      const form = v2Form(data.form);
      return form === undefined || 'unsupported' in form
        ? []
        : [
            {
              id,
              type: 'question.asked',
              properties: { id: form.id, sessionID: form.sessionID, questions: form.questions },
            },
          ];
    }
    const sessionID = string(data.sessionID);
    if (sessionID === undefined) return [];

    switch (type) {
      case 'session.created': {
        const info = v2Session({ ...data, created: at });
        return info === undefined ? [] : [{ id, type, properties: { sessionID, info } }];
      }
      case 'session.deleted':
        this.#sessions.delete(sessionID);
        return [];
      case 'session.inbox.enqueued': {
        const inboxID = string(data.inboxID);
        const item = fields(data.item);
        if (inboxID !== undefined && item.type === 'user') {
          this.#session(sessionID).inbox.set(inboxID, fields(item.payload));
        }
        return [];
      }
      case 'session.inbox.delivered': {
        const inboxID = string(data.inboxID);
        const session = this.#sessions.get(sessionID);
        if (inboxID === undefined || session === undefined) return [];
        const payload = session.inbox.get(inboxID);
        if (payload === undefined) return [];
        session.inbox.delete(inboxID);
        session.parentID = inboxID;
        const message = v2Message(
          { ...payload, type: 'user', id: inboxID, time: { created: at } },
          sessionID,
        );
        return message === undefined
          ? []
          : [
              { id, type: 'message.updated', properties: { sessionID, info: message.info } },
              ...message.parts.map((part) => updatePart(id, part, at)),
            ];
      }
      case 'session.inbox.cancelled': {
        const inboxID = string(data.inboxID);
        if (inboxID !== undefined) this.#sessions.get(sessionID)?.inbox.delete(inboxID);
        return [];
      }
      case 'session.execution.started':
        return [
          { id, type: 'session.status', properties: { sessionID, status: { type: 'busy' } } },
        ];
      case 'session.execution.succeeded':
        this.#finish(sessionID);
        return [{ id, type: 'session.idle', properties: { sessionID } }];
      case 'session.execution.interrupted':
        this.#finish(sessionID);
        return [
          {
            id,
            type: 'session.error',
            properties: {
              sessionID,
              error: {
                name: 'MessageAbortedError',
                data: { message: 'OpenCode execution interrupted' },
              },
            },
          },
        ];
      case 'session.execution.failed':
        this.#finish(sessionID);
        return [
          { id, type: 'session.error', properties: { sessionID, error: errorOf(data.error) } },
        ];
      case 'session.compaction.ended':
        return [{ id, type: 'session.compacted', properties: { sessionID } }];
      case 'permission.asked': {
        const requestID = string(data.id);
        const permission = string(data.action);
        if (requestID === undefined || permission === undefined) return [];
        const source = fields(data.source);
        const callID = string(source.id);
        const messageID = string(source.messageID);
        return [
          {
            id,
            type,
            properties: {
              id: requestID,
              sessionID,
              permission,
              patterns: strings(data.resources),
              always: strings(data.save),
              metadata: fields(data.metadata),
              ...(source.type === 'tool' &&
                callID !== undefined &&
                messageID !== undefined && { tool: { callID, messageID } }),
            },
          },
        ];
      }
      case 'permission.replied': {
        const requestID = string(data.requestID);
        const reply = data.reply;
        if (
          requestID === undefined ||
          (reply !== 'once' && reply !== 'always' && reply !== 'reject')
        )
          return [];
        return [{ id, type, properties: { sessionID, requestID, reply } }];
      }
      case 'form.replied':
      case 'form.cancelled': {
        const requestID = string(data.id);
        if (requestID === undefined) return [];
        return type === 'form.replied'
          ? [{ id, type: 'question.replied', properties: { sessionID, requestID, answers: [] } }]
          : [{ id, type: 'question.rejected', properties: { sessionID, requestID } }];
      }
    }

    const messageID = string(data.assistantMessageID);
    if (messageID === undefined) return [];
    switch (type) {
      case 'session.step.started': {
        const session = this.#session(sessionID);
        const info = assistantInfo({
          id: messageID,
          sessionID,
          parentID: session.parentID,
          directory: string(fields(event.location).directory) ?? '',
          data,
          created: number(data.started) ?? at,
        });
        session.steps.set(messageID, info);
        return [{ id, type: 'message.updated', properties: { sessionID, info } }];
      }
      case 'session.step.ended':
      case 'session.step.failed': {
        const session = this.#sessions.get(sessionID);
        const known = session?.steps.get(messageID);
        const info = {
          ...(known ??
            assistantInfo({
              id: messageID,
              sessionID,
              parentID: session?.parentID ?? '',
              directory: string(fields(event.location).directory) ?? '',
              data,
              created: at,
            })),
          cost: number(data.cost) ?? 0,
          tokens: tokensOf(data.tokens),
          ...(typeof data.finish === 'string' && { finish: data.finish }),
          ...(data.error !== undefined && { error: errorOf(data.error) }),
        };
        session?.steps.delete(messageID);
        info.time = { created: info.time.created, completed: at };
        return [{ id, type: 'message.updated', properties: { sessionID, info } }];
      }
      case 'session.text.started':
      case 'session.text.delta':
      case 'session.text.ended':
      case 'session.reasoning.started':
      case 'session.reasoning.delta':
      case 'session.reasoning.ended': {
        const kind = type.startsWith('session.text.') ? 'text' : 'reasoning';
        const ordinal = number(data.ordinal);
        if (ordinal === undefined) return [];
        const partID = `${messageID}:${kind}:${ordinal}`;
        const blocks = this.#session(sessionID).blocks;
        const start = blocks.get(partID);
        if (type.endsWith('.started')) {
          blocks.set(partID, at);
          return [updatePart(id, textPart(sessionID, messageID, kind, ordinal, '', at), at)];
        }
        if (type.endsWith('.ended')) {
          blocks.delete(partID);
          return typeof data.text === 'string'
            ? [
                updatePart(
                  id,
                  textPart(sessionID, messageID, kind, ordinal, data.text, start ?? at, at),
                  at,
                ),
              ]
            : [];
        }
        if (typeof data.delta !== 'string') return [];
        const delta: Event = {
          id,
          type: 'message.part.delta',
          properties: { sessionID, messageID, partID, field: 'text', delta: data.delta },
        };
        if (start !== undefined) return [delta];
        blocks.set(partID, at);
        return [updatePart(id, textPart(sessionID, messageID, kind, ordinal, '', at), at), delta];
      }
      case 'session.tool.input.started': {
        const callID = string(data.id);
        const name = string(data.name);
        if (callID !== undefined && name !== undefined)
          this.#session(sessionID).tools.set(callID, { name, input: {}, start: at });
        return [];
      }
      case 'session.tool.called':
      case 'session.tool.progress':
      case 'session.tool.success':
      case 'session.tool.failed': {
        const callID = string(data.id);
        if (callID === undefined) return [];
        const tools = this.#sessions.get(sessionID)?.tools;
        const tool = tools?.get(callID);
        if (tool === undefined) return [];
        if (type === 'session.tool.called') {
          tool.input = fields(data.input);
          tool.start = at;
        }
        const part =
          type === 'session.tool.success' || type === 'session.tool.failed'
            ? toolResult(sessionID, messageID, callID, tool.name, tool.input, data, tool.start, at)
            : toolPart(sessionID, messageID, callID, tool.name, {
                status: 'running',
                input: tool.input,
                time: { start: tool.start },
                metadata: fields(data.metadata),
              });
        if (type === 'session.tool.success' || type === 'session.tool.failed')
          tools?.delete(callID);
        return [updatePart(id, part, at)];
      }
      default:
        return [];
    }
  }

  #finish(sessionID: string): void {
    const session = this.#sessions.get(sessionID);
    if (session === undefined) return;
    if (session.inbox.size === 0) {
      this.#sessions.delete(sessionID);
      return;
    }
    session.parentID = '';
    session.steps.clear();
    session.blocks.clear();
    session.tools.clear();
  }

  #session(sessionID: string): LiveSession {
    const current = this.#sessions.get(sessionID);
    if (current !== undefined) return current;
    const session = {
      parentID: '',
      inbox: new Map(),
      steps: new Map(),
      blocks: new Map(),
      tools: new Map(),
    };
    this.#sessions.set(sessionID, session);
    return session;
  }
}
