// Antigravity 的 ACP 样本。多数取自 T3 Code 测试里的 Antigravity 样本（pingdotgg/t3code
// ec1313c8f8333292506f05a355bb72d308a455d8，MIT，© 2026 T3 Tools Inc.）：
// apps/server/src/provider/acp/AntigravityProtocol.test.ts（run_command 的原生字段、interaction_* 提问、安全提示）、
// AntigravityProvider.test.ts（configOptions 的模型与模式、initialize）、packages/effect-acp/test/fixtures/antigravity-initialize.json
// （1.1.1 的 initialize）、textGeneration/AntigravityTextGeneration.test.ts（逐字增量没有 messageId）；1.4 的思考档位取自
// 4432fbef71817c279290f86549be660af25005f2 的 AntigravityProvider.test.ts。`INITIALIZE_1_4_1` 是 Wevir 在没登录的隔离 HOME 里
// 对真实的 1.4.1 运行体（darwin-arm64）录的；登录之后的会话没有录过。

export const SESSION = 'session-1';

/** 1.1.1 的 initialize（T3 的 antigravity-initialize.json，协议版本 2、版本号带前缀）。 */
export const INITIALIZE_1_1_1 = {
  protocolVersion: 2,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: { list: {}, resume: {} },
    auth: { logout: {} },
  },
  authMethods: [
    {
      id: 'oauth-personal',
      name: 'Log in with Google',
      description: 'Log in with your Google account',
    },
    { id: 'oauth-business', name: 'Log in with Gemini Enterprise' },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' },
  ],
  agentInfo: {
    name: 'antigravity-acp',
    title: 'Google Antigravity',
    version: 'agy_acp_server_1.1.1',
  },
};

/** 1.4.1 的 initialize（真实运行体，没登录；版本号不带前缀，`_meta.antigravity` 是新加的）。 */
export const INITIALIZE_1_4_1 = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    sessionCapabilities: { list: {}, resume: {} },
    auth: { logout: {} },
    _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
  },
  authMethods: [
    {
      id: 'oauth-personal',
      name: 'Log in with Google',
      description: 'Log in with your Google account',
    },
    {
      id: 'oauth-business',
      name: 'Log in with Gemini Enterprise',
      description: 'Log in with your Gemini Enterprise account',
    },
    {
      id: 'gemini-api-key',
      name: 'Gemini API key',
      description: 'Use an API key with Gemini Developer API',
    },
    {
      id: 'agent-platform',
      name: 'Gemini Enterprise Agent Platform',
      description:
        'Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials or an API key',
    },
  ],
  agentInfo: { name: 'antigravity-acp', title: 'Google Antigravity', version: '1.4.1' },
};

/** 1.4 的思考档位选项（T3 4432fbef 的样本；ID 与类别与 1.4.1 运行体源码里的 THINKING_LEVEL_ID、thought_level 相同）。 */
export function thinkingOption(currentValue: string, values: readonly string[] = ['low', 'high']) {
  return {
    id: 'thinking_level',
    name: 'Thinking Level',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  };
}

/**
 * 1.4 的 `session/new` 结果（T3 4432fbef 的 “offers each model the thinking levels it reported when selected”）：`model`
 * 只列家族，当前模型的档位在 `thinking_level` 里，别的模型的档位要选中它才报。
 */
export const SESSION_SETUP_1_4 = {
  sessionId: SESSION,
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini',
      options: [
        { value: 'gemini', name: 'Gemini' },
        { value: 'claude', name: 'Claude' },
        { value: 'plain', name: 'Plain' },
        { value: 'unseen', name: 'Unseen' },
      ],
    },
    thinkingOption('high'),
  ],
};

export const MODEL_OPTIONS = [
  { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
  { value: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)' },
  { value: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)' },
  { value: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' },
];

/** `session/new` 的结果（T3 的 sessionSetupResult）。 */
export const SESSION_SETUP = {
  sessionId: SESSION,
  models: {
    currentModelId: 'gemini-3.7-flash-high',
    availableModels: MODEL_OPTIONS.map((option) => ({ modelId: option.value, name: option.name })),
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gemini-3.7-flash-high',
      options: [
        { groupId: 'Flash', name: 'Flash', options: MODEL_OPTIONS.slice(0, 3) },
        { groupId: 'Pro', name: 'Pro', options: [MODEL_OPTIONS[3], MODEL_OPTIONS[1]] },
      ],
    },
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'yolo', name: 'YOLO' },
      ],
    },
  ],
};

/** 一个回合：思考、两段逐字回答、命令工具（原生字段）、再一段回答。 */
export const TURN_WITH_COMMAND = [
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Choose concise text.' },
    },
  },
  {
    sessionId: SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"title":' } },
  },
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '"Repair login"}' },
    },
  },
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'fc28d0af6ad14be8bbba20f4258d4d3e',
      title: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'cat probe.txt', Cwd: '/workspace' },
    },
  },
  {
    sessionId: SESSION,
    update: {
      toolCallId: 'fc28d0af6ad14be8bbba20f4258d4d3e',
      status: 'completed',
      rawOutput: {
        commandLine: 'cat probe.txt',
        workingDir: '/workspace',
        exitCode: 0,
        exit_code: 0,
        combinedOutput: 'after\n',
        formatted_output: 'after\n',
      },
      sessionUpdate: 'tool_call_update',
    },
  },
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The file says after.' },
    },
  },
  {
    sessionId: SESSION,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'plan', description: 'Make a plan' }],
    },
  },
];

/** 带图片数据与超长输出的工具更新：进事件库之前要截断、去掉图片。 */
export const LARGE_TOOL_UPDATE = {
  sessionId: SESSION,
  update: {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'read-1',
    status: 'completed',
    rawOutput: {
      combinedOutput: `${'x'.repeat(20_000)}tail`,
      image: { type: 'image', data: 'A'.repeat(50_000) },
    },
    content: [
      {
        type: 'content',
        content: { type: 'image', data: 'B'.repeat(50_000), mimeType: 'image/png' },
      },
    ],
  },
};

/** 原生的提问（T3 的 questionRequest，“captured native question”）。 */
export const QUESTION_REQUEST = {
  sessionId: SESSION,
  toolCall: {
    toolCallId: 'interaction_9960062f',
    status: 'pending',
    title: 'Which result label should be used for the verification?',
    rawInput: {},
  },
  options: [
    { optionId: '1', name: 'Verified', kind: 'allow_once' },
    { optionId: '2', name: 'Needs review', kind: 'allow_once' },
  ],
};

/** 命令的审批（T3 的 permissionRequest，“Allow Always”带安全提示）。 */
export const PERMISSION_REQUEST = {
  sessionId: SESSION,
  toolCall: { toolCallId: 'command-1', kind: 'execute', title: 'Run command' },
  options: [
    {
      optionId: 'remember-this-command',
      name: 'Allow Always (risky)',
      kind: 'allow_always',
      _meta: {
        'agy.security.warning': {
          severity: 'high',
          risk: 'prompt_injection',
          title: 'Allowing always can be risky',
          message: 'Untrusted files could re-run this action without asking.',
        },
      },
    },
    { optionId: 'run-this-time', name: 'Allow', kind: 'allow_once' },
    { optionId: 'stop-this-command', name: 'Deny', kind: 'reject_once' },
  ],
};
