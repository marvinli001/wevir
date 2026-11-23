import type { InitializeResponse } from '@wevir/adapter-acp/sdk';
import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_APP_TOOLS_INSTRUCTIONS, antigravitySessionMeta } from './session-meta.js';

const appends = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
} as unknown as InitializeResponse;

describe('antigravitySessionMeta', () => {
  it('挂了应用级工具时在规则后追加长命令说明', () => {
    expect(antigravitySessionMeta(appends, true, 'Rules', true)).toEqual({
      antigravity: { systemPrompt: { append: `Rules\n\n${ANTIGRAVITY_APP_TOOLS_INSTRUCTIONS}` } },
    });
    expect(antigravitySessionMeta(appends, true, undefined, true)).toEqual({
      antigravity: { systemPrompt: { append: ANTIGRAVITY_APP_TOOLS_INSTRUCTIONS } },
    });
  });

  it('没有应用级工具或运行体不支持追加时不加', () => {
    expect(antigravitySessionMeta(appends, true, 'Rules')).toEqual({
      antigravity: { systemPrompt: { append: 'Rules' } },
    });
    expect(antigravitySessionMeta(undefined, true, undefined, true)).toBeUndefined();
  });
});
