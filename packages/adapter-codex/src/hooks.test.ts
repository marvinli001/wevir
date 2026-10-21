import { describe, expect, it } from 'vitest';
import { codexHookHash, codexHookKey, hooksThreadConfig, sessionFlagsSource } from './hooks.js';

// 散列与键的写法对过真实 codex-app-server（rust-v0.162.1）：散列对得上才执行，见 codex-adapter.guardrails.integration.test.ts。

describe('Codex hooks 覆盖', () => {
  it('散列：Stop 不带 matcher，超时默认 600，键排序的紧凑 JSON', () => {
    expect(
      codexHookHash({
        event: 'PreToolUse',
        matcher: 'Bash|apply_patch',
        command: 'echo "x y"',
        timeoutSec: 30,
        statusMessage: 'chk',
      }),
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(codexHookHash({ event: 'Stop', matcher: 'ignored', command: 'node -e 1' })).toBe(
      codexHookHash({ event: 'Stop', command: 'node -e 1', timeoutSec: 600 }),
    );
    expect(codexHookHash({ event: 'PreToolUse', matcher: 'Bash', command: 'a' })).not.toBe(
      codexHookHash({ event: 'PreToolUse', matcher: 'Bash', command: 'b' }),
    );
  });

  it('键：来源路径、事件的 snake_case 写法、组与处理器序号', () => {
    expect(codexHookKey(sessionFlagsSource('linux'), 'PreToolUse', 1, 0)).toBe(
      '/<session-flags>/config.toml:pre_tool_use:1:0',
    );
    expect(sessionFlagsSource('win32')).toBe('C:\\<session-flags>\\config.toml');
  });

  it('覆盖：每个 hook 一组并带信任散列，停用的键写 enabled = false', () => {
    const pre = { event: 'PreToolUse', matcher: 'Bash', command: 'check', timeoutSec: 30 };
    const stop = { event: 'Stop', matcher: 'x', command: 'check' };
    const config = hooksThreadConfig(
      [pre, stop, { event: 'Nope', command: 'z' }],
      ['/repo/.codex/hooks.json:pre_tool_use:0:0'],
      'linux',
    );
    expect(config).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'check', timeout: 30, async: false }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'check', timeout: 600, async: false }] }],
        state: {
          '/repo/.codex/hooks.json:pre_tool_use:0:0': { enabled: false },
          '/<session-flags>/config.toml:pre_tool_use:0:0': { trusted_hash: codexHookHash(pre) },
          '/<session-flags>/config.toml:stop:0:0': { trusted_hash: codexHookHash(stop) },
        },
      },
    });
    expect(hooksThreadConfig([])).toEqual({});
  });
});
