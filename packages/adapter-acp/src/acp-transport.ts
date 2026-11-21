import * as v1 from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { AcpProcessOptions } from './acp-process.js';
import {
  v2AgentRequest,
  v2AgentResponse,
  v2InitializeResponse,
  v2Permission,
  v2SessionNotification,
} from './acp-v2-mapping.js';

export interface AcpConnection extends v1.AcpConnection {
  readonly protocolVersion: 1 | 2;
  readonly agent: Pick<v1.ClientContext, 'request' | 'notify'>;
}

type Hooks = Pick<
  AcpProcessOptions,
  | 'engine'
  | 'onSessionUpdate'
  | 'onRequestPermission'
  | 'onElicitation'
  | 'onExtRequest'
  | 'onExtNotification'
>;

const RAW_PARAMS = { parse: (params: unknown) => params };
const CANCELLED = { outcome: { outcome: 'cancelled' } } as const;

export class AcpTransport {
  readonly #abort = new AbortController();
  readonly #wire: v2.Stream;
  readonly #hooks: Hooks;
  connection?: AcpConnection;

  constructor(wire: v2.Stream, hooks: Hooks) {
    this.#wire = wire;
    this.#hooks = hooks;
  }

  close(error: unknown): void {
    this.#abort.abort(error);
    this.connection?.close(error);
  }

  async initialize(
    request: v1.InitializeRequest,
    legacyVersions: readonly number[],
  ): Promise<{ connection: AcpConnection; response: v1.InitializeResponse }> {
    const { signal } = this.#abort;
    const v2Request: v2.InitializeRequest = {
      protocolVersion: v2.PROTOCOL_VERSION,
      info: request.clientInfo ?? { name: 'wevir', version: '0.0.0' },
      capabilities: {
        elicitation: request.clientCapabilities?.elicitation,
        _meta: request.clientCapabilities?._meta,
      },
      _meta: request._meta,
    };
    const buffered: v2.AnyWireMessage[] = [];
    const reader = this.#wire.readable.getReader();
    const writer = this.#wire.writable.getWriter();
    const stop = () => void reader.cancel(signal.reason).catch(() => {});
    signal.addEventListener('abort', stop, { once: true });
    let response: unknown;
    try {
      const exchange = async (id: number, params: unknown) => {
        await writer.write({ jsonrpc: '2.0', id, method: v1.methods.agent.initialize, params });
        for (;;) {
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) throw new Error('ACP 连接在 initialize 完成前关闭');
          if (!Array.isArray(value) && 'id' in value && value.id === id && !('method' in value)) {
            if ('error' in value) {
              const { code, message, data } = value.error;
              throw new v1.RequestError(code, message, data);
            }
            if ('result' in value) return value.result;
          }
          if (buffered.length === 128) throw new Error('ACP 在 initialize 期间发送了过多消息');
          buffered.push(value);
        }
      };
      try {
        response = await exchange(-1, { ...request, ...v2Request });
      } catch (error) {
        if (!(error instanceof v1.RequestError) || ![-32600, -32602, -32022].includes(error.code)) {
          throw error;
        }
        signal.throwIfAborted();
        response = await exchange(-2, request);
      }
    } finally {
      signal.removeEventListener('abort', stop);
      reader.releaseLock();
      writer.releaseLock();
    }

    if (!isRecord(response) || typeof response.protocolVersion !== 'number') {
      throw new Error('ACP initialize 响应缺少协议版本');
    }
    signal.throwIfAborted();
    if (response.protocolVersion === v2.PROTOCOL_VERSION && 'info' in response) {
      return this.#connectV2(v2Request, response, buffered);
    }
    if (!legacyVersions.includes(response.protocolVersion)) {
      throw new Error(`ACP 协议版本 ${response.protocolVersion} 不受支持`);
    }
    const connection = this.#connectV1(buffered);
    this.connection = connection;
    return { connection, response: response as v1.InitializeResponse };
  }

  #connectV1(buffered: v2.AnyWireMessage[]): AcpConnection {
    const hooks = this.#hooks;
    const app = v1
      .client({ name: 'wevir' })
      .onRequest(
        v1.methods.client.session.requestPermission,
        ({ params, signal }) => hooks.onRequestPermission?.(params, signal) ?? CANCELLED,
      );
    if (hooks.onElicitation !== undefined) {
      const onElicitation = hooks.onElicitation;
      app.onRequest(v1.methods.client.elicitation.create, ({ params, signal }) =>
        onElicitation(params, signal),
      );
    }
    const onExtRequest = hooks.onExtRequest;
    if (onExtRequest !== undefined) {
      for (const method of hooks.engine.extensions?.requests ?? []) {
        app.onRequest(method, RAW_PARAMS, ({ params, signal }) =>
          onExtRequest(method, params, signal),
        );
      }
    }
    const connection = app.connect({
      writable: this.#wire.writable,
      readable: this.#input(buffered, hooks.onSessionUpdate) as ReadableStream<v1.AnyMessage>,
    });
    return connectionFacade(connection, 1, connection.agent);
  }

  async #connectV2(
    initialize: v2.InitializeRequest,
    response: unknown,
    buffered: v2.AnyWireMessage[],
  ): Promise<{ connection: AcpConnection; response: v1.InitializeResponse }> {
    const hooks = this.#hooks;
    const turns = new Map<string, V2Turn>();
    const publish = (params: v2.UpdateSessionNotification) => {
      for (const notice of v2SessionNotification(params, turns.get(params.sessionId)?.tools)) {
        hooks.onSessionUpdate?.(notice);
      }
    };
    const app = v2
      .client({ name: 'wevir' })
      .onRequest(
        v2.methods.client.session.requestPermission,
        async ({ params, signal, requestId }) => {
          const permission = v2Permission(params, `permission/${requestId}`);
          if (permission.options.length === 0 || hooks.onRequestPermission === undefined) {
            return CANCELLED;
          }
          const turn = turns.get(params.sessionId);
          const subject = params.subject;
          if (
            turn === undefined ||
            subject == null ||
            !v2.RequestPermissionSubject.isCommand(subject)
          ) {
            return hooks.onRequestPermission(permission, signal);
          }
          publish({
            sessionId: params.sessionId,
            update: { ...permission.toolCall, sessionUpdate: 'tool_call_update' },
          });
          try {
            return await hooks.onRequestPermission(permission, signal);
          } finally {
            if (subject.toolCallId == null && turns.get(params.sessionId) === turn) {
              publish({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: permission.toolCall.toolCallId,
                  status: 'completed',
                },
              });
            }
          }
        },
      );
    if (hooks.onElicitation !== undefined) {
      const onElicitation = hooks.onElicitation;
      app.onRequest(v2.methods.client.elicitation.create, ({ params, signal }) =>
        onElicitation(params as v1.CreateElicitationRequest, signal),
      );
    }
    const onExtRequest = hooks.onExtRequest;
    if (onExtRequest !== undefined) {
      for (const method of hooks.engine.extensions?.requests ?? []) {
        app.onRequest(method, RAW_PARAMS, ({ params, signal }) =>
          onExtRequest(method, params, signal),
        );
      }
    }

    const wire = this.#wire;
    // SDK v2 连接要先看到 initialize 成功。复用刚协商完的线上应答，只在本地交给 SDK 校验。
    const replay = deferred<v2.AnyWireMessage>();
    const connection = app.connect({
      writable: new WritableStream<v2.AnyWireMessage>({
        async write(message) {
          if (
            !Array.isArray(message) &&
            'method' in message &&
            'id' in message &&
            message.method === v2.methods.agent.initialize
          ) {
            replay.resolve({ jsonrpc: '2.0', id: message.id, result: response });
            return;
          }
          const writer = wire.writable.getWriter();
          try {
            await writer.write(message);
          } finally {
            writer.releaseLock();
          }
        },
      }),
      readable: this.#input(
        buffered,
        (params) => {
          if (
            !isRecord(params) ||
            typeof params.sessionId !== 'string' ||
            !isRecord(params.update)
          ) {
            hooks.onSessionUpdate?.(params);
            return;
          }
          const turn = turns.get(params.sessionId);
          const update = params.update;
          try {
            publish(params as v2.UpdateSessionNotification);
          } finally {
            if (update.sessionUpdate === 'state_update' && update.state === 'idle') {
              turn?.completion.resolve(update);
            }
          }
        },
        replay.promise,
      ),
    });
    connection.signal.addEventListener(
      'abort',
      () => {
        for (const { completion } of turns.values()) completion.reject(connection.signal.reason);
      },
      { once: true },
    );
    const facade = connectionFacade(connection, 2, {
      request: async <Response>(
        method: string,
        params?: unknown,
        options?: v2.SendRequestOptions,
      ) => {
        const mapped = v2AgentRequest(method, params);
        if (
          method === v1.methods.agent.session.prompt &&
          isRecord(params) &&
          typeof params.sessionId === 'string'
        ) {
          const sessionId = params.sessionId;
          if (turns.has(sessionId))
            throw v2.RequestError.invalidParams('session already prompting');
          const completion = deferred<Record<string, unknown>>();
          turns.set(sessionId, { completion, tools: new Set() });
          const signal = options?.cancellationSignal;
          const cancel = () => {
            void connection.agent
              .notify(v2.methods.agent.session.cancel, { sessionId })
              .catch(completion.reject);
          };
          try {
            const accepted = connection.agent
              .request(mapped.method, mapped.params, options)
              .then(() => {
                // ACK 之后 prompt 已经入队，剩余的工作由 session/cancel 停止。
                if (turns.get(sessionId)?.completion !== completion) return;
                if (signal?.aborted) cancel();
                else signal?.addEventListener('abort', cancel, { once: true });
              });
            const [, update] = await Promise.all([accepted, completion.promise]);
            return { ...update, stopReason: update.stopReason ?? 'end_turn' } as Response;
          } finally {
            signal?.removeEventListener('abort', cancel);
            turns.delete(sessionId);
          }
        }
        const result = await connection.agent.request(mapped.method, mapped.params, options);
        return v2AgentResponse(method, result) as Response;
      },
      notify: (method: string, params?: unknown) => connection.agent.notify(method, params),
    });
    this.connection = facade;
    const initialized = await connection.agent.request(v2.methods.agent.initialize, initialize);
    return { connection: facade, response: v2InitializeResponse(initialized) };
  }

  #input(
    buffered: v2.AnyWireMessage[],
    onSessionUpdate: Hooks['onSessionUpdate'],
    replay?: Promise<v2.AnyWireMessage>,
  ): ReadableStream<v2.AnyWireMessage> {
    const wire = this.#wire;
    const { onExtNotification, engine } = this.#hooks;
    const extensions = new Set(engine.extensions?.notifications ?? []);
    const read = (async function* () {
      if (replay !== undefined) yield await replay;
      yield* buffered;
      yield* wire.readable;
    })();
    const consume = (message: unknown): boolean => {
      if (!isRecord(message) || 'id' in message || typeof message.method !== 'string') return false;
      const method = message.method;
      if (method !== v1.methods.client.session.update && !extensions.has(method)) return false;
      try {
        if (method === v1.methods.client.session.update) onSessionUpdate?.(message.params);
        else onExtNotification?.(method, message.params);
      } catch {
        // 回调失败不能让 ACP 连接断开。
      }
      return true;
    };
    return new ReadableStream<v2.AnyWireMessage>({
      async pull(controller) {
        const next = await read.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await read.return();
      },
    }).pipeThrough(
      new TransformStream({
        transform(message, controller) {
          if (Array.isArray(message) && replay !== undefined && message.length > 0) {
            const batch = message.filter((entry) => !consume(entry));
            if (batch.length > 0) controller.enqueue(batch as unknown as v2.AnyBatchMessage);
          } else if (!consume(message)) {
            controller.enqueue(message);
          }
        },
      }),
    );
  }
}

interface V2Turn {
  completion: ReturnType<typeof deferred<Record<string, unknown>>>;
  tools: Set<string>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function connectionFacade(
  connection: v1.AcpConnection,
  protocolVersion: 1 | 2,
  agent: AcpConnection['agent'],
): AcpConnection {
  return {
    protocolVersion,
    agent,
    signal: connection.signal,
    closed: connection.closed,
    close: (error) => connection.close(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
