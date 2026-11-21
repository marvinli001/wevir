import {
  type InitializeResponse,
  methods,
  type PermissionOption,
  type RequestPermissionRequest,
  type ToolCallUpdate,
  type AuthMethod as V1AuthMethod,
} from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';

export function v2InitializeResponse(response: v2.InitializeResponse): InitializeResponse {
  const session = response.capabilities?.session;
  const prompt = session?.prompt;
  const mcp = session?.mcp;
  return {
    protocolVersion: response.protocolVersion,
    agentInfo: response.info,
    agentCapabilities: {
      loadSession: session != null,
      _meta: response.capabilities?._meta,
      promptCapabilities: {
        image: prompt?.image != null,
        audio: prompt?.audio != null,
        embeddedContext: prompt?.embeddedContext != null,
      },
      mcpCapabilities: { http: mcp?.http != null, acp: mcp?.acp != null },
      ...(session != null && {
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
          delete: session.delete ?? null,
          fork: session.fork ?? null,
          additionalDirectories: session.additionalDirectories ?? null,
          _meta: session._meta,
        },
      }),
      ...(response.capabilities?.providers != null && {
        providers: response.capabilities.providers,
      }),
      ...(response.authMethods?.length && { auth: { logout: {} } }),
    },
    authMethods: response.authMethods?.flatMap(authMethod),
    _meta: response._meta,
  };
}

function authMethod(method: v2.AuthMethod): V1AuthMethod[] {
  const base = {
    id: method.methodId,
    name: method.name,
    description: method.description,
    _meta: method._meta,
  };
  if (v2.AuthMethod.isAgent(method)) return [base];
  if (!v2.AuthMethod.isTerminal(method)) return [];
  return [
    {
      ...base,
      type: 'terminal',
      args: method.args,
      env: method.env && Object.fromEntries(method.env.map(({ name, value }) => [name, value])),
    },
  ];
}

export function v2AgentRequest(
  method: string,
  params: unknown,
): { method: string; params: unknown } {
  switch (method) {
    case methods.agent.authenticate:
      return { method: v2.methods.agent.auth.login, params };
    case methods.agent.logout:
      return { method: v2.methods.agent.auth.logout, params };
    case methods.agent.session.load:
      return {
        method: v2.methods.agent.session.resume,
        params: { ...withV2McpServers(params), replayFrom: { type: 'start' } },
      };
    case methods.agent.session.new:
    case methods.agent.session.resume:
    case methods.agent.session.fork:
      return { method, params: withV2McpServers(params) };
    case methods.agent.session.setConfigOption:
      return {
        method,
        params: isRecord(params)
          ? { ...params, type: typeof params.value === 'boolean' ? 'boolean' : 'id' }
          : params,
      };
    default:
      return { method, params };
  }
}

function withV2McpServers(params: unknown): Record<string, unknown> | undefined {
  if (!isRecord(params)) return undefined;
  if (!Array.isArray(params.mcpServers)) return params;
  return {
    ...params,
    mcpServers: params.mcpServers.map((server: unknown) =>
      isRecord(server) && !('type' in server) ? { ...server, type: 'stdio' } : server,
    ),
  };
}

export function v2AgentResponse(method: string, result: unknown): unknown {
  switch (method) {
    case methods.agent.session.new:
    case methods.agent.session.load:
    case methods.agent.session.resume:
    case methods.agent.session.fork:
    case methods.agent.session.setConfigOption:
      return isRecord(result) && Array.isArray(result.configOptions)
        ? { ...result, configOptions: result.configOptions.map(configOption) }
        : result;
    default:
      return result;
  }
}

function configOption(option: unknown): unknown {
  if (!isRecord(option) || typeof option.configId !== 'string') return option;
  const { configId: id, ...rest } = option;
  if (!Array.isArray(rest.options)) return { ...rest, id };
  return {
    ...rest,
    id,
    options: rest.options.map((item: unknown) => {
      if (!isRecord(item) || typeof item.groupId !== 'string') return item;
      const { groupId: group, ...choice } = item;
      return { ...choice, group };
    }),
  };
}

export function v2SessionNotification(
  params: v2.UpdateSessionNotification,
  seenTools?: Set<string>,
): v2.UpdateSessionNotification[] {
  const { update } = params;
  if (v2.SessionUpdate.isConfigOptionUpdate(update) && Array.isArray(update.configOptions)) {
    return [
      { ...params, update: { ...update, configOptions: update.configOptions.map(configOption) } },
    ];
  }
  if (v2.SessionUpdate.isToolCallContentChunk(update) && isRecord(update.content)) {
    return v2SessionNotification(
      {
        ...params,
        update: { ...update, sessionUpdate: 'tool_call_update', content: [update.content] },
      },
      seenTools,
    );
  }
  if (
    !v2.SessionUpdate.isToolCallUpdate(update) ||
    typeof update.toolCallId !== 'string' ||
    update.toolCallId === ''
  ) {
    return [params];
  }

  if (seenTools === undefined || seenTools.has(update.toolCallId)) return [params];
  seenTools.add(update.toolCallId);
  const title = update.title ?? update.name ?? 'Tool';
  const status = update.status ?? 'pending';
  const startStatus = status === 'in_progress' ? status : 'pending';
  // v2 的首条更新也能提供输出或终态。先登记开始，再交给现有更新逻辑。
  const { content: _content, rawOutput: _rawOutput, ...start } = update;
  const started = {
    ...params,
    update: { ...start, sessionUpdate: 'tool_call', title, status: startStatus },
  };
  return status !== startStatus || update.content != null ? [started, params] : [started];
}

export function v2Permission(
  params: v2.RequestPermissionRequest,
  fallbackId: string,
): RequestPermissionRequest {
  const { subject } = params;
  const toolCall: ToolCallUpdate =
    subject == null
      ? { toolCallId: fallbackId, title: params.title }
      : v2.RequestPermissionSubject.isToolCall(subject)
        ? (subject.toolCall as ToolCallUpdate)
        : v2.RequestPermissionSubject.isCommand(subject)
          ? {
              toolCallId: subject.toolCallId ?? fallbackId,
              title: params.title,
              kind: 'execute',
              rawInput: { command: subject.command, cwd: subject.cwd },
            }
          : { toolCallId: fallbackId, title: params.title };
  return {
    sessionId: params.sessionId,
    toolCall,
    options: params.options.flatMap((option): PermissionOption[] => {
      const { kind } = option;
      return kind === 'allow_once' ||
        kind === 'allow_always' ||
        kind === 'reject_once' ||
        kind === 'reject_always'
        ? [{ ...option, kind }]
        : [];
    }),
    _meta: params._meta,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
