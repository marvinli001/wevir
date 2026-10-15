// T4.2：wevir 的工作区、Provider 与会话命令对着进程内的真实 Host（startHost + EchoAdapter，真实的事件库与
// WebSocket 服务）。CLI 在进程内运行（runCli），stdin / stdout 是假的，可以假装成终端（readline 的 TTY 路径、
// mute-stream 静音）。分离启动 Host 的子进程形式见 host.integration.test.ts。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCliIdentity } from './identity.js';
import { type FakeRun, run, runFake, startEchoHost, useTempDir } from './test-utils.js';

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

async function setup(echo: Parameters<typeof startEchoHost>[1] = {}) {
  const home = join(tempDir(), 'home');
  const workspace = join(tempDir(), 'project');
  mkdirSync(workspace);
  host = await startEchoHost(home, echo);
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

describe('工作区与 Provider', () => {
  it('workspace add 按真实路径去重，list 列出', async () => {
    const { home, workspace } = await setup();
    const first = await run(['workspace', 'add', 'project'], { home, cwd: tempDir() });
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('已添加工作区：project');
    const again = await run(['workspace', 'add', workspace], { home });
    expect(again.out).toContain('工作区已存在：project');
    const list = await run(['workspace', 'list'], { home });
    expect(list.out).toMatch(/ID\s+名称\s+路径\s+添加于/);
    expect(list.out).toContain('project');
    const missing = await run(['workspace', 'add', join(tempDir(), 'nope')], { home });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('工作区目录不存在');
  });

  it('provider add：非交互时 Key 从 stdin 读一行；--no-key 不设 Key', async () => {
    const { home } = await setup();
    const list = await run(['provider', 'list'], { home });
    expect(list.out).toMatch(/echo-test\s+echo-test\s+openai-compatible\s+echo-model\s+已设置/);
    expect(list.out).not.toContain('sk-from-stdin');
    const noKey = await run(['provider', 'add', '--kind', 'deepseek-official', '--no-key'], {
      home,
    });
    expect(noKey.code, noKey.err).toBe(0);
    expect(noKey.out).toContain('已添加 Provider deepseek-official');
    expect(noKey.out).toContain('Key 未设置');
    const missing = await run(['provider', 'add', '--kind', 'openai-compatible'], { home });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('缺少 --id');
  });

  it('provider add 在终端里逐项询问，Key 不回显', async () => {
    const { home } = await setup();
    const f = fake(['provider', 'add'], { home, tty: true });
    let at = await f.waitFor('选择 [1]');
    f.stdin.write('2\r');
    at = await f.waitFor('Provider ID', at);
    f.stdin.write('kimi\r');
    at = await f.waitFor('显示名称 [kimi]', at);
    f.stdin.write('\r');
    at = await f.waitFor('协议（', at);
    f.stdin.write('\r');
    at = await f.waitFor('服务地址', at);
    f.stdin.write('ftp://nope\r');
    at = await f.waitFor('只支持 http / https 地址', at);
    f.stdin.write('https://api.moonshot.cn/v1\r');
    at = await f.waitFor('默认模型 ID', at);
    f.stdin.write('kimi-k2.6\r');
    at = await f.waitFor('上下文长度', at);
    f.stdin.write('262144\r');
    at = await f.waitFor('API Key（输入不显示）：', at);
    f.stdin.write('sk-very-secret-123\r');
    expect(await f.exit).toBe(0);
    expect(f.out()).toContain('已添加 Provider kimi（kimi，默认模型 kimi-k2.6，Key 已设置）');
    expect(f.out()).not.toContain('sk-very-secret');
    const list = await run(['provider', 'list'], { home });
    expect(list.out).toMatch(
      /kimi\s+kimi\s+openai-compatible\s+kimi-k2\.6\s+已设置\s+https:\/\/api\.moonshot\.cn\/v1/,
    );
  });
});

describe('会话', () => {
  it('session new：建会话、发送、管道里的 y 回答审批，空闲且输入结束后退出', async () => {
    const { home, workspace } = await setup();
    const result = await run(['session', 'new', '-w', workspace, 'tool then approve'], {
      home,
      input: 'y\n',
    });
    expect(result.code, result.err).toBe(0);
    const out = result.out;
    const id = /已创建会话 (ses_\w+)/.exec(out)?.[1];
    expect(id).toBeDefined();
    for (const line of [
      '› tool then approve',
      '● echo echo',
      '  ⎿ echo 完成',
      '⚠ 需要审批：echo_write /outside-workspace/echo.txt',
      '  选项：1) 允许一次  2) 拒绝',
      '✓ 本终端已处理：允许一次',
      '  ⎿ echo_write 完成',
      'Echo: tool then approve',
      '── 本轮完成',
      `已退出 attach；重新连接：wevir session attach ${id}`,
    ]) {
      expect(out).toContain(line);
    }
    const list = await run(['session', 'list'], { home });
    expect(list.out).toContain(id);
    expect(list.out).toMatch(/空闲\s+tool then approve\s+project\s+echo-test\/echo-model/);
    const filtered = await run(['session', 'list', '-w', workspace], { home });
    expect(filtered.out).toContain(id);
  });

  it('子 agent（R4）：attach 显示开始与完成，子 agent 的审批在父会话里回答', async () => {
    const { home, workspace } = await setup();
    const result = await run(['session', 'new', '-w', workspace, 'subagent approve'], {
      home,
      input: 'y\n',
    });
    expect(result.code, result.err).toBe(0);
    for (const line of [
      '› subagent approve',
      '● spawn_agent Helper task: helper approve',
      '↳ 子 agent 启动：Helper task: helper approve（echo-model）',
      '⚠ 需要审批（来自子 agent Helper task: helper approve）：echo_write /outside-workspace/echo.txt',
      '↳ 子 agent 完成：Helper task: helper approve',
      'Echo: subagent approve',
      '── 本轮完成',
    ]) {
      expect(result.out).toContain(line);
    }
    // 子会话不进会话列表。
    const list = await run(['session', 'list'], { home });
    expect(list.out).not.toContain('Helper task');
  });

  it('两端 attach：看到相同的事件；第二端审批，第一端显示“已由 cli/<deviceId> 处理”', async () => {
    const { home, workspace } = await setup();
    const { deviceId } = await loadCliIdentity(home);
    const a = fake(['session', 'new', '-w', workspace, 'please approve'], { home, tty: true });
    // 终端上的输入框会被擦掉重画，位置不单调：A 端只按唯一的文字等待。
    await a.waitFor('审批 [1 允许一次 / 2 拒绝] › ');
    const id = /已创建会话 (ses_\w+)/.exec(a.out())?.[1] as string;

    // 第二端用会话 ID 的前缀 attach，从管道回答审批。
    const b = fake(['session', 'attach', id.slice(0, 20)], { home });
    await b.waitFor('⚠ 需要审批');
    b.stdin.write('1\n');
    await b.waitFor('✓ 本终端已处理：允许一次');
    await a.waitFor(`✓ 已由 cli/${deviceId} 处理：允许一次`);
    await a.waitFor('── 本轮完成');
    await b.waitFor('── 本轮完成');

    const events = (out: string) =>
      out
        .split('\n')
        .filter((line) => /^(● | {2}⎿ |⚠ | {2}选项|Echo: |── 本轮)/.test(line))
        .map((line) => line.replace(/ · \d+ ms/, ''));
    expect(events(a.out())).toEqual(events(b.out()));
    expect(events(a.out())).toEqual([
      '● echo_write /outside-workspace/echo.txt',
      '⚠ 需要审批：echo_write /outside-workspace/echo.txt',
      '  选项：1) 允许一次  2) 拒绝',
      '  ⎿ echo_write 完成',
      'Echo: please approve',
      '── 本轮完成 ──',
    ]);

    // 第一端在输入框里继续追问，第二端同步看到。
    await a.waitFor(/本轮完成 · \d+ ms ──\n› $/);
    a.stdin.write('second question\r');
    await b.waitFor('› second question');
    await b.waitFor('Echo: second question');
    await a.waitFor('Echo: second question');
  });

  it('运行中回车插话（默认）：这一步结束后插进本回合，模型接着回答（R11）', async () => {
    const { home, workspace } = await setup({ stepDelayMs: 20 });
    const a = fake(['session', 'new', '-w', workspace, 'please answer slowly'], {
      home,
      tty: true,
    });
    let at = await a.waitFor('Echo: pl');
    a.stdin.write('are you there?\r');
    at = await a.waitFor('› are you there?（插话）', at);
    at = await a.waitFor('⋯ 插话：当前步骤结束后并入本回合 · are you there?', at);
    at = await a.waitFor('（插话已并入本回合）', at);
    at = await a.waitFor('Echo: are you there?', at);
    at = await a.waitFor('── 本轮完成', at);
    a.stdin.write('\x04');
    expect(await a.exit).toBe(0);
  });

  it('运行中 Tab 排队；Ctrl-C 取消后排队的暂停，/resume 继续发送；再按 Ctrl-C 退出 attach', async () => {
    const { home, workspace } = await setup({ stepDelayMs: 40 });
    const a = fake(
      ['session', 'new', '-w', workspace, 'a long answer that keeps streaming for a while'],
      { home, tty: true },
    );
    let at = await a.waitFor('Echo: a lo');
    a.stdin.write('later please\t');
    at = await a.waitFor('› later please（排队）', at);
    at = await a.waitFor('⋯ 已排队：本回合结束后发送 · later please', at);
    a.stdin.write('\x03');
    at = await a.waitFor('正在取消当前运行…（再按 Ctrl-C 退出 attach）', at);
    at = await a.waitFor('── 本轮已取消', at);
    at = await a.waitFor('⋯ 已暂停 · later please（/resume 继续发送）', at);
    a.stdin.write('/resume\r');
    at = await a.waitFor('继续发送暂停的消息', at);
    at = await a.waitFor('Echo: later please', at);
    at = await a.waitFor('── 本轮完成', at);
    a.stdin.write('\x03');
    at = await a.waitFor('再按 Ctrl-C 或 Ctrl-D 退出 attach', at);
    a.stdin.write('\x03');
    expect(await a.exit).toBe(0);
    expect(a.out()).toContain('已退出 attach；重新连接');
  });

  it('attach 不存在的会话：说明与下一步', async () => {
    const { home } = await setup();
    const result = await run(['session', 'attach', 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR'], { home });
    expect(result.code).toBe(1);
    expect(result.err).toContain('错误：会话不存在\n');
    expect(result.err).toContain('下一步：运行 wevir session list 查看');
  });
});
