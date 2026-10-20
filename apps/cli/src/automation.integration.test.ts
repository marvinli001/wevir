// wevir automation 的命令对着进程内的真实 Host（startHost + EchoAdapter）：建、列、看、改、启停、运行与删除，
// 以及选项检查与 --json。计划、时区的换算本身在 commands/automation.test.ts。

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import type { Automation, AutomationRun } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { run, startEchoHost, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
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

async function list(home: string): Promise<Automation[]> {
  const result = await run(['automation', 'list', '--json'], { home });
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as Automation[];
}

async function waitForRun(home: string, id: string, status: AutomationRun['status']) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const shown = await run(['automation', 'show', id, '--json'], { home });
    const { runs } = JSON.parse(shown.out) as { runs: AutomationRun[] };
    if (runs[0]?.status === status) return runs;
    if (Date.now() > deadline) throw new Error(`运行没有到 ${status}：${shown.out}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('wevir automation', () => {
  it('create：计划选项、--project 登记目录、指令来自参数或 stdin', async () => {
    const { home, project } = await setup();
    const empty = await run(['automation', 'list'], { home });
    expect(empty.out).toContain('暂无自动化');

    const daily = await run(
      [
        'automation',
        'create',
        '--title',
        '每日站会',
        '--daily',
        '9:00',
        '--days',
        'weekdays',
        '--project',
        project,
        '--timezone',
        'Asia/Shanghai',
        '汇总昨天以来的提交',
      ],
      { home },
    );
    expect(daily.code, daily.err).toBe(0);
    expect(daily.out).toContain('已添加工作区 project');
    expect(daily.out).toMatch(/已创建自动化：每日站会（aut_\w+）/);
    expect(daily.out).toMatch(/工作日 09:00 · 下次运行 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    const monthly = await run(
      [
        'automation',
        'create',
        '--title',
        '依赖检查',
        '--monthly',
        '1',
        '10:00',
        '--permission',
        'full-access',
        '--same-session',
        '--notify',
        'never',
        '--model',
        'm1',
        '--effort',
        'high',
        '--disabled',
      ],
      { home, input: '第一行\n第二行\n' },
    );
    expect(monthly.code, monthly.err).toBe(0);
    expect(monthly.out).toContain('每月 1 日 10:00 · 已停用');
    expect(monthly.out).toContain('无人值守时以完全访问运行');

    const json = await run(
      ['automation', 'create', '--title', '间隔', '--every', '30', '--json', '查看', '队列'],
      { home },
    );
    expect(json.code, json.err).toBe(0);
    const interval = JSON.parse(json.out) as Automation;
    expect(interval).toMatchObject({
      title: '间隔',
      prompt: '查看 队列',
      schedule: { kind: 'interval', minutes: 30 },
      providerId: 'echo-test',
      permissionMode: 'on_request',
      newSessionEachRun: true,
      enabled: true,
    });

    const all = await list(home);
    expect(all.map((a) => a.title)).toEqual(['间隔', '依赖检查', '每日站会']);
    const [, check, standup] = all as [Automation, Automation, Automation];
    expect(standup).toMatchObject({
      schedule: { kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] },
      timezone: 'Asia/Shanghai',
      prompt: '汇总昨天以来的提交',
    });
    expect(standup.workspaceId).toMatch(/^ws_/);
    expect(check).toMatchObject({
      prompt: '第一行\n第二行',
      schedule: { kind: 'monthly', day: 1, time: '10:00' },
      permissionMode: 'full_access',
      newSessionEachRun: false,
      notify: 'never',
      modelId: 'm1',
      reasoningEffort: 'high',
      enabled: false,
    });

    const table = await run(['automation', 'list'], { home });
    expect(table.out).toMatch(/ID\s+状态\s+名称\s+计划\s+下次运行\s+上次运行/);
    expect(table.out).toMatch(/已停用\s+依赖检查\s+每月 1 日 10:00\s+-\s+-/);
    expect(table.out).toMatch(/已启用\s+间隔\s+每 30 分钟/);
  });

  it('update 只改给出的选项；enable / disable；按前缀找自动化', async () => {
    const { home } = await setup();
    await run(['automation', 'create', '--title', '提醒', '--daily', '08:00', '喝水'], { home });
    const [created] = (await list(home)) as [Automation];
    const prefix = created.id.slice('aut_'.length, 'aut_'.length + 20);

    const updated = await run(
      ['automation', 'update', prefix, '--title', '提醒 2', '--every', '60', '--notify', 'always'],
      { home },
    );
    expect(updated.code, updated.err).toBe(0);
    expect(updated.out).toContain('已更新自动化：提醒 2');
    const stdin = await run(['automation', 'update', created.id, '--prompt', '-'], {
      home,
      input: '站起来\n',
    });
    expect(stdin.code, stdin.err).toBe(0);
    let [after] = (await list(home)) as [Automation];
    expect(after).toMatchObject({
      title: '提醒 2',
      prompt: '站起来',
      schedule: { kind: 'interval', minutes: 60 },
      notify: 'always',
      permissionMode: 'on_request',
    });

    await run(['automation', 'update', created.id, '--model', 'm2', '--effort', 'low'], { home });
    await run(['automation', 'update', created.id, '--default-model', '--default-effort'], {
      home,
    });
    [after] = (await list(home)) as [Automation];
    expect(after.modelId).toBeUndefined();
    expect(after.reasoningEffort).toBeUndefined();

    const disabled = await run(['automation', 'disable', created.id], { home });
    expect(disabled.out).toContain('已停用：提醒 2');
    [after] = (await list(home)) as [Automation];
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeUndefined();
    const enabled = await run(['automation', 'enable', created.id], { home });
    expect(enabled.out).toContain('已启用：提醒 2');
    expect(enabled.out).toMatch(/下次运行 \d{4}-/);

    const nothing = await run(['automation', 'update', created.id], { home });
    expect(nothing.code).toBe(2);
    expect(nothing.err).toContain('错误：未给出要修改的选项');
    expect(nothing.err).toContain('下一步：运行 wevir automation update --help');
  });

  it('run 开会话并记下运行；show 显示设置与运行记录；delete 删除', async () => {
    const { home } = await setup();
    await run(['automation', 'create', '--title', '汇报', '--same-session', '今天做了什么'], {
      home,
    });
    const [created] = (await list(home)) as [Automation];

    const started = await run(['automation', 'run', created.id], { home });
    expect(started.code, started.err).toBe(0);
    expect(started.out).toMatch(/已开始运行：汇报（arn_\w+）/);
    expect(started.out).toMatch(/下一步：wevir session attach ses_\w+/);
    const runs = await waitForRun(home, created.id, 'completed');
    expect(runs[0]).toMatchObject({ trigger: 'manual', summary: expect.stringContaining('Echo') });

    const shown = await run(['automation', 'show', created.id], { home });
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain(`汇报  ${created.id}`);
    expect(shown.out).toMatch(/计划\s+手动运行/);
    expect(shown.out).toMatch(/项目\s+不在项目中/);
    expect(shown.out).toMatch(/模型\s+echo-test\/默认模型/);
    expect(shown.out).toMatch(/运行于\s+同一会话 ses_\w+/);
    expect(shown.out).toContain('指令\n  今天做了什么');
    expect(shown.out).toMatch(/手动\s+已完成\s+ses_\w+\s+Echo/);

    const deleted = await run(['automation', 'delete', created.id], { home });
    expect(deleted.code, deleted.err).toBe(0);
    expect(deleted.out).toContain(`已删除自动化：汇报（${created.id}）`);
    const gone = await run(['automation', 'show', created.id], { home });
    expect(gone.code).toBe(1);
    expect(gone.err).toContain(`错误：没有自动化 ${created.id}`);
    expect(gone.err).toContain('下一步：运行 wevir automation list 查看');
  });

  it('检查脚本：不唤醒时记“无变化”、不开会话；唤醒时把输出附给 Agent；test-check 试跑', async () => {
    const { home, project } = await setup();
    const created = await run(
      [
        'automation',
        'create',
        '--title',
        '等发布',
        '--project',
        project,
        '--check',
        'test -f released && echo v1.2.0 || exit 1',
        '--json',
        '说明新版本',
      ],
      { home },
    );
    expect(created.code, created.err).toBe(0);
    // --project 登记新目录时先打一行说明，JSON 在它后面。
    const automation = JSON.parse(created.out.slice(created.out.indexOf('{'))) as Automation;
    expect(automation.check).toEqual({
      command: 'test -f released && echo v1.2.0 || exit 1',
      wake: 'exit_code',
    });

    const tried = await run(['automation', 'test-check', automation.id], { home });
    expect(tried.code, tried.err).toBe(0);
    expect(tried.out).toMatch(/不唤醒\s+退出码 1/);

    const started = await run(['automation', 'run', automation.id], { home });
    expect(started.code, started.err).toBe(0);
    expect(started.out).toMatch(/正在检查：等发布（arn_\w+）/);
    let runs = await waitForRun(home, automation.id, 'silent');
    expect(runs[0]).toMatchObject({ check: { decision: 'silent', exitCode: 1 } });
    expect(runs[0]?.sessionId).toBeUndefined();

    writeFileSync(join(project, 'released'), '');
    await run(['automation', 'run', automation.id], { home });
    runs = await waitForRun(home, automation.id, 'completed');
    expect(runs[0]).toMatchObject({
      // Windows 的 cmd 把 `||` 前的空格也算进 echo 的输出。
      check: { decision: 'wake', exitCode: 0, output: expect.stringMatching(/^v1\.2\.0 ?\n$/) },
      sessionId: expect.stringMatching(/^ses_/),
    });
    // Echo 引擎原样回显收到的消息：指令后面附着检查输出。
    expect(runs[0]?.summary).toContain('<check_output command=');
    expect(runs[0]?.summary).toContain('v1.2.0');

    const shown = await run(['automation', 'show', automation.id], { home });
    expect(shown.out).toMatch(/检查脚本\s+test -f released .*（退出码 0 唤醒）/);
    expect(shown.out).toMatch(/手动\s+无变化/);

    const removed = await run(['automation', 'update', automation.id, '--no-check', '--json'], {
      home,
    });
    expect((JSON.parse(removed.out) as Automation).check).toBeUndefined();
  });

  it('--session 发进已有会话，用它的项目与模型', async () => {
    const { home, project } = await setup();
    const session = await run(['session', 'new', '-w', project, '--detach', 'hello'], { home });
    expect(session.code, session.err).toBe(0);
    const sessionId = /已创建会话 (ses_\w+)/.exec(session.out)?.[1] as string;
    const created = await run(
      ['automation', 'create', '--title', '跟进', '--session', sessionId, '--json', '继续'],
      { home },
    );
    expect(created.code, created.err).toBe(0);
    const automation = JSON.parse(created.out) as Automation;
    expect(automation).toMatchObject({
      sessionId,
      newSessionEachRun: false,
      providerId: 'echo-test',
      workspaceId: expect.stringMatching(/^ws_/),
    });
    // attach 等到这个会话的回合结束。
    const attached = await run(['session', 'attach', sessionId], { home });
    expect(attached.out).toContain('空闲');
    await run(['automation', 'run', automation.id], { home });
    const runs = await waitForRun(home, automation.id, 'completed');
    expect(runs[0]?.sessionId).toBe(sessionId);
    // 不是自动化开的会话：消息前面一行说明。
    expect(runs[0]?.summary).toContain('[Wevir automation "跟进"');

    const fresh = await run(['automation', 'update', automation.id, '--new-session', '--json'], {
      home,
    });
    expect(JSON.parse(fresh.out)).toMatchObject({ newSessionEachRun: true });
    expect((JSON.parse(fresh.out) as Automation).sessionId).toBeUndefined();
  });

  it('选项与指令的用法错误；Host 拒绝的参数', async () => {
    const { home } = await setup();
    const cases: Array<[string[], string, string]> = [
      [['--daily', '9'], '--daily 需为 HH:MM：9', 'automation create'],
      [['--every', '3'], '--every 需为不小于 5 的整数（分钟）：3', 'automation create'],
      [['--manual', '--daily', '09:00'], '计划选项只能给一个：--manual、--daily', ''],
      [['--days', 'mon'], '--days 只能与 --daily 一起使用', ''],
      [['--daily', '09:00', '--days', 'funday'], '无法识别的星期：funday', ''],
      [['--once', 'tomorrow'], '--once 需为日期与时间', ''],
      [['--once', '2020-01-01T09:00'], '--once 的时间已过', ''],
      [['--monthly', '32', '09:00'], '--monthly 需为 <日> <HH:MM>', ''],
      [['--permission', 'root'], '未知权限模式：root', ''],
      [['--notify', 'sometimes'], '未知提醒方式：sometimes', ''],
    ];
    for (const [flags, message, help] of cases) {
      const result = await run(['automation', 'create', '--title', 't', ...flags, 'p'], { home });
      expect(result.code, flags.join(' ')).toBe(2);
      expect(result.err).toContain(`错误：${message}`);
      if (help) expect(result.err).toContain(`下一步：运行 wevir ${help} --help`);
    }
    const noTitle = await run(['automation', 'create', 'p'], { home });
    expect(noTitle.err).toContain('错误：缺少 --title <名称>');
    const noPrompt = await run(['automation', 'create', '--title', 't'], { home });
    expect(noPrompt.code).toBe(2);
    expect(noPrompt.err).toContain('错误：缺少指令');
    const badZone = await run(
      ['automation', 'create', '--title', 't', '--timezone', 'Mars/Base', 'p'],
      { home },
    );
    expect(badZone.code).toBe(1);
    expect(badZone.err).toContain('unknown time zone Mars/Base');
    const noProvider = await run(
      ['automation', 'create', '--title', 't', '--provider', 'nope', 'p'],
      { home },
    );
    expect(noProvider.err).toContain('Provider nope 不存在');
    expect(await list(home)).toEqual([]);
    const missing = await run(['automation', 'run', 'zzz'], { home });
    expect(missing.err).toContain('错误：没有自动化 zzz');
  });
});
