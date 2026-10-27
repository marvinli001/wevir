// “预览”卡片（0.84.0，ADR-0013）的纯逻辑：运行配置配上这个根目录下最近一次的预览进程、行的状态与摘要、表单的校验、
// 浏览器里找同一地址的标签页。

import type {
  HostProcess,
  PreviewCandidate,
  PreviewConfig,
  PreviewInput,
  PreviewStartResult,
} from '@wevir/protocol';
import type { StatusTone } from '@/components/status-dot';
import { type PlainMessageKey, t } from '@/i18n';

export type PreviewState = 'idle' | 'starting' | 'ready' | 'failed';

export interface PreviewRow {
  config: PreviewConfig;
  /** 这个根目录下这项配置最近一次的预览进程。 */
  process: HostProcess | undefined;
  state: PreviewState;
}

export const PREVIEW_TONES: Record<PreviewState, StatusTone> = {
  idle: 'neutral',
  starting: 'accent',
  ready: 'success',
  failed: 'danger',
};

export const PREVIEW_LABELS: Record<PreviewState, PlainMessageKey> = {
  idle: 'preview.state.idle',
  starting: 'preview.state.starting',
  ready: 'preview.state.ready',
  failed: 'preview.state.failed',
};

/** 进程的状态：在跑的分启动中与运行中；自己退出且不是 0（或起不来）的算异常，被停的与正常退出的算未运行。 */
export function previewState(process: HostProcess | undefined): PreviewState {
  if (process === undefined) return 'idle';
  if (process.status === 'running') return process.preview?.ready === true ? 'ready' : 'starting';
  if (process.error !== undefined) return 'failed';
  if (process.stoppedBy !== undefined || process.signal !== null) return 'idle';
  return process.exitCode === 0 ? 'idle' : 'failed';
}

/** 每项配置一行，按配置的顺序。进程只认这个根目录、同名的预览进程，取最近起的。 */
export function previewRows(
  configs: readonly PreviewConfig[],
  processes: readonly HostProcess[],
  root: string,
): PreviewRow[] {
  return configs.map((config) => {
    const process = processes
      .filter(
        (item) =>
          item.source.kind === 'preview' &&
          item.preview?.root === root &&
          item.preview.name === config.name,
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return { config, process, state: previewState(process) };
  });
}

/** 收起时的摘要：有在跑的写“N 个运行中”，否则“N 项”；没有配置时 undefined。 */
export function previewSummary(
  rows: readonly PreviewRow[],
):
  | { key: 'preview.summary.running' | 'preview.summary.configs'; count: number; tone: StatusTone }
  | undefined {
  if (rows.length === 0) return undefined;
  const live = rows.filter((row) => row.state === 'starting' || row.state === 'ready');
  if (live.length > 0) {
    return {
      key: 'preview.summary.running',
      count: live.length,
      tone: live.some((row) => row.state === 'ready') ? 'success' : 'accent',
    };
  }
  const failed = rows.some((row) => row.state === 'failed');
  return {
    key: 'preview.summary.configs',
    count: rows.length,
    tone: failed ? 'danger' : 'neutral',
  };
}

/** 行的第二行：目录 · 命令（目录是会话目录时只有命令）。 */
export function commandLine(config: Pick<PreviewConfig, 'cwd' | 'command'>): string {
  return config.cwd === '' ? config.command : `${config.cwd} · ${config.command}`;
}

/** 端口或地址的短写法：`:5173`，配了地址时是地址去掉协议。 */
export function targetLabel(config: Pick<PreviewConfig, 'port' | 'url'>): string | undefined {
  if (config.url !== undefined) return config.url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return config.port === undefined ? undefined : `:${config.port}`;
}

/** 候选存成配置的内容。 */
export function candidateInput(candidate: PreviewCandidate): PreviewInput {
  return {
    name: candidate.name,
    command: candidate.command,
    cwd: candidate.cwd,
    ...(candidate.port !== undefined && { port: candidate.port }),
    ...(candidate.url !== undefined && { url: candidate.url }),
    ...(candidate.env !== undefined && { env: candidate.env }),
  };
}

export interface PreviewForm {
  name: string;
  command: string;
  cwd: string;
  port: string;
  url: string;
}

export function formOf(config: PreviewConfig | undefined): PreviewForm {
  return {
    name: config?.name ?? '',
    command: config?.command ?? '',
    cwd: config?.cwd ?? '',
    port: config?.port === undefined ? '' : String(config.port),
    url: config?.url ?? '',
  };
}

/** 表单换成 `preview.save` 的配置；不合法时是出错的那一栏的文案。编辑时保留原来的环境变量。 */
export function inputOf(
  form: PreviewForm,
  previous?: PreviewConfig,
): { input: PreviewInput } | { error: PlainMessageKey } {
  const name = form.name.trim();
  const command = form.command.trim();
  if (name === '' || command === '') return { error: 'preview.invalid.required' };
  const cwd = form.cwd.trim().replace(/^\.(\/|$)/, '');
  if (cwd.startsWith('/') || /^[A-Za-z]:/.test(cwd) || cwd.split(/[\\/]/).includes('..')) {
    return { error: 'preview.invalid.cwd' };
  }
  const portText = form.port.trim();
  const port = portText === '' ? undefined : Number(portText);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    return { error: 'preview.invalid.port' };
  }
  const url = form.url.trim();
  if (url !== '' && !/^https?:\/\/\S+$/i.test(url)) return { error: 'preview.invalid.url' };
  return {
    input: {
      name,
      command,
      cwd,
      ...(port !== undefined && { port }),
      ...(url !== '' && { url }),
      ...(previous?.env !== undefined && { env: previous.env }),
    },
  };
}

/** 启动结果里要告诉用户的：环境没就绪（阻塞项的名字）或端口被占。 */
export function startProblem(
  result: PreviewStartResult,
):
  | { key: 'preview.blocked'; items: string }
  | { key: 'preview.portInUse'; port: number; url: string }
  | undefined {
  if (result.status === 'blocked') {
    return {
      key: 'preview.blocked',
      items: result.readiness
        .map((item) => (item.path === '' ? item.name : `${item.name} · ${item.path}`))
        .join(t('common.listSeparator')),
    };
  }
  if (result.status === 'port_in_use') {
    return { key: 'preview.portInUse', port: result.port, url: result.url };
  }
  return undefined;
}

/** 同源（协议、主机、端口）的标签页：同一个开发服务器已经开着时选中它，不再新开。 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const host = (url: URL) => (url.hostname === '127.0.0.1' ? 'localhost' : url.hostname);
    return (
      left.protocol === right.protocol && host(left) === host(right) && left.port === right.port
    );
  } catch {
    return false;
  }
}
