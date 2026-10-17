import type { ChatPart } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import {
  currentAction,
  editStats,
  groupWork,
  isLiveEntry,
  isWebSearch,
  outputSummary,
  type ReasoningPart,
  relativeToRoot,
  type ToolPart,
  tallyWork,
  thoughtLine,
  toolLifecycle,
  toolLine,
  toolSummary,
  type WorkEntry,
  workIssues,
  workSummary,
  workSummaryParts,
} from './tool-model';

const TS = '2026-10-13T08:00:00.000Z';

function tool(
  id: string,
  kind: ToolPart['display']['kind'],
  extra: Partial<ToolPart> = {},
): ToolPart {
  return {
    type: 'tool',
    key: `t:${id}`,
    toolCallId: id,
    toolName: kind,
    display: { kind },
    status: 'completed',
    input: {},
    startedAt: TS,
    ...extra,
  };
}

const at = (seconds: number) => new Date(Date.parse(TS) + seconds * 1000).toISOString();

function thought(key: string, from = 0, to = 3, extra: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    type: 'reasoning',
    key,
    text: key,
    state: 'done',
    startedAt: at(from),
    endedAt: at(to),
    ...extra,
  };
}

const text = (key: string): ChatPart => ({ type: 'text', key, text: key, state: 'done' });
const denied = { approvalId: 'apr_x' as const, status: 'denied' as const, options: [] };

describe('toolLifecycle', () => {
  it('未收尾的工具只在回合进行中算运行中 / 等待审批，否则状态未知', () => {
    expect(toolLifecycle(tool('a', 'shell', { status: 'running' }), true)).toBe('running');
    expect(toolLifecycle(tool('a', 'shell', { status: 'awaiting_approval' }), true)).toBe(
      'awaiting_approval',
    );
    expect(toolLifecycle(tool('a', 'shell', { status: 'running' }), false)).toBe('unknown');
    expect(toolLifecycle(tool('a', 'shell', { status: 'awaiting_approval' }), false)).toBe(
      'unknown',
    );
  });

  it('审批被拒的工具显示被拒绝；其余收尾状态原样', () => {
    expect(toolLifecycle(tool('a', 'write', { status: 'failed', approval: denied }), true)).toBe(
      'denied',
    );
    expect(toolLifecycle(tool('a', 'write', { status: 'failed' }), true)).toBe('failed');
    expect(toolLifecycle(tool('a', 'write', { status: 'cancelled' }), false)).toBe('cancelled');
    expect(toolLifecycle(tool('a', 'write', { status: 'unknown' }), true)).toBe('unknown');
  });
});

describe('toolSummary / outputSummary', () => {
  it('摘要依次取 summary、command、paths、query、url，再退到输入里的第一个字符串', () => {
    expect(
      toolSummary(tool('a', 'shell', { display: { kind: 'shell', command: 'ls\n-la' } })),
    ).toBe('ls');
    expect(toolSummary(tool('a', 'read', { display: { kind: 'read', paths: ['a', 'b'] } }))).toBe(
      'a b',
    );
    expect(toolSummary(tool('a', 'unknown', { input: { n: 1, note: ' 第一行\n第二行' } }))).toBe(
      '第一行',
    );
    expect(toolSummary(tool('a', 'unknown'))).toBeUndefined();
  });

  it('结果摘要是第一行非空文字', () => {
    const output = { text: '\n\n  Found 5 matches\nmore', truncated: false };
    expect(outputSummary(tool('a', 'search', { output }))).toBe('Found 5 matches');
    expect(outputSummary(tool('a', 'search'))).toBeUndefined();
  });
});

describe('editStats', () => {
  it('Codex 的 fileChange：新建与删除按全文计，修改按统一 diff 计（不算文件头）', () => {
    const input = {
      type: 'fileChange',
      changes: [
        { path: 'new.ts', kind: { type: 'add' }, diff: 'a\nb\nc\n' },
        { path: 'old.ts', kind: { type: 'delete' }, diff: 'x\ny\n' },
        {
          path: 'mod.ts',
          kind: { type: 'update', move_path: null },
          diff: '--- a/mod.ts\n+++ b/mod.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n+more\n',
        },
      ],
    };
    expect(editStats(tool('a', 'edit', { input }))).toEqual({ added: 5, removed: 3 });
  });

  it('dsh 的 edit 去掉首尾相同的行再计，write 全算新增；读不出时为 undefined', () => {
    expect(
      editStats(tool('a', 'edit', { input: { old_string: 'a\nb\nc', new_string: 'a\nB\nB2\nc' } })),
    ).toEqual({ added: 2, removed: 1 });
    expect(editStats(tool('a', 'write', { input: { content: 'one\ntwo' } }))).toEqual({
      added: 2,
      removed: 0,
    });
    expect(
      editStats(tool('a', 'edit', { input: { $truncated: true, originalLength: 9, preview: '' } })),
    ).toBeUndefined();
    expect(editStats(tool('a', 'shell', { input: { content: 'x' } }))).toBeUndefined();
  });
});

describe('groupWork', () => {
  it('连续的思考与各种工具合成一组；正文、错误、待办断开；子智能体标记并成一行', () => {
    const subagent = (key: string): ChatPart => ({
      type: 'subagent',
      key,
      subagent: {} as never,
    });
    const items = groupWork([
      thought('r0'),
      tool('1', 'read'),
      thought('r1'),
      tool('2', 'shell'),
      tool('3', 'edit'),
      text('say'),
      tool('4', 'search'),
      subagent('a:1'),
      subagent('a:2'),
      { type: 'error', key: 'e', category: 'unknown', message: 'x', fatal: false },
      thought('r2'),
      text('answer'),
    ]);
    expect(
      items.map((item) =>
        item.kind === 'work'
          ? [item.key, item.entries.map((entry) => entry.key)]
          : item.kind === 'subagents'
            ? [item.key, item.parts.map((part) => part.key)]
            : item.part.key,
      ),
    ).toEqual([
      ['w:r0', ['r0', 't:1', 'r1', 't:2', 't:3']],
      'say',
      ['w:t:4', ['t:4']],
      ['a:a:1', ['a:1', 'a:2']],
      'e',
      ['w:r2', ['r2']],
      'answer',
    ]);
  });
});

describe('groupWork：开发模式的调试信息', () => {
  it('不断开工作组；夹在子智能体标记之间的挪到那一行后面；只有调试信息时摘要写条数', () => {
    const raw = (key: string): ChatPart => ({
      type: 'raw',
      key,
      method: 'turn/diff/updated',
      params: {},
    });
    const subagent = (key: string): ChatPart => ({ type: 'subagent', key, subagent: {} as never });
    const items = groupWork([
      tool('1', 'shell'),
      raw('x1'),
      tool('2', 'shell'),
      subagent('a:1'),
      raw('x2'),
      subagent('a:2'),
      text('answer'),
    ]);
    expect(
      items.map((item) =>
        item.kind === 'work'
          ? item.entries.map((entry) => entry.key)
          : item.kind === 'subagents'
            ? item.parts.map((part) => part.key)
            : item.part.key,
      ),
    ).toEqual([['t:1', 'x1', 't:2'], ['a:1', 'a:2'], ['x2'], 'answer']);
    const debugOnly = items[2];
    expect(debugOnly?.kind === 'work' && workSummary(tallyWork(debugOnly.entries, false))).toBe(
      '1 条调试信息',
    );
  });
});

describe('工作组的摘要', () => {
  it('各种工具混排、思考夹在中间：思考用时相加，读取与修改按不同路径计文件，增删行只算成功的修改', () => {
    const entries: WorkEntry[] = [
      thought('r0', 0, 12),
      tool('1', 'read', { display: { kind: 'read', paths: ['a.ts'] } }),
      tool('2', 'read', { display: { kind: 'read', paths: ['a.ts', 'b.ts'] } }),
      thought('r1', 20, 25),
      tool('3', 'search'),
      tool('4', 'search'),
      tool('5', 'edit', {
        display: { kind: 'edit', paths: ['a.ts'] },
        input: { old_string: 'x', new_string: 'y\nz' },
      }),
      tool('6', 'write', {
        display: { kind: 'write', paths: ['c.ts'] },
        input: { content: '1\n2\n3' },
      }),
      tool('7', 'shell'),
      tool('8', 'fetch'),
      tool('9', 'unknown'),
      tool('10', 'plan'),
    ];
    const tally = tallyWork(entries, false);
    expect(tally.thinkingMs).toBe(17_000);
    expect(tally.lines).toEqual({ added: 5, removed: 1 });
    expect(workSummary(tally)).toBe(
      '思考了 17 秒，读取了 2 个文件，搜索了 2 次，修改了 2 个文件，运行了 1 条命令，获取了 1 个网页，更新了计划，调用了 1 个工具',
    );
    expect(workIssues(tally.issues)).toEqual([]);
  });

  it('失败、被拒绝、状态未知单独计数；失败的修改不算行数；没有思考时不写思考', () => {
    const tally = tallyWork(
      [
        tool('1', 'shell', { status: 'failed' }),
        tool('2', 'edit', {
          status: 'failed',
          approval: denied,
          input: { old_string: 'a', new_string: 'b' },
        }),
        tool('3', 'shell', { status: 'running' }),
      ],
      false,
    );
    expect(tally.lines).toBeUndefined();
    expect(workSummary(tally)).toBe('修改了 1 个文件，运行了 2 条命令');
    expect(workIssues(tally.issues)).toEqual([
      { kind: 'failed', text: '1 个失败' },
      { kind: 'denied', text: '1 个被拒绝' },
      { kind: 'unknown', text: '1 个状态未知' },
    ]);
  });
});

describe('工作组的摘要：文件名与思考（U16）', () => {
  it('只涉及一个文件时写出文件名；Codex 补丁里新建的文件单独算“创建了”', () => {
    const one = tallyWork(
      [
        tool('1', 'read', { display: { kind: 'read', paths: ['/w/README.md'] } }),
        tool('2', 'edit', { display: { kind: 'edit', paths: ['/w/src/index.ts'] } }),
        tool('3', 'shell'),
      ],
      false,
    );
    expect(workSummary(one)).toBe('读取了 README.md，修改了 index.ts，运行了 1 条命令');
    expect(workSummaryParts(one).map((part) => part.file)).toEqual([
      'README.md',
      'index.ts',
      undefined,
    ]);

    const patch = tallyWork(
      [
        tool('1', 'edit', {
          display: { kind: 'edit', paths: ['/w/src/index.ts', '/w/src/index.test.ts'] },
          input: {
            changes: [
              { path: '/w/src/index.ts', kind: { type: 'update' }, diff: '@@\n-a\n+b' },
              { path: '/w/src/index.test.ts', kind: { type: 'add' }, diff: 'x\ny\n' },
            ],
          },
        }),
        tool('2', 'edit', {
          display: { kind: 'edit', paths: ['/w/src/index.test.ts'] },
          input: {
            changes: [{ path: '/w/src/index.test.ts', kind: { type: 'update' }, diff: '' }],
          },
        }),
      ],
      false,
    );
    // 先建后改的只算新建。
    expect(workSummary(patch)).toBe('修改了 index.ts，创建了 index.test.ts');
    expect(patch.lines).toEqual({ added: 3, removed: 1 });
  });

  it('有工具调用时不到 1 秒的思考不写；只有思考时照写，没有用时写“思考过”', () => {
    expect(workSummary(tallyWork([thought('r', 0, 0.4), tool('1', 'shell')], false))).toBe(
      '运行了 1 条命令',
    );
    expect(workSummary(tallyWork([thought('r', 0, 2), tool('1', 'shell')], false))).toBe(
      '思考了 2 秒，运行了 1 条命令',
    );
    expect(workSummary(tallyWork([thought('r', 0, 0.4)], false))).toBe('思考了 0.4 秒');
    expect(workSummary(tallyWork([thought('r', 0, 0)], false))).toBe('思考过');
    expect(thoughtLine(thought('r', 0, 0), true).label).toBe('思考过');
    expect(thoughtLine(thought('r', 0, 0.03), true).label).toBe('思考过');
  });

  it('进行中的那一组里还没结束的：在运行或等审批的工具、还在流出的最后一条思考', () => {
    expect(isLiveEntry(tool('1', 'shell', { status: 'running' }), false, true)).toBe(true);
    expect(isLiveEntry(tool('1', 'shell', { status: 'awaiting_approval' }), true, true)).toBe(true);
    expect(isLiveEntry(tool('1', 'shell'), true, true)).toBe(false);
    const streaming = thought('r', 0, 1, { state: 'streaming' });
    expect(isLiveEntry(streaming, true, true)).toBe(true);
    expect(isLiveEntry(streaming, false, true)).toBe(false);
    expect(isLiveEntry(streaming, true, false)).toBe(false);
  });
});

describe('逐条的一行', () => {
  it('按状态写成“已运行 / 正在运行 / 等待审批：运行 / 运行失败 / 运行被拒绝 / 已取消运行 / 运行状态未知”', () => {
    const shell = (extra: Partial<ToolPart>) =>
      toolLine(
        tool('a', 'shell', { display: { kind: 'shell', command: 'pnpm test' }, ...extra }),
        true,
      );
    expect(shell({})).toEqual({ label: '已运行', target: 'pnpm test', tone: 'done' });
    expect(shell({ status: 'running' })).toMatchObject({ label: '正在运行', tone: 'running' });
    expect(shell({ status: 'awaiting_approval' })).toMatchObject({
      label: '等待审批：运行',
      tone: 'awaiting',
    });
    expect(shell({ status: 'failed' })).toMatchObject({ label: '运行失败', tone: 'failed' });
    expect(shell({ status: 'failed', approval: denied })).toMatchObject({
      label: '运行被拒绝',
      tone: 'failed',
    });
    expect(shell({ status: 'cancelled' })).toMatchObject({ label: '已取消运行', tone: 'muted' });
    expect(shell({ status: 'unknown' })).toMatchObject({ label: '运行状态未知', tone: 'unknown' });
  });

  it('各种类的动词与目标；未知工具显示工具名，计划不带目标', () => {
    const read = tool('a', 'read', { display: { kind: 'read', paths: ['src/a.ts'] } });
    expect(toolLine(read, true)).toMatchObject({
      label: '已读取',
      target: 'a.ts',
      targetTitle: 'src/a.ts',
    });
    expect(toolLine(tool('a', 'write'), true).label).toBe('已写入');
    expect(toolLine(tool('a', 'unknown', { toolName: 'mcp__x__y' }), true)).toMatchObject({
      label: '已调用',
      target: 'mcp__x__y',
    });
    expect(toolLine(tool('a', 'plan', { input: { todos: 'x' } }), true)).toEqual({
      label: '已更新计划',
      tone: 'done',
    });
  });

  it('读取与修改的路径相对工作目录显示，命令原样', () => {
    const root = '/Users/me/proj/';
    const read = tool('a', 'read', {
      display: { kind: 'read', summary: '/Users/me/proj/src/a.ts, /Users/me/other.ts' },
    });
    expect(toolLine(read, true, root).target).toBe('src/a.ts, /Users/me/other.ts');
    const shell = tool('a', 'shell', {
      display: { kind: 'shell', command: 'cat /Users/me/proj/src/a.ts' },
    });
    expect(toolLine(shell, true, root).target).toBe('cat /Users/me/proj/src/a.ts');
    expect(relativeToRoot('/Users/me/proj', root)).toBe('.');
    expect(relativeToRoot('/x/a.ts', undefined)).toBe('/x/a.ts');
  });

  it('有路径时只写文件名（照 Codex），完整路径在提示里；工作区外的长路径也是', () => {
    const root = '/Users/me/proj';
    const edit = tool('a', 'edit', {
      display: {
        kind: 'edit',
        paths: ['/Users/me/proj/src/a.ts', '/Users/me/Library/Wevir/brain/task.md'],
      },
    });
    expect(toolLine(edit, true, root)).toMatchObject({
      label: '已修改',
      target: 'a.ts, task.md',
      targetTitle: 'src/a.ts\n/Users/me/Library/Wevir/brain/task.md',
    });
    // 只有文件名时不重复提示。
    const plain = tool('b', 'read', { display: { kind: 'read', paths: ['README.md'] } });
    expect(toolLine(plain, true, root)).toEqual({
      label: '已读取',
      target: 'README.md',
      tone: 'done',
    });
  });

  it('跑了 2 秒以上的命令（含失败的）在行尾写用时', () => {
    const run = (seconds: number, extra: Partial<ToolPart> = {}) =>
      toolLine(
        tool('a', 'shell', {
          display: { kind: 'shell', command: 'pnpm test' },
          startedAt: at(0),
          finishedAt: at(seconds),
          ...extra,
        }),
        false,
      );
    expect(run(1.5).duration).toBeUndefined();
    expect(run(12)).toMatchObject({ target: 'pnpm test', duration: '12 秒' });
    expect(run(75, { status: 'failed' })).toMatchObject({ tone: 'failed', duration: '1 分 15 秒' });
    expect(run(12, { status: 'cancelled' }).duration).toBeUndefined();
    expect(
      toolLine(tool('r', 'read', { startedAt: at(0), finishedAt: at(30) }), false).duration,
    ).toBeUndefined();
  });

  it('思考：流式进行到一半时“正在思考”，后面已有输出或已提交后写用时', () => {
    const streaming = thought('r', 0, 2.5, { state: 'streaming' });
    expect(thoughtLine(streaming, false)).toEqual({ label: '正在思考', tone: 'running' });
    expect(thoughtLine(streaming, true)).toEqual({ label: '思考了 2.5 秒', tone: 'done' });
    expect(thoughtLine(thought('r', 0, 75), false).label).toBe('思考了 1 分 15 秒');
  });
});

describe('currentAction', () => {
  it('审批中的工具优先，其次最后一个在运行的，都没有时正在思考', () => {
    const command = (id: string, status: ToolPart['status'], cmd: string) =>
      tool(id, 'shell', { status, display: { kind: 'shell', command: cmd } });
    expect(
      currentAction([command('1', 'awaiting_approval', 'touch /x'), command('2', 'running', 'ls')]),
    ).toEqual({ text: '等待审批：运行 touch /x', tone: 'awaiting' });
    expect(
      currentAction([command('1', 'running', 'pnpm lint'), command('2', 'running', 'pnpm test')]),
    ).toEqual({ text: '正在运行 pnpm test', tone: 'running' });
    expect(currentAction([command('1', 'completed', 'ls'), thought('r')])).toEqual({
      text: '正在思考',
      tone: 'running',
    });
  });
});

describe('isWebSearch', () => {
  it('按工具名认出网页搜索；代码搜索与抓取不算', () => {
    const search = (toolName: string) => tool('s', 'search', { toolName });
    for (const name of [
      'mcp__wevir_web__web_search',
      'webSearch',
      'web_search',
      'WebSearch',
      'websearch',
    ]) {
      expect(isWebSearch(search(name)), name).toBe(true);
    }
    expect(isWebSearch(search('grep'))).toBe(false);
    expect(isWebSearch(search('commandExecution'))).toBe(false);
    expect(isWebSearch(tool('f', 'fetch', { toolName: 'mcp__wevir_web__web_fetch' }))).toBe(false);
  });

  it('网页搜索与抓取的一行：已搜索 查询词、已获取 网址', () => {
    const search = tool('s', 'search', {
      toolName: 'mcp__wevir_web__web_search',
      display: { kind: 'search', summary: 'Codex 最新版本', query: 'Codex 最新版本' },
    });
    const fetched = tool('f', 'fetch', {
      toolName: 'mcp__wevir_web__web_fetch',
      display: { kind: 'fetch', summary: 'https://example.com/', url: 'https://example.com/' },
    });
    expect(toolLine(search, false)).toMatchObject({ label: '已搜索', target: 'Codex 最新版本' });
    expect(toolLine(fetched, false)).toMatchObject({
      label: '已获取',
      target: 'https://example.com/',
    });
  });
});
