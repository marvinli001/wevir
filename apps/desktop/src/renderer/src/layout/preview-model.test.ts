import type { HostProcess, PreviewConfig } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  commandLine,
  formOf,
  inputOf,
  previewRows,
  previewState,
  previewSummary,
  sameOrigin,
  startProblem,
  targetLabel,
} from './preview-model';

const ROOT = '/home/u/demo';
const config = (name: string, extra: Partial<PreviewConfig> = {}): PreviewConfig => ({
  name,
  command: 'pnpm run dev',
  cwd: '',
  addedBy: 'user',
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  ...extra,
});
const process = (
  name: string,
  startedAt: string,
  extra: Partial<HostProcess> = {},
  ready = false,
): HostProcess => ({
  id: `p${startedAt.slice(-2)}`,
  workspaceId: 'ws_1' as HostProcess['workspaceId'],
  source: { kind: 'preview', sessionId: 'ses_1' as never, startedBy: 'user' },
  name,
  command: 'pnpm run dev',
  cwd: ROOT,
  status: 'running',
  exitCode: null,
  signal: null,
  startedAt,
  bytes: 0,
  stopSignals: ['SIGTERM'],
  preview: { name, root: ROOT, port: 5173, url: 'http://localhost:5173', ready },
  ...extra,
});

describe('preview-model', () => {
  it('每项配置配上同一根目录、同名的最近一次预览进程', () => {
    const rows = previewRows(
      [config('web'), config('api')],
      [
        process('web', '2026-10-21T00:00:01'),
        process('web', '2026-10-21T00:00:09', {}, true),
        process('web', '2026-10-21T00:00:10', {
          preview: { name: 'web', root: '/other', ready: true },
        }),
        process('api', '2026-10-21T00:00:05', {
          source: { kind: 'agent', sessionId: 'ses_1' as never },
        }),
      ],
      ROOT,
    );
    expect(rows.map((row) => [row.config.name, row.process?.id, row.state])).toEqual([
      ['web', 'p09', 'ready'],
      ['api', undefined, 'idle'],
    ]);
  });

  it('状态：被停与正常退出算未运行，自己异常退出或起不来算失败', () => {
    const base = process('web', '2026-10-21T00:00:01');
    expect(previewState(base)).toBe('starting');
    const exited = { ...base, status: 'exited' as const };
    expect(previewState({ ...exited, exitCode: 0 })).toBe('idle');
    expect(previewState({ ...exited, exitCode: 1 })).toBe('failed');
    expect(previewState({ ...exited, exitCode: 143, stoppedBy: 'user' })).toBe('idle');
    expect(previewState({ ...exited, signal: 'SIGTERM' })).toBe('idle');
    expect(previewState({ ...exited, error: 'spawn ENOENT' })).toBe('failed');
  });

  it('摘要', () => {
    expect(previewSummary([])).toBeUndefined();
    const idle = { config: config('web'), process: undefined, state: 'idle' as const };
    expect(previewSummary([idle, idle])).toEqual({
      key: 'preview.summary.configs',
      count: 2,
      tone: 'neutral',
    });
    expect(previewSummary([idle, { ...idle, state: 'starting' }])).toMatchObject({
      key: 'preview.summary.running',
      count: 1,
      tone: 'accent',
    });
  });

  it('行的写法', () => {
    expect(commandLine({ cwd: '', command: 'pnpm dev' })).toBe('pnpm dev');
    expect(commandLine({ cwd: 'apps/web', command: 'pnpm dev' })).toBe('apps/web · pnpm dev');
    expect(targetLabel({ port: 5173 })).toBe(':5173');
    expect(targetLabel({ port: 443, url: 'https://app.test/' })).toBe('app.test');
    expect(targetLabel({})).toBeUndefined();
  });

  it('表单：必填、端口、地址与目录的校验；编辑时留着环境变量', () => {
    const form = { ...formOf(undefined), name: ' web ', command: 'pnpm dev', cwd: './apps/web' };
    expect(inputOf(form)).toEqual({ input: { name: 'web', command: 'pnpm dev', cwd: 'apps/web' } });
    expect(inputOf({ ...form, command: ' ' })).toEqual({ error: 'preview.invalid.required' });
    expect(inputOf({ ...form, port: '70000' })).toEqual({ error: 'preview.invalid.port' });
    expect(inputOf({ ...form, url: 'localhost:3000' })).toEqual({ error: 'preview.invalid.url' });
    expect(inputOf({ ...form, cwd: '../x' })).toEqual({ error: 'preview.invalid.cwd' });
    expect(inputOf({ ...form, cwd: '/abs' })).toEqual({ error: 'preview.invalid.cwd' });
    const previous = config('web', { env: { NODE_ENV: 'development' }, port: 5173 });
    expect(inputOf(formOf(previous), previous)).toEqual({
      input: {
        name: 'web',
        command: 'pnpm run dev',
        cwd: '',
        port: 5173,
        env: { NODE_ENV: 'development' },
      },
    });
  });

  it('启动结果里的问题', () => {
    expect(
      startProblem({
        status: 'blocked',
        readiness: [
          { kind: 'dependencies', name: 'node_modules', path: 'apps/web', status: 'missing' },
          { kind: 'runtime', name: 'node', path: '', status: 'incompatible' },
        ],
      }),
    ).toEqual({ key: 'preview.blocked', items: 'node_modules · apps/web、node' });
    expect(
      startProblem({ status: 'port_in_use', port: 3000, url: 'http://localhost:3000' }),
    ).toEqual({ key: 'preview.portInUse', port: 3000, url: 'http://localhost:3000' });
  });

  it('同源', () => {
    expect(sameOrigin('http://localhost:5173/about', 'http://127.0.0.1:5173/')).toBe(true);
    expect(sameOrigin('http://localhost:5173/', 'http://localhost:5174/')).toBe(false);
    expect(sameOrigin('about:blank', 'http://localhost:5173/')).toBe(false);
  });
});
