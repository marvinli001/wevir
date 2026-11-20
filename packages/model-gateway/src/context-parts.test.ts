import { readFileSync } from 'node:fs';
import { measureContext } from '@wevir/runtime-adapter';
import { expect, it } from 'vitest';
import { requestContextParts } from './context-parts.js';
import type { ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

it.each(['openai-responses', 'openai-completions', 'anthropic-messages', 'google-gemini'] as const)(
  'measures the transmitted %s catalog and the recorded instruction blocks',
  (api) => {
    const sample = (file: string) =>
      JSON.parse(
        readFileSync(
          new URL(`./test-fixtures/codex-requests/${file}.json`, import.meta.url),
          'utf8',
        ),
      ).body as ResponsesRequest;
    const source = sample('context');
    const skills = (
      sample('1-first-turn').input as Exclude<ResponsesRequest['input'], string>
    ).slice(0, 1);
    // The first developer message has separate content blocks for base instructions, skills and permissions.
    source.input = [...skills, ...(source.input as Exclude<ResponsesRequest['input'], string>)];
    const prepared = prepareUpstream(
      {
        id: 'mock',
        displayName: 'mock',
        kind: 'openai-compatible',
        api,
        baseURL: 'https://local.invalid/v1',
        defaultModelId: source.model,
        models: [],
      },
      source,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const parts = requestContextParts(
      prepared.payload as Record<string, unknown>,
      prepared.mode,
      source,
      [{ name: '/workspace/AGENTS.md', text: 'Keep invoice dates in UTC.\n' }],
    );
    const measured = measureContext(parts, { contextUsed: 2000, contextSize: 4096 }, 'exact-split');
    const bytes = Object.fromEntries(
      measured.categories
        .filter((c) => c.kind === 'used')
        .map((c) => [
          c.name,
          parts.filter((p) => p.category === c.name).reduce((s, p) => s + p.bytes, 0),
        ]),
    );
    expect(Object.keys(bytes).sort()).toEqual(
      [
        'MCP server instructions',
        'MCP tools',
        'Memory files',
        'Messages',
        'Skills',
        'System prompt',
        'System tools',
      ].sort(),
    );
    expect(measured.groups?.find((g) => g.group === 'memory_files')?.count).toBe(2);
    expect({ bytes, categories: measured.categories, groups: measured.groups }).toMatchSnapshot();
  },
);
