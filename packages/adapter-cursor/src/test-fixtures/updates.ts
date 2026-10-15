// 映射回放用的 InteractionUpdate 序列。没有 Cursor 账号，不是录制的：按 @cursor/sdk 1.0.35 的 schema 手写（类型就是 SDK 的
// InteractionUpdate，字段对不上时 tsc 报错），形状对照 T3 Code 的 adapter.test.ts 与 SDK 的 delta-types / tool-call-types。

import type { InteractionUpdate } from '@cursor/sdk';

/** 先思考，再回答，回合结束。 */
export const PLAIN_UPDATES: InteractionUpdate[] = [
  { type: 'step-started', stepId: 1 },
  { type: 'thinking-delta', text: 'The user ' },
  { type: 'thinking-delta', text: 'says hello.' },
  { type: 'thinking-completed', thinkingDurationMs: 120 },
  { type: 'text-delta', text: 'Hello' },
  { type: 'text-delta', text: ' from Cursor.' },
  { type: 'token-delta', tokens: 12 },
  { type: 'step-completed', stepId: 1, stepDurationMs: 300 },
  {
    type: 'turn-ended',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

/** 一次命令（流式输出）、一次读文件、一次编辑、一次搜索、一次失败的 MCP 调用、待办、子 agent，中间夹着回答。 */
export const TOOL_UPDATES: InteractionUpdate[] = [
  {
    type: 'tool-call-started',
    callId: 'call-shell',
    modelCallId: 'model-call-1',
    toolCall: { type: 'shell', args: { command: 'ls -la' } },
  },
  { type: 'shell-output-delta', event: { stdout: 'total 8\n' } },
  {
    type: 'tool-call-completed',
    callId: 'call-shell',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'shell',
      args: { command: 'ls -la' },
      result: {
        status: 'success',
        value: {
          stdout: 'total 8\nREADME.md\n',
          stderr: '',
          exitCode: 0,
          signal: '',
          executionTime: 12,
        },
      },
    },
  },
  {
    type: 'tool-call-started',
    callId: 'call-read',
    modelCallId: 'model-call-1',
    toolCall: { type: 'read', args: { path: 'README.md' } },
  },
  {
    type: 'tool-call-completed',
    callId: 'call-read',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'read',
      args: { path: 'README.md' },
      result: { status: 'success', value: { content: '# Demo\n', totalLines: 1, fileSize: 7 } },
    },
  },
  { type: 'text-delta', text: 'Editing now.' },
  {
    type: 'tool-call-started',
    callId: 'call-edit',
    modelCallId: 'model-call-1',
    toolCall: { type: 'edit', args: { path: 'README.md' } },
  },
  {
    type: 'tool-call-completed',
    callId: 'call-edit',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'edit',
      args: { path: 'README.md' },
      result: {
        status: 'success',
        value: { linesAdded: 1, linesRemoved: 0, diffString: '@@ -1 +1,2 @@\n # Demo\n+Hello\n' },
      },
    },
  },
  {
    type: 'tool-call-completed',
    callId: 'call-grep',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'grep',
      args: { pattern: 'Hello', path: 'src' },
      result: { status: 'success', value: { workspaceResults: {} } },
    },
  },
  {
    type: 'tool-call-started',
    callId: 'call-mcp',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'mcp',
      args: { args: { query: 'x' }, providerIdentifier: 'docs', toolName: 'search' },
    },
  },
  {
    type: 'tool-call-completed',
    callId: 'call-mcp',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'mcp',
      args: { args: { query: 'x' }, providerIdentifier: 'docs', toolName: 'search' },
      result: {
        status: 'success',
        value: { content: [{ text: { text: 'server down' } }], isError: true },
      },
    },
  },
  {
    type: 'tool-call-started',
    callId: 'call-todos',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'updateTodos',
      args: {
        todos: [
          { content: 'Read the README', status: 'completed' },
          { content: 'Add a greeting', status: 'inProgress' },
          { content: 'Old idea', status: 'cancelled' },
        ],
      },
    },
  },
  {
    type: 'tool-call-completed',
    callId: 'call-todos',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'updateTodos',
      args: {
        todos: [
          { content: 'Read the README', status: 'completed' },
          { content: 'Add a greeting', status: 'inProgress' },
          { content: 'Old idea', status: 'cancelled' },
        ],
      },
      result: {
        status: 'success',
        value: {
          todos: [
            { content: 'Read the README', status: 'completed' },
            { content: 'Add a greeting', status: 'completed' },
          ],
          totalCount: 2,
        },
      },
    },
  },
  {
    type: 'tool-call-started',
    callId: 'call-task',
    modelCallId: 'model-call-1',
    toolCall: { type: 'task', args: { description: 'Check tests', prompt: 'Run the tests' } },
  },
  {
    type: 'partial-tool-call',
    callId: 'call-task',
    modelCallId: 'model-call-1',
    toolCall: { type: 'task', args: { description: 'Check tests', prompt: 'Run the tests and' } },
  },
  {
    type: 'tool-call-completed',
    callId: 'call-task',
    modelCallId: 'model-call-1',
    toolCall: {
      type: 'task',
      args: { description: 'Check tests', prompt: 'Run the tests' },
      result: {
        status: 'success',
        value: {
          conversationSteps: [{ type: 'assistantMessage', message: { text: 'All tests pass.' } }],
          isBackground: false,
          backgroundReason: 'unspecified',
        },
      },
    },
  },
  { type: 'text-delta', text: 'Done.' },
  { type: 'turn-ended' },
];

/** Cursor 把传输错误写成回答（transport-failure.ts）。 */
export const TRANSPORT_FAILURE_UPDATES: InteractionUpdate[] = [
  { type: 'text-delta', text: 'Error: ConnectError: [unavailable] ' },
  { type: 'text-delta', text: 'upstream connect error' },
  { type: 'turn-ended' },
];
