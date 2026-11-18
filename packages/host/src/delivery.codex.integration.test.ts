import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import { MOCK_MODEL, type MockRequestBody, startMockModel } from '@wevir/adapter-codex/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch (error) {
  console.warn(`[delivery + codex] skipped: ${(error as Error).message}`);
}

function configRead(body: MockRequestBody, args: Record<string, string>) {
  for (const tool of body.tools ?? []) {
    if (
      tool.type === 'namespace' &&
      (tool.tools as Array<{ name?: string }>).some((item) => item.name === 'wevir_config_read')
    ) {
      return {
        toolCalls: [
          { kind: 'function' as const, name: 'wevir_config_read', namespace: tool.name, args },
        ],
      };
    }
    if (tool.name?.endsWith('wevir_config_read')) {
      return { toolCalls: [{ kind: 'function' as const, name: tool.name, args }] };
    }
  }
  throw new Error('missing wevir_config_read in the tool catalog');
}

describe.skipIf(binary === undefined)('delivery with Codex and a local mock model', () => {
  it('queries Host evidence after editing and reports an unrun check separately', async () => {
    const root = tempDir();
    const home = join(root, 'data');
    const userHome = join(root, 'user');
    const cwd = join(root, 'project');
    mkdirSync(userHome);
    mkdirSync(cwd);
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, HOME: userHome, GIT_CONFIG_NOSYSTEM: '1' },
      });
    const file = join(cwd, 'sample.mjs');
    const original = 'export const n = 1;\n';
    const changed = 'export const n = 2;\n';
    git('init', '-qb', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'Fixture');
    git('config', 'commit.gpgSign', 'false');
    writeFileSync(file, original);
    git('add', 'sample.mjs');
    git('commit', '-qm', 'initial');

    writeFileSync(
      join(cwd, '.git', 'gh'),
      [
        '#!/usr/bin/env node',
        'const fs = require("node:fs");',
        'const args = process.argv.slice(2);',
        'if (args.slice(0, 3).join(" ") !== "pr create --body-file") process.exit(2);',
        'fs.copyFileSync(args[3], ".git/submitted-body.md");',
        'console.log("https://example.invalid/pull/1");',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    let commit = '';
    let prQuery: Record<string, string> | undefined;
    let query: Record<string, string> | undefined;
    let evidence = '';
    let instructions = '';
    const model = await startMockModel((view) => {
      if (view.lastUserText.startsWith('[pr]')) {
        if (view.toolOutputs.length === 0) {
          prQuery = { section: 'checks', target: 'commit', format: 'markdown', commit };
          return configRead(view.body, prQuery);
        }
        if (view.toolOutputs.length === 1) {
          const output = (view.toolOutputs[0] ?? '').replace(
            /^Wall time: [\d.]+ seconds\nOutput:\n/,
            '',
          );
          const markdown = (JSON.parse(output) as { markdown: string }).markdown;
          const body = Buffer.from(`Update the sample.\n\n${markdown.trim()}\n`).toString('base64');
          const fakeGh = process.platform === 'win32' ? 'node .git/gh' : './.git/gh';
          return {
            toolCalls: [
              {
                kind: 'function',
                name: 'exec_command',
                args: {
                  cmd: `node -e "require('node:fs').writeFileSync('.git/pr-body.md', Buffer.from('${body}', 'base64'))" && ${fakeGh} pr create --body-file .git/pr-body.md`,
                },
              },
            ],
          };
        }
        return { text: ['Submitted the fixture PR body.'] };
      }
      if (!view.lastUserText.startsWith('[delivery]')) return { text: ['Delivery fixture'] };
      if (view.toolOutputs.length === 0) {
        instructions = JSON.stringify(view.body);
        return {
          toolCalls: [
            {
              kind: 'function',
              name: 'exec_command',
              args: {
                cmd: `node -e "require('node:fs').writeFileSync('sample.mjs', Buffer.from('${Buffer.from(changed).toString('base64')}', 'base64'))"`,
              },
            },
          ],
        };
      }
      if (view.toolOutputs.length === 1) {
        query = { section: 'checks', target: 'working_tree' };
        return configRead(view.body, query);
      }
      evidence = view.toolOutputs[1] ?? '';
      return {
        text: [
          evidence.includes('"status":"partial"')
            ? 'Lint passed on the current worktree. Typecheck was not run.'
            : 'The check results could not be read.',
        ],
      };
    });
    cleanups.push(() => model.close());
    const host = await startHost({
      home,
      userHome,
      pluginUserHome: userHome,
      importEnv: {},
      engine: 'codex',
      adapter: new CodexRuntime({
        home,
        binary,
        parentEnv: { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome },
        clientInfo: { name: 'wevir', version: '0.0.0' },
      }),
      logger: createLogger({ level: 'error', mirror: () => {} }),
    });
    cleanups.push(() => host.shutdown());
    const client = await TestRpcClient.connect(host.url);
    cleanups.push(() => client.ws.close());
    await client.hello(JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')).token, {
      deviceId: 'delivery-test',
      clientId: 'delivery-test',
      clientKind: 'desktop',
      uiLocale: 'zh-CN',
    });
    await client.request('settings.update', {
      settings: { promptSuggestions: false, sessionRecap: false, sessionInsights: false },
    });
    await client.request('provider.upsert', {
      id: 'delivery-mock',
      kind: 'openai-compatible',
      displayName: 'Delivery Mock',
      api: 'openai-responses',
      baseURL: model.baseURL,
      compat: { toolSearch: 'off' },
      models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
      defaultModelId: MOCK_MODEL,
      apiKey: 'wevir-mock-key-not-a-secret',
    });
    const { workspace } = await client.request('workspace.add', { rootPath: cwd });
    const { session } = await client.request('session.create', {
      workspaceId: workspace.id,
      providerId: 'delivery-mock',
      permissionMode: 'full_access',
      title: 'Delivery fixture',
    });
    const { subscriptionId } = await client.request('events.subscribe', {
      sessionId: session.id,
      sinceSeq: 0,
    });
    const { check } = await client.request('checks.save', {
      workspaceId: workspace.id,
      check: { name: 'Lint', kind: 'lint', trigger: 'manual', command: 'node --check sample.mjs' },
    });
    await client.request('checks.save', {
      workspaceId: workspace.id,
      check: {
        name: 'Typecheck',
        kind: 'typecheck',
        trigger: 'manual',
        command: 'node --check sample.mjs',
      },
    });
    writeFileSync(file, changed);
    await client.request('verification.run', { sessionId: session.id, checkIds: [check.id] });
    await client.until(
      () =>
        client
          .events(subscriptionId)
          .find(
            (event) =>
              event.type === 'verification.updated' && event.payload.run.status === 'passed',
          ),
      'first check',
      20_000,
    );
    writeFileSync(file, original);

    const { turnId } = await client.request('session.send', {
      sessionId: session.id,
      content: [
        { type: 'text', text: '[delivery] Update the sample and report the verification.' },
      ],
    });
    const finished = await client.until(
      () =>
        client
          .events(subscriptionId)
          .find((event) => event.type === 'turn.finished' && event.payload.turnId === turnId),
      'turn.finished',
      45_000,
    );
    expect(finished?.payload).toMatchObject({ outcome: 'completed' });
    expect(readFileSync(file, 'utf8')).toBe(changed);
    expect(instructions).toContain('在说明验证前用');
    expect(query).toEqual({ section: 'checks', target: 'working_tree' });
    expect(evidence).toContain('"status":"partial"');
    expect(evidence).toMatch(/"name":"Typecheck","kind":"typecheck","status":"not_run"/);
    expect(
      client
        .events(subscriptionId)
        .filter((event) => event.type === 'assistant.message')
        .at(-1)?.payload,
    ).toMatchObject({ text: 'Lint passed on the current worktree. Typecheck was not run.' });

    git('add', 'sample.mjs');
    git('commit', '-qm', 'updated sample');
    commit = git('rev-parse', 'HEAD').trim();
    const pr = await client.request('session.send', {
      sessionId: session.id,
      content: [{ type: 'text', text: '[pr] Create a PR for the updated sample.' }],
    });
    const prFinished = await client.until(
      () =>
        client
          .events(subscriptionId)
          .find((event) => event.type === 'turn.finished' && event.payload.turnId === pr.turnId),
      'PR fixture turn finished',
      45_000,
    );
    expect(prFinished?.payload).toMatchObject({ outcome: 'completed' });
    expect(prQuery).toEqual({ section: 'checks', target: 'commit', format: 'markdown', commit });
    expect(readFileSync(join(cwd, '.git', 'submitted-body.md'), 'utf8')).toEqual(
      `Update the sample.\n\n### 检查 · \`${commit.slice(0, 12)}\`\n\n- Lint · 通过\n- Typecheck · 未运行\n`,
    );
  }, 60_000);
});
