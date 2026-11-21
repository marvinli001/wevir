import { setTimeout as delay } from 'node:timers/promises';
import { newMessageId } from './message-id.js';
import type {
  AssistantMessage,
  Event,
  NativeCommandInput,
  OpenCodeClient,
  OpenCodeConnectInput,
  PermissionRuleset,
  PromptInput,
  ProviderAuthAuthorization,
  ProviderAuthMethod,
  ProviderListResponse,
  QuestionAnswer,
  Session,
  SyncPromptInput,
} from './sdk.js';
import { SSE_MAX_RETRY_ATTEMPTS } from './sdk.js';
import { OpenCodeV2Events, v2Form, v2Message, v2Session } from './v2-events.js';

const REQUEST_TIMEOUT_MS = 20_000;
const ACTIVATION_TIMEOUT_MS = 90_000;
const SSE_SILENCE_MS = 45_000;
const MAX_SSE_FRAME_SIZE = 16 * 1024 * 1024;
const INSTRUCTIONS_KEY = 'wevir.system';

type FormAnswer = Record<string, string | string[]>;
type PromptParts = PromptInput['parts'];
type Model = NonNullable<PromptInput['model']>;
type IntegrationMethod =
  | { type: 'oauth'; id: string; label: string; form?: IntegrationField[] }
  | { type: 'key'; label?: string }
  | { type: 'command' | 'env' | 'external' };
interface IntegrationField {
  type: string;
  key: string;
  title?: string;
  description?: string;
  default?: string;
  options?: Array<{ value: string; label?: string; description?: string }>;
  when?: Array<{ key: string; op: 'eq' | 'neq'; value: string }>;
}
interface Integration {
  id: string;
  methods: IntegrationMethod[];
  connections: Array<{ type: 'credential'; id: string } | { type: 'env' }>;
}
interface NativeProvider {
  id: string;
  name: string;
  integrationID?: string;
}
interface NativeModel {
  id: string;
  providerID: string;
  name: string;
  family?: string;
  status: 'alpha' | 'beta' | 'deprecated' | 'active';
  enabled: boolean;
  limit: { context: number; input?: number; output: number };
  capabilities: { input: string[]; output: string[]; tools: boolean; temperature?: boolean };
  variants: Array<{ id: string }>;
}
interface NativeAttempt {
  attemptID: string;
  url: string;
  instructions: string;
  mode: 'auto' | 'code';
}
interface NativeUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export type OpenCodeV2McpConfig =
  | { type: 'local'; command: string[]; cwd?: string; environment?: Record<string, string> }
  | { type: 'remote'; url: string; headers?: Record<string, string>; oauth?: false };

export interface OpenCodeV2McpServer {
  name: string;
  integrationID?: string;
  status: {
    status: 'connected' | 'pending' | 'disabled' | 'failed' | 'needs_auth';
    error?: string;
  };
}

export interface OpenCodeV2Client extends OpenCodeClient {
  readonly generation: 2;
  listMcp(signal?: AbortSignal): Promise<OpenCodeV2McpServer[]>;
  addMcp(name: string, config: OpenCodeV2McpConfig, signal?: AbortSignal): Promise<void>;
  removeMcp(name: string, signal?: AbortSignal): Promise<void>;
  connectMcp(name: string, signal?: AbortSignal): Promise<void>;
  disconnectMcp(name: string, signal?: AbortSignal): Promise<void>;
  authorizeMcp(name: string, signal?: AbortSignal): Promise<ProviderAuthAuthorization>;
  completeMcp(name: string, code?: string, signal?: AbortSignal): Promise<boolean>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    detail?: string,
    readonly cold = false,
  ) {
    super(detail ?? `OpenCode 2 ${path} returned HTTP ${status}`);
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function permissionRules(rules: PermissionRuleset) {
  return rules.map(({ permission, pattern, action }) => ({
    action: permission === 'bash' ? 'shell' : permission === 'task' ? 'subagent' : permission,
    resource: pattern,
    effect: action,
  }));
}

function modelRef(model: Model, variant?: string) {
  return { id: model.modelID, providerID: model.providerID, variant };
}

function promptText(parts: PromptParts): string {
  return parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function promptFiles(parts: PromptParts) {
  return parts.flatMap((part) =>
    part.type === 'file' ? [{ uri: part.url, name: part.filename }] : [],
  );
}

function nativeProviderModel(
  model: NativeModel,
): ProviderListResponse['all'][number]['models'][string] {
  const capabilities = (values: readonly string[]) => ({
    text: values.includes('text'),
    image: values.includes('image'),
    audio: values.includes('audio'),
    video: values.includes('video'),
    pdf: values.includes('pdf'),
  });
  return {
    id: model.id,
    providerID: model.providerID,
    api: { id: model.id, url: '', npm: '' },
    name: model.name,
    ...(model.family !== undefined && { family: model.family }),
    capabilities: {
      temperature: model.capabilities.temperature === true,
      reasoning: model.variants.length > 0,
      attachment: model.capabilities.input.some((type) => type !== 'text'),
      toolcall: model.capabilities.tools,
      input: capabilities(model.capabilities.input),
      output: capabilities(model.capabilities.output),
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: model.limit,
    status: model.status,
    variants: Object.fromEntries(model.variants.map(({ id }) => [id, {}])),
    options: {},
    headers: {},
    release_date: '',
  };
}

function authMethods(integration: Integration | undefined) {
  return (integration?.methods ?? []).filter(
    (method): method is Extract<IntegrationMethod, { type: 'oauth' | 'key' }> =>
      method.type === 'oauth' || method.type === 'key',
  );
}

function authMethod(method: ReturnType<typeof authMethods>[number]): ProviderAuthMethod {
  if (method.type === 'key') return { type: 'api', label: method.label ?? 'API key' };
  const prompts = method.form?.flatMap((field): NonNullable<ProviderAuthMethod['prompts']> => {
    if (field.type !== 'string') return [];
    const base = {
      key: field.key,
      message: field.description ?? field.title ?? field.key,
      ...(field.when?.length === 1 && field.when[0] !== undefined && { when: field.when[0] }),
    };
    if (field.options?.length) {
      return [
        {
          ...base,
          type: 'select',
          options: field.options.map(({ value, label, description }) => ({
            value,
            label: label ?? value,
            ...(description !== undefined && { hint: description }),
          })),
        },
      ];
    }
    return [
      { ...base, type: 'text', ...(field.default !== undefined && { placeholder: field.default }) },
    ];
  });
  return { type: 'oauth', label: method.label, ...(prompts?.length && { prompts }) };
}

function sessionPath(sessionID: string, suffix = ''): string {
  return `/api/session/${encodeURIComponent(sessionID)}${suffix}`;
}

function integrationPath(integrationID: string): string {
  return `/api/integration/${encodeURIComponent(integrationID)}`;
}

function mcpPath(name: string): string {
  return `/api/experimental/mcp/${encodeURIComponent(name)}`;
}

function assistantMessage(
  sessionID: string,
  parentID = '',
  model?: Model,
  tokens?: NativeUsage,
  cost = 0,
): AssistantMessage {
  return {
    id: newMessageId(),
    sessionID,
    parentID,
    role: 'assistant',
    time: { created: Date.now(), completed: Date.now() },
    providerID: model?.providerID ?? '',
    modelID: model?.modelID ?? '',
    mode: 'build',
    agent: 'build',
    path: { cwd: '', root: '' },
    cost,
    tokens: {
      input: tokens?.input ?? 0,
      output: tokens?.output ?? 0,
      reasoning: tokens?.reasoning ?? 0,
      cache: { read: tokens?.cache?.read ?? 0, write: tokens?.cache?.write ?? 0 },
    },
  };
}

async function* sseFrames(
  body: ReadableStream<Uint8Array>,
  activity: () => void,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let frameSize = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      activity();
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).replace(/\r$/u, '');
        buffer = buffer.slice(lineEnd + 1);
        if (line === '') {
          if (data.length > 0) {
            let frame: unknown;
            try {
              frame = JSON.parse(data.join('\n'));
            } catch {
              // Unknown or malformed events must not discard later frames.
            }
            data = [];
            frameSize = 0;
            if (frame !== undefined) yield frame;
          }
        } else if (line.startsWith('data:')) {
          frameSize += line.length;
          if (frameSize > MAX_SSE_FRAME_SIZE) throw new Error('OpenCode 2 event is too large');
          data.push(line.slice(5).replace(/^ /u, ''));
        }
      }
      if (buffer.length + frameSize > MAX_SSE_FRAME_SIZE)
        throw new Error('OpenCode 2 event is too large');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createOpenCodeV2Client(input: OpenCodeConnectInput): OpenCodeV2Client {
  const { baseUrl, directory, password } = input;
  if (!password) throw new Error('OpenCode 2 requires a server password');
  const authorization = `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
  const location = { 'location[directory]': directory };
  const ownedSessions = new Set<string>();
  const selectedModels = new Map<string, string>();
  const instructions = new Map<string, string>();
  const approvals = new Map<string, string>();
  const forms = new Map<
    string,
    { sessionID: string; answer(answers: QuestionAnswer[]): FormAnswer }
  >();
  const attempts = new Map<string, { path: string; mode: NativeAttempt['mode'] }>();
  const commands = new Map<string, { id: string; nativeID?: string }>();
  const submitted = new Map<string, Set<string>>();
  let workspaceModelsReady = false;

  function url(path: string, query?: Record<string, string | undefined>): URL {
    const target = new URL(`${baseUrl.replace(/\/$/u, '')}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    return target;
  }

  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | undefined>;
      signal?: AbortSignal;
      timeout?: number;
      privateBody?: boolean;
    } = {},
  ): Promise<T> {
    const {
      method = 'GET',
      body,
      query,
      signal,
      timeout = REQUEST_TIMEOUT_MS,
      privateBody,
    } = options;
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetch(url(path, query), {
      method,
      redirect: 'error',
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    });
    if (!response.ok) {
      const detail = object(await response.json().catch(() => undefined));
      const message = detail?.message ?? object(detail?.data)?.message;
      throw new HttpError(
        response.status,
        path,
        !privateBody && typeof message === 'string' ? message : undefined,
        response.status === 503 && detail?.service === 'plugin',
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function data<T>(path: string, options?: Parameters<typeof request>[1]): Promise<T> {
    const response = await request<{ data: T }>(path, options);
    if (response?.data === undefined) throw new Error(`OpenCode 2 ${path} returned no data`);
    return response.data;
  }

  async function catalog<T>(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(ACTIVATION_TIMEOUT_MS);
    const waiting = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    for (;;) {
      try {
        return await data<T>(path, { query, signal: waiting });
      } catch (error) {
        if (!(error instanceof HttpError && error.cold)) throw error;
        await delay(500, undefined, { signal: waiting });
      }
    }
  }

  async function list<T>(
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const entries: T[] = [];
    const visited = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await request<{ data: T[]; cursor?: { next?: string | null } }>(path, {
        query: { ...query, limit: '100', cursor },
        signal,
      });
      entries.push(...page.data);
      cursor = page.cursor?.next || undefined;
      if (cursor !== undefined) {
        if (visited.has(cursor)) throw new Error(`OpenCode 2 ${path} repeated a history cursor`);
        visited.add(cursor);
      }
    } while (cursor !== undefined);
    return entries;
  }

  function rememberSession(value: unknown): Session {
    const session = v2Session(value);
    if (session === undefined) throw new Error('OpenCode 2 returned an invalid session');
    ownedSessions.add(session.id);
    return session;
  }

  async function getSession(sessionID: string): Promise<Session> {
    return rememberSession(await data(sessionPath(sessionID)));
  }

  function providerList(signal?: AbortSignal) {
    return catalog<NativeProvider[]>('/api/provider', location, signal);
  }

  async function modelList(signal?: AbortSignal) {
    const models = await catalog<NativeModel[]>(
      '/api/model',
      { ...location, types: 'chat' },
      signal,
    );
    workspaceModelsReady = true;
    return models;
  }

  async function integrationFor(providerID: string, signal?: AbortSignal) {
    const provider = (await providerList(signal)).find(({ id }) => id === providerID);
    if (provider?.integrationID === undefined)
      throw new Error(`OpenCode 2 has no connection for ${providerID}`);
    return data<Integration>(integrationPath(provider.integrationID), { query: location, signal });
  }

  async function startOAuth(
    key: string,
    integrationID: string,
    methodID: string,
    answer?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<ProviderAuthAuthorization> {
    const path = `${integrationPath(integrationID)}/connect/oauth`;
    const attempt = await data<NativeAttempt>(path, {
      method: 'POST',
      query: location,
      body: { methodID, answer },
      signal,
      privateBody: true,
    });
    attempts.set(key, {
      path: `${path}/${encodeURIComponent(attempt.attemptID)}`,
      mode: attempt.mode,
    });
    return { url: attempt.url, method: attempt.mode, instructions: attempt.instructions };
  }

  async function finishOAuth(key: string, code?: string, signal?: AbortSignal): Promise<boolean> {
    const attempt = attempts.get(key);
    if (attempt === undefined) throw new Error('OpenCode 2 has no active authorization attempt');
    try {
      if (code !== undefined || attempt.mode === 'code') {
        if (!code) throw new Error('An authorization code is required');
        await request(`${attempt.path}/complete`, {
          method: 'POST',
          query: location,
          body: { code },
          signal,
          privateBody: true,
        });
        if (attempt.mode === 'code') return true;
      }
      const lifetime = AbortSignal.timeout(10 * 60_000);
      const waiting = signal === undefined ? lifetime : AbortSignal.any([signal, lifetime]);
      for (;;) {
        const status = await data<{
          status: 'pending' | 'complete' | 'failed' | 'expired';
          message?: string;
        }>(attempt.path, { query: location, signal: waiting });
        if (status.status === 'complete') return true;
        if (status.status === 'failed')
          throw new Error(status.message ?? 'OpenCode 2 authorization failed');
        if (status.status === 'expired') return false;
        await delay(500, undefined, { signal: waiting });
      }
    } finally {
      if (attempts.get(key) === attempt) attempts.delete(key);
      await request(attempt.path, { method: 'DELETE', query: location, timeout: 1_000 }).catch(
        () => {},
      );
    }
  }

  async function listMcp(signal?: AbortSignal): Promise<OpenCodeV2McpServer[]> {
    return data<OpenCodeV2McpServer[]>('/api/mcp', { query: location, signal });
  }

  async function preparePrompt(
    sessionID: string,
    model: Model | undefined,
    variant: string | undefined,
    system: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await Promise.all([
      (async () => {
        if (model === undefined) return;
        if (!workspaceModelsReady) await modelList(signal);
        const ref = modelRef(model, variant);
        const key = JSON.stringify(ref);
        if (selectedModels.get(sessionID) === key) return;
        await request(sessionPath(sessionID, '/model'), {
          method: 'POST',
          body: { model: ref },
          signal,
        });
        selectedModels.set(sessionID, key);
      })(),
      (async () => {
        if (instructions.get(sessionID) === (system ?? '')) return;
        await request(
          `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${INSTRUCTIONS_KEY}`,
          {
            method: system ? 'PUT' : 'DELETE',
            ...(system && { body: { value: system } }),
            signal,
          },
        );
        instructions.set(sessionID, system ?? '');
      })(),
    ]);
  }

  async function messages(sessionID: string, signal?: AbortSignal) {
    const rows = await list<unknown>(sessionPath(sessionID, '/message'), { order: 'asc' }, signal);
    let parentID: string | undefined;
    return rows.flatMap((row) => {
      const message = v2Message(row, sessionID, parentID);
      if (message === undefined) return [];
      if (message.info.role === 'user') parentID = message.info.id;
      return [message];
    });
  }

  async function lastAssistant(sessionID: string, signal: AbortSignal, parentID?: string) {
    const rows = await data<unknown[]>(sessionPath(sessionID, '/message'), {
      query: { order: 'desc', limit: '1', type: 'assistant' },
      signal,
    });
    const message = v2Message(rows[0], sessionID, parentID);
    return message?.info.role === 'assistant'
      ? { info: message.info, parts: message.parts }
      : undefined;
  }

  async function answerForm(requestID: string, answers?: QuestionAnswer[]): Promise<void> {
    const form = forms.get(requestID);
    if (form === undefined)
      throw new HttpError(404, '/form', 'OpenCode 2 question is no longer pending');
    const path = sessionPath(form.sessionID, `/form/${encodeURIComponent(requestID)}`);
    if (answers === undefined) await request(path, { method: 'DELETE' });
    else await request(`${path}/reply`, { method: 'POST', body: { answer: form.answer(answers) } });
    forms.delete(requestID);
  }

  function normalizeFrame(value: unknown, mapper: OpenCodeV2Events): Event[] {
    const event = object(value);
    const details = object(event?.data);
    const target = object(details?.form ?? details?.request);
    const sessionID = details?.sessionID ?? target?.sessionID;
    if (typeof sessionID === 'string' && !ownedSessions.has(sessionID)) {
      if (
        event?.type === 'session.created' &&
        typeof details?.parentID === 'string' &&
        ownedSessions.has(details.parentID)
      ) {
        ownedSessions.add(sessionID);
      } else if (object(event?.location)?.directory !== directory) {
        return [];
      }
    }
    if (event?.type === 'form.created') {
      const form = v2Form(details?.form);
      if (form !== undefined) {
        if ('unsupported' in form) {
          if (ownedSessions.has(form.sessionID)) {
            void request(sessionPath(form.sessionID, `/form/${encodeURIComponent(form.id)}`), {
              method: 'DELETE',
            }).catch(() => {});
          }
        } else {
          forms.set(form.id, form);
        }
      }
    }
    const result = mapper.translate(value);
    for (const mapped of result) {
      if (mapped.type === 'permission.asked') {
        approvals.set(mapped.properties.id, mapped.properties.sessionID);
      } else if (mapped.type === 'permission.replied') {
        approvals.delete(mapped.properties.requestID);
      } else if (mapped.type === 'question.replied' || mapped.type === 'question.rejected') {
        forms.delete(mapped.properties.requestID);
      } else if (mapped.type === 'message.updated') {
        const { info } = mapped.properties;
        const command = commands.get(info.sessionID);
        if (info.role === 'user') {
          if (submitted.get(info.sessionID)?.delete(info.id)) continue;
          if (command !== undefined && command.nativeID === undefined) command.nativeID = info.id;
          if (command?.nativeID === info.id) info.id = command.id;
        } else if (command !== undefined && info.parentID === command.nativeID) {
          info.parentID = command.id;
        }
      } else if (mapped.type === 'message.part.updated') {
        const { part } = mapped.properties;
        const command = commands.get(part.sessionID);
        if (command?.nativeID === part.messageID) part.messageID = command.id;
      } else if (mapped.type === 'session.deleted') {
        const { info } = mapped.properties;
        ownedSessions.delete(info.id);
        instructions.delete(info.id);
        selectedModels.delete(info.id);
        submitted.delete(info.id);
      }
    }
    return result;
  }

  async function* stream(signal: AbortSignal): AsyncGenerator<Event> {
    const mapper = new OpenCodeV2Events();
    let failure: unknown;
    for (let attempt = 0; attempt < SSE_MAX_RETRY_ATTEMPTS && !signal.aborted; attempt += 1) {
      const connection = new AbortController();
      const connectionSignal = AbortSignal.any([signal, connection.signal]);
      const idle = setTimeout(
        () => connection.abort(new Error('OpenCode 2 event stream went silent')),
        SSE_SILENCE_MS,
      );
      idle.unref();
      try {
        const response = await fetch(url('/api/event'), {
          signal: connectionSignal,
          redirect: 'error',
          headers: { Authorization: authorization, Accept: 'text/event-stream' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpError(response.status, '/api/event');
        }
        if (
          !response.body ||
          !response.headers.get('content-type')?.startsWith('text/event-stream')
        ) {
          await response.body?.cancel();
          throw new Error('OpenCode 2 returned an invalid event stream');
        }
        for await (const frame of sseFrames(response.body, () => idle.refresh())) {
          yield* normalizeFrame(frame, mapper);
        }
        failure = undefined;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof HttpError && (error.status === 401 || error.status === 403))
          throw error;
        failure = error;
      } finally {
        clearTimeout(idle);
        connection.abort();
      }
      if (attempt + 1 < SSE_MAX_RETRY_ATTEMPTS) {
        await delay(250 * (attempt + 1), undefined, { signal }).catch(() => {});
      }
    }
    if (!signal.aborted && failure !== undefined) throw failure;
  }

  return {
    generation: 2,
    health: async (signal) => {
      const info = await request<{ version?: unknown; pid?: unknown }>('/api/info', { signal });
      if (
        typeof info.version !== 'string' ||
        typeof info.pid !== 'number' ||
        !Number.isInteger(info.pid) ||
        info.pid <= 0
      ) {
        throw new Error('OpenCode 2 returned invalid server information');
      }
      return { healthy: true, version: info.version };
    },
    providers: async (signal) => {
      const [providers, models, preferred] = await Promise.all([
        providerList(signal),
        modelList(signal),
        catalog<NativeModel | null>('/api/model/default', location, signal).catch(() => null),
      ]);
      const all = new Map<string, ProviderListResponse['all'][number]>();
      for (const { id, name } of providers) {
        all.set(id, { id, name, source: 'config', env: [], models: {}, options: {} });
      }
      const connected = new Set<string>();
      if (preferred !== null) connected.add(preferred.providerID);
      const defaults = new Map<string, string>();
      for (const model of models) {
        if (!model.enabled) continue;
        let provider = all.get(model.providerID);
        if (provider === undefined) {
          provider = {
            id: model.providerID,
            name: model.providerID,
            source: 'config',
            env: [],
            models: {},
            options: {},
          };
          all.set(model.providerID, provider);
        }
        Object.defineProperty(provider.models, model.id, {
          value: nativeProviderModel(model),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        connected.add(provider.id);
        if (!defaults.has(provider.id)) defaults.set(provider.id, model.id);
      }
      if (preferred !== null) defaults.set(preferred.providerID, preferred.id);
      return {
        all: [...all.values()],
        connected: [...connected].filter((id) => defaults.has(id)),
        default: Object.fromEntries(defaults),
      };
    },
    providerAuth: async (signal) => {
      const [providers, integrations] = await Promise.all([
        providerList(signal),
        catalog<Integration[]>('/api/integration', location, signal),
      ]);
      const byID = new Map(integrations.map((integration) => [integration.id, integration]));
      return Object.fromEntries(
        providers.map(({ id, integrationID }) => [
          id,
          authMethods(integrationID === undefined ? undefined : byID.get(integrationID)).map(
            authMethod,
          ),
        ]),
      );
    },
    oauthAuthorize: async ({ providerID, method, inputs }, signal) => {
      const integration = await integrationFor(providerID, signal);
      const option = authMethods(integration)[method];
      if (option?.type !== 'oauth')
        throw new Error(`OpenCode 2 has no OAuth method ${method} for ${providerID}`);
      return startOAuth(`provider:${providerID}`, integration.id, option.id, inputs, signal);
    },
    oauthCallback: ({ providerID, code }, signal) =>
      finishOAuth(`provider:${providerID}`, code, signal),
    setApiKey: async (providerID, key) => {
      const integration = await integrationFor(providerID);
      await request(`${integrationPath(integration.id)}/connect/key`, {
        method: 'POST',
        query: location,
        body: { key },
        privateBody: true,
      });
    },
    removeAuth: async (providerID) => {
      const { connections } = await integrationFor(providerID);
      const credentials = connections.filter((connection) => connection.type === 'credential');
      if (credentials.length > 1) {
        throw new Error(
          'Multiple credentials are saved. Run opencode auth logout with this OpenCode profile to choose one.',
        );
      }
      const credential = credentials[0];
      if (credential !== undefined) {
        await request(`/api/credential/${encodeURIComponent(credential.id)}`, { method: 'DELETE' });
      }
    },
    createSession: async ({ permission, title }) =>
      rememberSession(
        await data('/api/session', {
          method: 'POST',
          body: { location: { directory }, permissions: permissionRules(permission), title },
        }),
      ),
    getSession,
    deleteSession: async (sessionID) => {
      await request(sessionPath(sessionID), { method: 'DELETE' });
      ownedSessions.delete(sessionID);
      instructions.delete(sessionID);
      selectedModels.delete(sessionID);
      submitted.delete(sessionID);
    },
    forkSession: async (sessionID, messageID) => {
      const command = commands.get(sessionID);
      if (command !== undefined && command.id === messageID && command.nativeID === undefined) {
        throw new Error('OpenCode 2 has not yet admitted the native command');
      }
      const before =
        command !== undefined && command.id === messageID ? command.nativeID : messageID;
      return rememberSession(
        await data(sessionPath(sessionID, '/fork'), {
          method: 'POST',
          body: { before },
        }),
      );
    },
    updateSession: async (sessionID, { permission }) => {
      await request(sessionPath(sessionID), {
        method: 'PATCH',
        body: { permissions: permissionRules(permission) },
      });
      return getSession(sessionID);
    },
    children: async (sessionID) =>
      (await list<unknown>('/api/session', { parentID: sessionID })).map(rememberSession),
    messages,
    status: async (signal?: AbortSignal) => {
      const active = await data<Record<string, unknown>>('/api/session/active', {
        signal,
        timeout: 5_000,
      });
      return Object.fromEntries(Object.keys(active).map((id) => [id, { type: 'busy' as const }]));
    },
    skills: async (signal) =>
      (
        await data<Array<{ name: string; description?: string }>>('/api/skill', {
          query: location,
          signal,
        })
      ).map(({ name, description }) => ({
        name,
        ...(description !== undefined && { description }),
      })),
    commands: async (signal) =>
      (
        await data<Array<{ name: string; description?: string }>>('/api/command', {
          query: location,
          signal,
        })
      ).map((command) => ({ ...command, template: '', hints: [] })),
    command: async (command: NativeCommandInput, signal) => {
      const { sessionID, messageID, model, variant, parts } = command;
      const separator = model.indexOf('/');
      const state: { id: string; nativeID?: string } = { id: messageID };
      const previous = await lastAssistant(sessionID, signal);
      commands.set(sessionID, state);
      try {
        await preparePrompt(
          sessionID,
          { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) },
          variant,
          command.system,
          signal,
        );
        if (command.command === 'compact') {
          await request(sessionPath(sessionID, '/compact'), {
            method: 'POST',
            body: { id: messageID },
            signal,
          });
        } else {
          await request(sessionPath(sessionID, '/command'), {
            method: 'POST',
            body: { name: command.command, text: command.arguments, files: promptFiles(parts) },
            signal,
          });
        }
        await request(`/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {
          method: 'POST',
          signal,
          timeout: 60 * 60_000,
        });
        const latest = await lastAssistant(sessionID, signal, messageID);
        return latest !== undefined && latest.info.id !== previous?.info.id
          ? latest
          : { info: assistantMessage(sessionID, messageID), parts: [] };
      } finally {
        if (commands.get(sessionID) === state) commands.delete(sessionID);
      }
    },
    promptAsync: async ({ sessionID, messageID, model, variant, system, parts }, signal) => {
      await preparePrompt(sessionID, model, variant, system, signal);
      const ids = submitted.get(sessionID) ?? new Set<string>();
      ids.add(messageID);
      submitted.set(sessionID, ids);
      try {
        await request(sessionPath(sessionID, '/prompt'), {
          method: 'POST',
          body: { id: messageID, text: promptText(parts), files: promptFiles(parts) },
          signal,
        });
      } catch (error) {
        ids.delete(messageID);
        throw error;
      }
    },
    prompt: async (
      { sessionID, messageID, model, variant, system, format, noReply, parts }: SyncPromptInput,
      signal,
    ) => {
      const text = promptText(parts);
      if (noReply) {
        const id = messageID ?? newMessageId();
        await request(sessionPath(sessionID, '/synthetic'), {
          method: 'POST',
          body: { id, text, resume: false },
          signal,
        });
        return {
          info: {
            id,
            sessionID,
            role: 'user',
            time: { created: Date.now() },
            agent: 'build',
            model: model ?? { providerID: '', modelID: '' },
          },
          parts: [
            { type: 'text', id: `${id}:text`, sessionID, messageID: id, text, synthetic: true },
          ],
        };
      }
      await preparePrompt(sessionID, model, variant, undefined, signal);
      const prompt = [
        system,
        format?.type === 'json_schema'
          ? `Return only JSON conforming to this schema: ${JSON.stringify(format.schema)}`
          : undefined,
        text,
      ]
        .filter(Boolean)
        .join('\n\n');
      const result = await data<{ text: string; tokens?: NativeUsage; cost?: number }>(
        sessionPath(sessionID, '/generate'),
        { method: 'POST', body: { prompt }, signal, timeout: 120_000 },
      );
      const info = assistantMessage(sessionID, messageID, model, result.tokens, result.cost);
      return {
        info,
        parts: [
          { type: 'text', id: `${info.id}:text`, sessionID, messageID: info.id, text: result.text },
        ],
      };
    },
    deleteMessage: async (sessionID, messageID) => {
      await request(sessionPath(sessionID, `/inbox/${encodeURIComponent(messageID)}`), {
        method: 'DELETE',
      });
      submitted.get(sessionID)?.delete(messageID);
    },
    abort: async (sessionID) => {
      await request(sessionPath(sessionID, '/interrupt'), {
        method: 'POST',
        query: { resume: 'false' },
      });
    },
    replyPermission: async (requestID, reply, message) => {
      let sessionID = approvals.get(requestID);
      if (sessionID === undefined) {
        const pending = await data<Array<{ id: string; sessionID: string }>>(
          '/api/permission/request',
          { query: location },
        );
        sessionID = pending.find(
          ({ id, sessionID }) => id === requestID && ownedSessions.has(sessionID),
        )?.sessionID;
      }
      if (sessionID === undefined)
        throw new HttpError(404, '/permission', 'OpenCode 2 permission is no longer pending');
      await request(sessionPath(sessionID, `/permission/${encodeURIComponent(requestID)}/reply`), {
        method: 'POST',
        body: { decision: reply === 'always' ? 'once' : reply, message },
      });
      approvals.delete(requestID);
    },
    replyQuestion: (requestID, answers) => answerForm(requestID, answers),
    rejectQuestion: (requestID) => answerForm(requestID),
    subscribe: async (signal) => stream(signal),
    listMcp,
    addMcp: (name, config, signal) =>
      request(mcpPath(name), {
        method: 'PUT',
        query: location,
        body: { config },
        signal,
        privateBody: true,
      }),
    removeMcp: (name, signal) =>
      request(mcpPath(name), { method: 'DELETE', query: location, signal }),
    connectMcp: (name, signal) =>
      request(`${mcpPath(name)}/connect`, { method: 'POST', query: location, signal }),
    disconnectMcp: (name, signal) =>
      request(`${mcpPath(name)}/disconnect`, { method: 'POST', query: location, signal }),
    authorizeMcp: async (name, signal) => {
      const server = (await listMcp(signal)).find((entry) => entry.name === name);
      if (server?.integrationID === undefined)
        throw new Error(`OpenCode 2 MCP server ${name} has no OAuth integration`);
      const integration = await data<Integration>(integrationPath(server.integrationID), {
        query: location,
        signal,
      });
      const method = integration.methods.find((option) => option.type === 'oauth');
      if (method === undefined)
        throw new Error(`OpenCode 2 MCP server ${name} has no OAuth method`);
      return startOAuth(`mcp:${name}`, integration.id, method.id, undefined, signal);
    },
    completeMcp: (name, code, signal) => finishOAuth(`mcp:${name}`, code, signal),
  };
}
