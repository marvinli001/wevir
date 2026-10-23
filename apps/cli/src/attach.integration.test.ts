// attach 的交互（提问、总是允许、斜杠命令）与审批规则命令，对着进程内的 echo Host。命令审批用 ShellEchoAdapter：
// `approve: <命令>` 让 echo 发一条 shell 审批，Host 据此提议规则。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeRun,
  run,
  runFake,
  ShellEchoAdapter,
  startEchoHost,
  useTempDir,
} from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
const running: FakeRun[] = [];
afterEach(async () => {
  for (const fake of running.splice(0)) {
    fake.stdin.end('\x04');
    fake.interrupt();
    fake.interrupt();
    await fake.exit;
  }
  await host?.shutdown();
  host = undefined;
});

function fake(argv: string[], options: Parameters<typeof runFake>[1]): FakeRun {
  const f = runFake(argv, options);
  running.push(f);
  return f;
}

async function setup(shell = false) {
  const home = join(tempDir(), 'home');
  const workspace = join(tempDir(), 'project');
  mkdirSync(workspace);
  host = await startEchoHost(home, {}, shell ? ShellEchoAdapter : undefined);
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
    { home, input: 'sk-from-stdin\n' },
  );
  expect(added.code, added.err).toBe(0);
  return { home, workspace };
}

describe('attach：Agent 的提问', () => {
  it('管道里逐题回答：单选序号、多选逗号分隔', async () => {
    const { home, workspace } = await setup();
    const result = await run(['session', 'new', '-w', workspace, 'please ask me'], {
      home,
      input: '2\n1, 3\n',
    });
    expect(result.code, result.err).toBe(0);
    for (const line of [
      '? Agent 提问',
      '  Scope：How far should this change go?',
      '    2) Full stack — Protocol, Host and UI together',
      '✓ 已回答：scope=Full stack；targets=macOS、Linux',
      'Answers: scope=Full stack; targets=macOS, Linux',
      '── 本轮完成',
    ]) {
      expect(result.out).toContain(line);
    }
  });

  it('终端里：输入框显示第几题，文字作答、回车跳过，认不出的回答给出提示', async () => {
    const { home, workspace } = await setup();
    const a = fake(['session', 'new', '-w', workspace, 'please ask me'], { home, tty: true });
    let at = await a.waitFor('回答 1/2 [1–2 / 文字 / 回车跳过] › ');
    a.stdin.write('Docs only\r');
    at = await a.waitFor('回答 2/2 [1–3 可多选 / 回车跳过] › ', at);
    a.stdin.write('7\r');
    at = await a.waitFor('输入 1–3，多个用逗号分隔；回车跳过', at);
    a.stdin.write('\r');
    at = await a.waitFor('✓ 已回答：scope=Docs only；targets=（跳过）', at);
    await a.waitFor('Answers: scope=Docs only; targets=', at);
  });
});

describe('attach：总是允许与审批规则', () => {
  it('a 总是允许（本项目）：加规则，之后同前缀的命令由 Host 允许；rule list / delete', async () => {
    const { home, workspace } = await setup(true);
    const a = fake(['session', 'new', '-w', workspace, 'approve: git status --short'], {
      home,
      tty: true,
    });
    let at = await a.waitFor('总是允许：git status 开头的命令（a 本项目 / g 所有项目）');
    at = await a.waitFor(
      '审批 [1 允许一次 / 2 拒绝 / a 总是允许·本项目 / g 总是允许·所有项目] › ',
      at,
    );
    a.stdin.write('a\r');
    at = await a.waitFor('✓ 本终端已处理：允许一次（已加规则）', at);
    at = await a.waitFor('── 本轮完成', at);
    a.stdin.write('approve: git status\r');
    at = await a.waitFor('已按规则允许', at);
    await a.waitFor('── 本轮完成', at);

    const list = await run(['rule', 'list'], { home });
    expect(list.code, list.err).toBe(0);
    expect(list.out).toMatch(/ID\s+命令前缀\s+范围\s+自动允许\s+最近使用/);
    expect(list.out).toMatch(/arl_\w+\s+git status\s+project\s+1\s+\d{4}-/);
    const json = await run(['rule', 'list', '-w', workspace, '--json'], { home });
    const rules = JSON.parse(json.out) as Array<{ id: string; prefix: string[] }>;
    expect(rules.map((rule) => rule.prefix)).toEqual([['git', 'status']]);
    const deleted = await run(['rule', 'delete', rules[0]?.id as string], { home });
    expect(deleted.out).toContain(`已删除规则：${rules[0]?.id}`);
    const again = await run(['rule', 'delete', rules[0]?.id as string], { home });
    expect(again.code).toBe(1);
    expect(again.out).toContain('规则不存在');
    expect((await run(['rule', 'list'], { home })).out).toContain('暂无审批规则');
  });

  it('rule add 全局与项目规则；解释器之类的前缀被拒绝；rule suggest', async () => {
    const { home, workspace } = await setup(true);
    await run(['workspace', 'add', workspace], { home });
    const global = await run(['rule', 'add', 'npm', 'test'], { home });
    expect(global.code, global.err).toBe(0);
    expect(global.out).toMatch(/已添加规则：npm test（所有项目，arl_\w+）/);
    const project = await run(['rule', 'add', 'cargo check', '-w', workspace], { home });
    expect(project.out).toMatch(/已添加规则：cargo check（project，arl_\w+）/);
    const bad = await run(['rule', 'add', 'sudo'], { home });
    expect(bad.code).toBe(1);
    const suggest = await run(['rule', 'suggest'], { home });
    expect(suggest.code, suggest.err).toBe(0);
    expect(suggest.out).toContain('暂无建议');
  });

  it('inbox respond --remember global：回答审批并加全局规则', async () => {
    const { home, workspace } = await setup(true);
    const created = await run(
      ['session', 'new', '-w', workspace, '--detach', 'approve: make lint'],
      { home },
    );
    expect(created.code, created.err).toBe(0);
    let id: string | undefined;
    for (let i = 0; i < 200 && id === undefined; i++) {
      const listed = await run(['inbox', '--json'], { home });
      id = (JSON.parse(listed.out) as Array<{ id: string; kind: string }>).find(
        (item) => item.kind === 'approval',
      )?.id;
      if (id === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const bad = await run(['inbox', 'respond', id as string, 'y', '--remember', 'forever'], {
      home,
    });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--remember 只能是 project 或 global');
    const responded = await run(['inbox', 'respond', id as string, 'y', '--remember', 'global'], {
      home,
    });
    expect(responded.code, responded.err).toBe(0);
    expect((await run(['rule', 'list'], { home })).out).toMatch(/make lint\s+所有项目/);
  });
});

describe('attach：斜杠命令', () => {
  it('/plan、/model、/permission、/effort、/rename、/help、未知命令与 //', async () => {
    const { home, workspace } = await setup();
    const a = fake(['session', 'new', '-w', workspace, 'hello'], { home, tty: true });
    let at = await a.waitFor('── 本轮完成');
    a.stdin.write('/plan draft it\r');
    at = await a.waitFor('› draft it（计划模式）', at);
    at = await a.waitFor('Echo (plan): draft it', at);
    at = await a.waitFor('▣ 计划', at);
    at = await a.waitFor('── 本轮完成', at);
    a.stdin.write('/model\r');
    at = await a.waitFor('模型 echo-test/echo-model · 推理 默认 · 请求批准', at);
    at = await a.waitFor('  ● echo-model', at);
    a.stdin.write('/permission full_access\r');
    at = await a.waitFor('（设置：echo-model · 完全访问）', at);
    a.stdin.write('/permission sometimes\r');
    at = await a.waitFor('未知权限模式：sometimes', at);
    a.stdin.write('/effort high\r');
    at = await a.waitFor('（设置：echo-model · high · 完全访问）', at);
    a.stdin.write('/effort default\r');
    at = await a.waitFor('（设置：echo-model · 完全访问）', at);
    a.stdin.write('/rename Greeting\r');
    at = await a.waitFor('已改名：Greeting', at);
    a.stdin.write('/help\r');
    at = await a.waitFor('/undo', at);
    at = await a.waitFor('退出 attach，会话照常运行', at);
    a.stdin.write('/nope\r');
    at = await a.waitFor('未知命令：/nope', at);
    at = await a.waitFor('以 // 开头按原文发送', at);
    a.stdin.write('//etc/hosts\r');
    at = await a.waitFor('Echo: /etc/hosts', at);
    await a.waitFor('── 本轮完成', at);
    const list = await run(['session', 'list'], { home });
    expect(list.out).toContain('Greeting');
  });

  it('/undo、/redo、/fork、/goal', async () => {
    const { home, workspace } = await setup();
    const a = fake(['session', 'new', '-w', workspace, 'first turn'], { home, tty: true });
    let at = await a.waitFor('── 本轮完成');
    a.stdin.write('/undo\r');
    at = await a.waitFor('↶ 已撤销回合：', at);
    a.stdin.write('/redo\r');
    at = await a.waitFor('↷ 已重做回合：', at);
    a.stdin.write('/fork\r');
    at = await a.waitFor(/已分支到新会话 ses_\w+；连接：wevir session attach ses_\w+/, at);
    a.stdin.write('/goal\r');
    at = await a.waitFor('暂无目标', at);
    a.stdin.write('/goal clear\r');
    at = await a.waitFor('暂无目标', at);
  });

  it('session send --plan 与 session new --plan', async () => {
    const { home, workspace } = await setup();
    const created = await run(['session', 'new', '-w', workspace, '--plan', 'make a plan'], {
      home,
    });
    expect(created.code, created.err).toBe(0);
    expect(created.out).toContain('› make a plan（计划模式）');
    expect(created.out).toContain('Echo (plan): make a plan');
    const id = /已创建会话 (ses_\w+)/.exec(created.out)?.[1] as string;
    const sent = await run(['session', 'send', id, '--plan', 'and another'], { home });
    expect(sent.code, sent.err).toBe(0);
    const attached = await run(['session', 'attach', id], { home });
    expect(attached.out).toContain('› and another（计划模式）');
  });
});
