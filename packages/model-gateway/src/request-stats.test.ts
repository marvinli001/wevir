import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requestStats } from './request-stats.js';
import type { ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

describe('requestStats', () => {
  for (const file of ['1-first-turn', '2-tool-results', '3-next-turn', '4-compact']) {
    for (const mode of ['responses', 'chat', 'messages'] as const) {
      it(`${file} / ${mode}`, () => {
        const fixture = JSON.parse(
          readFileSync(
            new URL(`./test-fixtures/codex-requests/${file}.json`, import.meta.url),
            'utf8',
          ),
        );
        const source = (fixture.body ?? fixture) as ResponsesRequest;
        const prepared = prepareUpstream(
          {
            id: 'p',
            displayName: 'P',
            kind: 'openai-compatible',
            api: (
              {
                responses: 'openai-responses',
                chat: 'openai-completions',
                messages: 'anthropic-messages',
              } as const
            )[mode],
            baseURL: 'https://test.invalid/v1',
            apiKey: 'test',
            models: [],
            defaultModelId: source.model,
            compat: { toolSearch: 'native' },
          },
          source,
        );
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) return;
        expect(
          requestStats(
            prepared.payload as Record<string, unknown>,
            prepared.mode,
            JSON.stringify(prepared.payload),
            source,
          ),
        ).toMatchSnapshot();
      });
    }
  }
  it('only new Wevir outputs count once, including UTF-8', () => {
    const body: ResponsesRequest = {
      model: 'm',
      input: [
        { type: 'function_call', call_id: 'c', name: 'mcp__wevir__wevir_tasks' },
        { type: 'function_call_output', call_id: 'c', output: '账本' },
        { type: 'function_call', call_id: 'shell', name: 'exec_command' },
        { type: 'function_call_output', call_id: 'shell', output: 'ignored' },
      ],
    };
    const seen = new Set<string>();
    expect(requestStats(body, 'responses', JSON.stringify(body), body, seen)).toMatchObject({
      wevirOutputBytes: 6,
      wevirOutputBytesNew: 6,
    });
    expect(requestStats(body, 'responses', JSON.stringify(body), body, seen)).toMatchObject({
      wevirOutputBytes: 6,
      wevirOutputBytesNew: 0,
    });
  });
});
