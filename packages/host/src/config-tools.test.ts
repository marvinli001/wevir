// 配置工具的批准沿用（config-tools.ts）：引擎为这次调用问过用户、用户答应了，Host 不再补问；别的调用、规则或自动审查放行的照样补问。
// 环境变量的值在落库前换成 `[REDACTED]`。Host 方法与存储用假的，只看 ConfigTools 自己。

import type { SessionId, TurnId } from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import type { AppToolCall } from './app-mcp.js';
import { ConfigTools, type HostCall, redact } from './config-tools.js';
import type { EventStore } from './event-store.js';

const SESSION = 'ses_1' as SessionId;
const TURN = 'trn_1' as TurnId;

function setup() {
  const asked: string[] = [];
  const calls: string[] = [];
  const call = (async (method: string) => {
    calls.push(method);
    return method === 'settings.update' ? { settings: {} } : {};
  }) as unknown as HostCall;
  const storage = {
    sessions: { get: () => ({ id: SESSION, workspaceId: 'wrk_1' }) },
    workspaces: { get: () => ({ id: 'wrk_1' }) },
  } as unknown as Storage;
  const events = {
    snapshot: () => ({ session: { activeTurn: { turnId: TURN } } }),
  } as unknown as EventStore;
  const tools = new ConfigTools({
    call,
    storage,
    events,
    sessions: {
      requestAppToolApproval: async (_sessionId, toolCallId) => {
        asked.push(toolCallId);
        return true;
      },
    },
    ownSession: () => {
      throw new Error('unused');
    },
  });
  const run = (args: Record<string, unknown>) => {
    const tool = tools.tools.find((item) => item.name === 'wevir_config_settings');
    const context: AppToolCall = {
      sessionId: SESSION,
      signal: new AbortController().signal,
      server: 'wevir_more',
    };
    return tool?.call(args, context);
  };
  const started = (toolCallId: string, args: Record<string, unknown>): AgentEvent =>
    ({
      type: 'tool.started',
      engineSessionId: 'eng',
      toolCallId,
      toolName: 'mcp__wevir_more__wevir_config_settings',
      input: { server: 'wevir_more', tool: 'wevir_config_settings', arguments: args },
    }) as unknown as AgentEvent;
  return { tools, run, started, asked, calls };
}

describe('配置工具的批准', () => {
  const args = { settings: { agentInstructions: 'Be brief.' } };

  it('引擎为这次调用问过、用户答应了：Host 不再问', async () => {
    const h = setup();
    h.tools.prepareEvent(SESSION, h.started('call_1', args));
    h.tools.resolved(SESSION, 'call_1', true);
    await h.run(args);
    expect(h.asked).toEqual([]);
    expect(h.calls).toEqual(['settings.update']);
    // 同一批准只用一次：再调一次要问。
    await h.run(args);
    expect(h.asked).toHaveLength(1);
  });

  it('引擎没问、或不是用户答应的（规则、自动审查）：Host 补问，卡片挂在那次调用上', async () => {
    const h = setup();
    h.tools.prepareEvent(SESSION, h.started('call_2', args));
    h.tools.resolved(SESSION, 'call_2', false);
    await h.run(args);
    expect(h.asked).toEqual(['call_2']);
  });

  it('参数不同的调用不沿用批准', async () => {
    const h = setup();
    h.tools.prepareEvent(SESSION, h.started('call_3', args));
    h.tools.resolved(SESSION, 'call_3', true);
    await h.run({ settings: { agentInstructions: 'Something else.' } });
    expect(h.asked).toHaveLength(1);
  });

  it('照常的设置不问；只有用户能改的拒绝，不调 Host', async () => {
    const h = setup();
    await h.run({ settings: { promptSuggestions: false } });
    expect(h.asked).toEqual([]);
    await expect(h.run({ settings: { remote: { enabled: true } } })).rejects.toThrow(
      'Only the user can change remote',
    );
    expect(h.calls).toEqual(['settings.update']);
  });

  it('工具事件里的环境变量值换成 [REDACTED]', () => {
    const h = setup();
    const event = h.tools.prepareEvent(SESSION, {
      ...h.started('call_4', {}),
      toolName: 'mcp__wevir__wevir_config_update',
      input: {
        arguments: {
          target: 'environment',
          action: 'add',
          variables: [{ name: 'TOKEN', value: 'secret' }, { name: 'KEEP' }],
        },
      },
    } as AgentEvent);
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(redact({ variables: [{ name: 'A', value: 'x' }] })).toEqual({
      variables: [{ name: 'A', value: '[REDACTED]' }],
    });
  });
});
