// 仅供测试：各 schema 的合法与非法样例。不从 index.ts 导出，不进入构建产物。
// 合法样例以 TS 类型约束（与 z.infer 一致），非法样例各自只破坏一处，便于定位。

import type { ClientIdentity } from './common.js';
import type {
  ApprovalRequest,
  ApprovalResolution,
  ProviderProfile,
  Session,
  SessionSnapshot,
  ToolDisplay,
  Workspace,
} from './entities.js';
import type { ErrorData, ErrorDataSchemas } from './errors.js';
import type { WevirEventOf, WevirEventPayload, WevirEventType } from './events.js';
import type {
  MethodName,
  MethodParams,
  MethodResult,
  NotificationName,
  NotificationParams,
} from './methods.js';

export const ULID = '01JA2B3C4D5E6F7G8H9JKMNPQR';
export const TS = '2026-10-12T08:00:00.000Z';
export const TS2 = '2026-10-12T08:00:05.250Z';

export const ids = {
  workspace: `ws_${ULID}`,
  session: `ses_${ULID}`,
  turn: `trn_${ULID}`,
  approval: `apr_${ULID}`,
  stream: `stm_${ULID}`,
  subscription: `sub_${ULID}`,
  host: `hst_${ULID}`,
} as const;

export const identity: ClientIdentity = {
  deviceId: 'dev-6f1c2a',
  clientId: 'cli-3e9b70',
  clientKind: 'cli',
};

export const workspace: Workspace = {
  id: ids.workspace,
  rootPath: '/Users/me/projects/wevir',
  displayName: 'wevir',
  createdAt: TS,
  updatedAt: TS,
};

export const deepseekProvider: ProviderProfile = {
  id: 'deepseek-official',
  kind: 'deepseek-official',
  displayName: 'DeepSeek',
  models: [],
  defaultModelId: 'deepseek-chat',
  hasSecret: true,
  createdAt: TS,
  updatedAt: TS,
};

export const compatibleProvider: ProviderProfile = {
  id: 'local-ollama',
  kind: 'openai-compatible',
  displayName: '本机 Ollama',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:11434/v1',
  compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  models: [{ id: 'qwen3:8b', displayName: 'Qwen3 8B', contextWindow: 32768 }],
  defaultModelId: 'qwen3:8b',
  hasSecret: false,
  createdAt: TS,
  updatedAt: TS,
};

export const session: Session = {
  id: ids.session,
  workspaceId: ids.workspace,
  cwd: '/Users/me/projects/wevir',
  engine: { kind: 'dsh', sessionId: '6b0f4c1e-7d2a-4e8b-9f31-2a5c7e9d0b14' },
  providerId: 'deepseek-official',
  modelId: 'deepseek-chat',
  reasoningEffort: 'high',
  title: '整理本周周报',
  titleSource: 'first_prompt',
  state: 'awaiting_approval',
  activeTurn: { turnId: ids.turn, startedAt: TS, clientMessageId: 'msg-1' },
  createdAt: TS,
  updatedAt: TS2,
  lastSeq: 12,
};

export const toolDisplay: ToolDisplay = {
  kind: 'write',
  summary: '/tmp/wevir-outside.txt',
  paths: ['/tmp/wevir-outside.txt'],
};

export const pendingApproval: ApprovalRequest = {
  id: ids.approval,
  sessionId: ids.session,
  turnId: ids.turn,
  toolCallId: 'call_mv4pwxip_1',
  options: [
    { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once', category: 'allow' },
    { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' },
  ],
  detail: {
    toolName: 'write',
    display: toolDisplay,
    input: {
      file_path: '/tmp/wevir-outside.txt',
      content: 'hello',
      sandbox_permissions: 'danger-full-access',
      justification: 'write outside workspace',
    },
    justification: 'write outside workspace',
    sandboxPermissions: 'danger-full-access',
  },
  status: 'pending',
  createdAt: TS,
};

export const userResolution: ApprovalResolution = {
  optionId: 'allow-once',
  decidedBy: { deviceId: 'dev-6f1c2a', clientId: 'desk-81d0aa', clientKind: 'desktop' },
  reason: 'user',
};

export const snapshot: SessionSnapshot = {
  session,
  pendingApprovals: [pendingApproval],
  todos: [{ content: '列出本周提交', status: 'in_progress' }],
  usage: { contextUsed: 5120, contextSize: 262144 },
};

// ── 事件 payload：键必须覆盖全部事件类型（编译期穷尽） ───────────────────

type PayloadSamples = {
  [T in WevirEventType]: { valid: WevirEventPayload<T>; invalid: unknown };
};

export const eventPayloads: PayloadSamples = {
  'session.created': {
    valid: {
      workspaceId: ids.workspace,
      cwd: '/Users/me/projects/wevir',
      providerId: 'deepseek-official',
      modelId: 'deepseek-chat',
      reasoningEffort: 'high',
    },
    invalid: { workspaceId: ids.workspace, cwd: '/x', providerId: 'DeepSeek', modelId: 'm' },
  },
  'session.title_changed': {
    valid: { title: '整理本周周报', source: 'first_prompt' },
    invalid: { title: '整理本周周报', source: 'engine' },
  },
  'session.state_changed': {
    valid: { from: 'running', to: 'awaiting_approval', reason: 'approval_requested' },
    invalid: { from: 'running', to: 'paused', reason: 'approval_requested' },
  },
  'user.message': {
    valid: {
      turnId: ids.turn,
      clientMessageId: 'msg-1',
      content: [{ type: 'text', text: '帮我整理本周周报' }],
      sentBy: identity,
    },
    invalid: { turnId: ids.turn, content: [], sentBy: identity },
  },
  'turn.started': {
    valid: { turnId: ids.turn },
    invalid: { turnId: ids.session },
  },
  'turn.finished': {
    valid: {
      turnId: ids.turn,
      outcome: 'completed',
      engineStopReason: 'end_turn',
      durationMs: 5250,
    },
    invalid: { turnId: ids.turn, outcome: 'done', durationMs: 5250 },
  },
  'assistant.delta': {
    valid: { turnId: ids.turn, streamId: ids.stream, blockIndex: 0, kind: 'text', text: '好的，' },
    invalid: { turnId: ids.turn, streamId: ids.stream, blockIndex: 0, kind: 'tool', text: 'x' },
  },
  'assistant.stream_ended': {
    valid: { turnId: ids.turn, streamId: ids.stream, outcome: 'committed' },
    invalid: { turnId: ids.turn, streamId: ids.stream, outcome: 'ok' },
  },
  'assistant.message': {
    valid: {
      turnId: ids.turn,
      messageId: '0f5e2d9c-41b7-4c1a-8e3d-6a2b9c0d1e7f',
      text: '好的，我来整理。',
      replaces: [{ streamId: ids.stream, blockIndex: 0 }],
    },
    invalid: { turnId: ids.turn, messageId: 'm', text: 'x' },
  },
  'assistant.thought': {
    valid: {
      turnId: ids.turn,
      messageId: '0f5e2d9c-41b7-4c1a-8e3d-6a2b9c0d1e7f',
      text: '先列出提交记录。',
      replaces: [],
    },
    invalid: {
      turnId: ids.turn,
      messageId: 'm',
      text: 'x',
      replaces: [{ streamId: ids.stream, blockIndex: -1 }],
    },
  },
  'tool.started': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_1',
      toolName: 'write',
      display: toolDisplay,
      input: { file_path: '/tmp/wevir-outside.txt', content: 'hello' },
    },
    invalid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_1',
      toolName: 'write',
      display: { kind: 'delete' },
    },
  },
  'tool.updated': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_2',
      output: { text: 'partial', truncated: false },
    },
    invalid: { turnId: ids.turn, toolCallId: 'call_mv4pwxip_2', output: { text: 'partial' } },
  },
  'tool.finished': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_2',
      status: 'completed',
      output: { text: 'ok', truncated: true, originalLength: 70000 },
    },
    invalid: { turnId: ids.turn, toolCallId: 'call_mv4pwxip_2', status: 'in_progress' },
  },
  'todo.updated': {
    valid: {
      turnId: ids.turn,
      toolCallId: 'call_mv4pwxip_0',
      items: [{ content: '列出本周提交', status: 'in_progress' }],
    },
    invalid: { turnId: ids.turn, toolCallId: 'call_mv4pwxip_0', items: [{ content: 'x' }] },
  },
  'approval.requested': {
    valid: { approval: pendingApproval },
    invalid: { approval: { ...pendingApproval, options: [] } },
  },
  'approval.resolved': {
    valid: { approvalId: ids.approval, status: 'approved', resolution: userResolution },
    invalid: { approvalId: ids.approval, status: 'pending', resolution: userResolution },
  },
  'usage.updated': {
    valid: { contextUsed: 5120, contextSize: 262144 },
    invalid: { contextUsed: -1, contextSize: 262144 },
  },
  'engine.error': {
    valid: {
      category: 'missing_credentials',
      message: 'turn failed: llm-deepseek: no API key for provider route deepseek-official',
      code: -32603,
      turnId: ids.turn,
      fatal: false,
    },
    invalid: { category: 'missing_credentials', message: 'x' },
  },
  'engine.raw': {
    valid: {
      protocol: 'acp',
      method: 'session/update',
      kind: 'config_option_update',
      params: { sessionUpdate: 'config_option_update' },
    },
    invalid: { protocol: 'mcp', method: 'session/update' },
  },
};

export function eventOf<T extends WevirEventType>(type: T, seq = 7): WevirEventOf<T> {
  const engineTypes: string[] = ['assistant.delta', 'assistant.message', 'tool.started'];
  return {
    seq,
    sessionId: ids.session,
    ts: TS,
    type,
    source: engineTypes.includes(type) ? 'engine' : 'host',
    payload: eventPayloads[type].valid,
  } as unknown as WevirEventOf<T>;
}

// ── 方法：键必须覆盖全部方法（编译期穷尽） ─────────────────────────────

type MethodSamples = {
  [M in MethodName]: {
    params: { valid: MethodParams<M>[]; invalid: unknown[] };
    result: { valid: MethodResult<M>[]; invalid: unknown[] };
  };
};

const empty = { valid: [{}], invalid: [null, 'x'] };

export const methodSamples: MethodSamples = {
  'host.hello': {
    params: {
      valid: [
        {
          token: 'test-token-not-a-secret',
          protocolVersion: '0.1.0',
          clientKind: 'desktop',
          deviceId: 'dev-6f1c2a',
          clientId: 'desk-81d0aa',
          capabilities: {},
        },
      ],
      invalid: [
        {
          token: 't',
          protocolVersion: '0.1',
          clientKind: 'cli',
          deviceId: 'd',
          clientId: 'c',
          capabilities: {},
        },
        {
          token: 't',
          protocolVersion: '0.1.0',
          clientKind: 'browser',
          deviceId: 'd',
          clientId: 'c',
          capabilities: {},
        },
      ],
    },
    result: {
      valid: [
        {
          hostId: ids.host,
          hostVersion: '0.0.0',
          protocolVersion: '0.1.0',
          minProtocolVersion: '0.1.0',
          features: {},
          permissions: ['host.manage', 'session.read', 'session.write'],
        },
      ],
      invalid: [
        {
          hostId: 'host-1',
          hostVersion: '0.0.0',
          protocolVersion: '0.1.0',
          minProtocolVersion: '0.1.0',
          features: {},
          permissions: [],
        },
      ],
    },
  },
  'host.ping': { params: empty, result: empty },
  'host.shutdown': { params: empty, result: empty },
  'workspace.list': {
    params: empty,
    result: { valid: [{ workspaces: [workspace] }], invalid: [{ workspaces: [{ id: 'x' }] }] },
  },
  'workspace.add': {
    params: {
      valid: [{ rootPath: '/Users/me/projects/wevir' }, { rootPath: '/tmp/a', displayName: 'A' }],
      invalid: [{ rootPath: '' }, { displayName: 'A' }],
    },
    result: {
      valid: [{ workspace, created: true }],
      invalid: [{ workspace }],
    },
  },
  'workspace.remove': {
    params: { valid: [{ workspaceId: ids.workspace }], invalid: [{ workspaceId: ids.session }] },
    result: empty,
  },
  'provider.list': {
    params: empty,
    result: {
      valid: [{ providers: [deepseekProvider, compatibleProvider] }],
      invalid: [{ providers: [{ ...compatibleProvider, hasSecret: undefined }] }],
    },
  },
  'provider.upsert': {
    params: {
      valid: [
        {
          id: 'deepseek-official',
          kind: 'deepseek-official',
          displayName: 'DeepSeek',
          models: [],
          defaultModelId: 'deepseek-chat',
          apiKey: 'placeholder-not-a-key',
        },
        {
          id: 'local-ollama',
          kind: 'openai-compatible',
          displayName: '本机 Ollama',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'qwen3:8b' }],
          defaultModelId: 'qwen3:8b',
          apiKey: null,
        },
      ],
      invalid: [
        // deepseek-official 的 id 固定
        {
          id: 'my-deepseek',
          kind: 'deepseek-official',
          displayName: 'DeepSeek',
          models: [],
          defaultModelId: 'deepseek-chat',
        },
        // openai-compatible 必须有 api 与 baseURL
        {
          id: 'local-ollama',
          kind: 'openai-compatible',
          displayName: 'Ollama',
          models: [{ id: 'qwen3:8b' }],
          defaultModelId: 'qwen3:8b',
        },
        // baseURL 只接受 http / https
        {
          id: 'local-ollama',
          kind: 'openai-compatible',
          displayName: 'Ollama',
          api: 'openai-completions',
          baseURL: 'localhost:11434',
          models: [{ id: 'qwen3:8b' }],
          defaultModelId: 'qwen3:8b',
        },
      ],
    },
    result: {
      valid: [{ provider: compatibleProvider, created: false }],
      invalid: [{ provider: { ...compatibleProvider, id: 'Local Ollama' }, created: false }],
    },
  },
  'provider.remove': {
    params: { valid: [{ providerId: 'local-ollama' }], invalid: [{ providerId: '1abc' }] },
    result: empty,
  },
  'provider.test': {
    params: {
      valid: [{ providerId: 'local-ollama' }, { providerId: 'local-ollama', modelId: 'qwen3:8b' }],
      invalid: [{ modelId: 'qwen3:8b' }],
    },
    result: {
      valid: [
        { ok: true, latencyMs: 420 },
        { ok: false, error: { category: 'missing_credentials', message: 'no API key' } },
      ],
      invalid: [{ ok: 'yes' }],
    },
  },
  'session.create': {
    params: {
      valid: [
        { workspaceId: ids.workspace, providerId: 'deepseek-official' },
        {
          workspaceId: ids.workspace,
          providerId: 'deepseek-official',
          modelId: 'deepseek-reasoner',
          reasoningEffort: 'max',
        },
      ],
      invalid: [{ workspaceId: ids.workspace }],
    },
    result: { valid: [{ session }], invalid: [{ session: { ...session, state: 'paused' } }] },
  },
  'session.list': {
    params: { valid: [{}, { workspaceId: ids.workspace }], invalid: [{ workspaceId: 'ws_' }] },
    result: {
      valid: [{ sessions: [session] }],
      invalid: [{ sessions: [{ ...session, lastSeq: -1 }] }],
    },
  },
  'session.get': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: {
      valid: [snapshot, { session: { ...session, state: 'idle' }, pendingApprovals: [] }],
      invalid: [{ session }],
    },
  },
  'session.send': {
    params: {
      valid: [
        { sessionId: ids.session, content: [{ type: 'text', text: '继续' }] },
        {
          sessionId: ids.session,
          content: [{ type: 'text', text: '继续' }],
          clientMessageId: 'msg-2',
        },
      ],
      invalid: [
        { sessionId: ids.session, content: [] },
        { sessionId: ids.session, content: [{ type: 'image', data: 'xx' }] },
        { sessionId: ids.session, content: [{ type: 'text', text: 'x' }], clientMessageId: '' },
      ],
    },
    result: { valid: [{ turnId: ids.turn, seq: 13 }], invalid: [{ turnId: ids.turn, seq: 0 }] },
  },
  'session.cancel': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{ sessionId: 'ses-1' }] },
    result: empty,
  },
  'session.close': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{ sessionId: 42 }] },
    result: empty,
  },
  'session.resume': {
    params: { valid: [{ sessionId: ids.session }], invalid: [{}] },
    result: { valid: [{ session }], invalid: [{}] },
  },
  'approval.respond': {
    params: {
      valid: [{ approvalId: ids.approval, optionId: 'allow-once' }],
      invalid: [{ approvalId: ids.approval }],
    },
    result: {
      valid: [{ approvalId: ids.approval, status: 'approved', resolution: userResolution }],
      invalid: [{ approvalId: ids.approval, status: 'pending', resolution: userResolution }],
    },
  },
  'events.subscribe': {
    params: {
      valid: [
        { sessionId: ids.session, sinceSeq: 0 },
        { sessionId: ids.session, sinceSeq: 12 },
      ],
      invalid: [{ sessionId: ids.session }, { sessionId: ids.session, sinceSeq: 1.5 }],
    },
    result: {
      valid: [{ subscriptionId: ids.subscription, replayedThroughSeq: 12 }],
      invalid: [{ subscriptionId: ids.subscription }],
    },
  },
  'events.unsubscribe': {
    params: {
      valid: [{ subscriptionId: ids.subscription }],
      invalid: [{ subscriptionId: ids.session }],
    },
    result: empty,
  },
};

type NotificationSamples = {
  [N in NotificationName]: { valid: NotificationParams<N>[]; invalid: unknown[] };
};

export const notificationSamples: NotificationSamples = {
  'events.event': {
    valid: [{ subscriptionId: ids.subscription, event: eventOf('assistant.delta', 13) }],
    invalid: [
      { event: eventOf('assistant.delta', 13) },
      { subscriptionId: ids.subscription, event: { ...eventOf('turn.started'), seq: 0 } },
    ],
  },
};

// ── 错误 data ─────────────────────────────────────────────────────────

type ErrorDataSamples = {
  [N in keyof typeof ErrorDataSchemas]: { valid: ErrorData<N>; invalid: unknown };
};

export const errorDataSamples: ErrorDataSamples = {
  METHOD_NOT_FOUND: {
    valid: { hostVersion: '0.0.0', hint: '请升级 Wevir Host' },
    invalid: { hostVersion: '0.0.0' },
  },
  INVALID_PARAMS: {
    valid: { issues: [{ path: ['content', 0, 'text'], message: 'Invalid input' }] },
    invalid: { issues: [{ path: 'content', message: 'x' }] },
  },
  INCOMPATIBLE_PROTOCOL: {
    valid: { hostVersion: '0.0.0', protocolVersion: '0.1.0', minProtocolVersion: '0.1.0' },
    invalid: { hostVersion: '0.0.0', protocolVersion: 'v1', minProtocolVersion: '0.1.0' },
  },
  INVALID_STATE: { valid: { state: 'closed' }, invalid: { state: 'gone' } },
  SESSION_BUSY: {
    valid: { state: 'running', activeTurn: { turnId: ids.turn, startedAt: TS } },
    invalid: {},
  },
  ALREADY_DECIDED: {
    valid: {
      approvalId: ids.approval,
      status: 'cancelled',
      resolution: { reason: 'turn_cancelled' },
    },
    invalid: { approvalId: ids.approval, status: 'cancelled', resolution: { reason: 'timeout' } },
  },
  CLIENT_MESSAGE_CONFLICT: { valid: { clientMessageId: 'msg-1' }, invalid: { clientMessageId: 1 } },
  RESOURCE_IN_USE: { valid: { sessionIds: [ids.session] }, invalid: { sessionIds: ['s1'] } },
  WORKSPACE_PATH_INVALID: {
    valid: { path: '/Users/me/gone', reason: 'not_found' },
    invalid: { path: '/Users/me/gone', reason: 'missing' },
  },
  ENGINE_ERROR: {
    valid: { category: 'session_unavailable', message: 'session cwd does not match' },
    invalid: { category: 'fatal', message: 'x' },
  },
};
