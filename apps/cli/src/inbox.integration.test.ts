// wevir inbox 对着进程内的真实 Host（startHost + EchoAdapter）：列出等处理的审批、--json、收起与不能收起的审批，以及旧 Host 的说明。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import type { InboxItem } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { requireInbox } from './commands/inbox.js';
import { describeError } from './errors.js';
import { setLocale } from './i18n/index.js';
import { run, startEchoHost, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
  setLocale('zh');
});

async function setup() {
  const home = join(tempDir(), 'home');
  const project = join(tempDir(), 'project');
  mkdirSync(project);
  host = await startEchoHost(home);
  const added = await run(
    [
      'provider',
      'add',
      '--kind',
      'openai-compatible',
      '--id',
      'echo-test',
      '--base-url',
      'http://127.0.0.1:9/v1',
      '--model',
      'echo-model',
    ],
    { home, input: 'sk-test\n' },
  );
  expect(added.code, added.err).toBe(0);
  return { home, project };
}

async function items(home: string): Promise<InboxItem[]> {
  const result = await run(['inbox', '--json'], { home });
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as InboxItem[];
}

describe('wevir inbox', () => {
  it('列出等处理的审批；--json 是 inbox.list 的项；审批不能收起', async () => {
    const { home, project } = await setup();
    expect((await run(['inbox'], { home })).out).toContain('没有等处理的事');

    const created = await run(['session', 'new', '-w', project, '--detach', 'please approve'], {
      home,
    });
    expect(created.code, created.err).toBe(0);
    const deadline = Date.now() + 10_000;
    let listed = await items(home);
    while (listed.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      listed = await items(home);
    }
    const [item] = listed;
    expect(item).toMatchObject({ kind: 'approval', summary: '/outside-workspace/echo.txt' });

    const table = await run(['inbox', 'list'], { home });
    expect(table.code, table.err).toBe(0);
    expect(table.out).toMatch(/ID\s+种类\s+会话\s+说明\s+时间/);
    expect(table.out).toContain(`${item?.id}  审批`);

    const refused = await run(['inbox', 'dismiss', item?.id ?? ''], { home });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('cannot be dismissed');

    const gone = await run(['inbox', 'dismiss', 'turn_failed:trn_gone'], { home });
    expect(gone.code, gone.err).toBe(0);
    expect(gone.out).toContain('已收起 turn_failed:trn_gone');
  });

  it('旧 Host 没有 inbox 功能时说明要升级', () => {
    const old = {
      supports: () => false,
      hello: { hostVersion: '0.102.0' },
    } as unknown as Parameters<typeof requireInbox>[0];
    let thrown: unknown;
    try {
      requireInbox(old);
    } catch (error) {
      thrown = error;
    }
    expect(describeError(thrown)).toEqual({
      message: 'Host 0.102.0 不支持收件箱',
      hint: '升级 Wevir Host（需要协议 0.103.0）',
    });
  });
});
