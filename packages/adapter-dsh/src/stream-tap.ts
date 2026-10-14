import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  IncrementalDecoder,
  IncrementalDecoderHandlers,
  IncrementalEvent,
  IncrementalWarning,
} from '@wevir/adapter-acp';
import { buildDshEnv } from './env.js';
import { DSH_PROFILE, type DshPaths, dshProfileDir } from './paths.js';

// 增量流式旁路（T3.2a，ADR-0001 §3）的 Host 一侧：把本包的 stream-tap 插件装进 Wevir 专属 DSH_HOME 的
// acp profile，并解码插件写到 fd 3 的 NDJSON。插件本身在 ../stream-tap/index.js，由 dsh 加载。在通用 ACP 适配器
// 看来，这就是 dsh 引擎描述里的增量旁路（engine.ts 的 `DSH_ENGINE.incremental`）。
//
// 旁路是增强而不是依赖：插件装不上、没加载、fd 3 没有数据或行解析失败，都只是少了增量，ACP 的已提交
// 消息与其余功能不受影响。增量与已提交消息的合并在 T3.2。

/** 插件的包名，也是 overlay 里插件行的 `name`（从 profile 的 node_modules 解析）。 */
export const STREAM_TAP_PACKAGE = '@wevir/dsh-stream-tap';

/** 单行上限（字节）。超过的行丢弃并告警，防止一条没有换行的坏数据无限占内存。 */
export const STREAM_TAP_MAX_LINE_BYTES = 8 * 1024 * 1024;

/** `dsh plugin add` 的时限。本机实测约 0.2 s（link: 不走网络）；dsh 自己等 profile 锁最多 120 s。 */
export const STREAM_TAP_INSTALL_TIMEOUT_MS = 60_000;

/**
 * initialize 完成后等插件报到的时间。插件在 dsh 启动挂载插件时写 ready，实测比 initialize 的响应早几毫秒
 * 到达（两条管道之间没有顺序保证）。
 */
export const STREAM_TAP_READY_GRACE_MS = 2000;

/**
 * 开发模式下的插件目录：本包的 `stream-tap/`（从 `src/` 与 `dist/` 都是上一级）。打包后的应用由调用方经
 * `DshStreamTapOptions.pluginDir` 给出解包后的位置（目录必须是真实文件系统路径，dsh 要能 import）。
 */
export function defaultStreamTapPluginDir(): string {
  return fileURLToPath(new URL('../stream-tap', import.meta.url));
}

/** 插件目录里随附的 overlay：`insert` 插件行，以 `--patch` 传给 dsh。 */
export function streamTapOverlay(pluginDir: string): string {
  return join(pluginDir, 'overlay.yml');
}

// ── 安装 ───────────────────────────────────────────────────────────────────────────

/**
 * acp profile 里是否已经装好、且指向 `pluginDir` 的插件：`package.json` 声明了依赖，
 * `node_modules/@wevir/dsh-stream-tap` 解析到同一个真实目录。插件目录换了位置（升级、搬家）时为 false。
 */
export function isStreamTapInstalled(paths: DshPaths, pluginDir: string): boolean {
  const profile = dshProfileDir(paths);
  try {
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    if (manifest.dependencies?.[STREAM_TAP_PACKAGE] === undefined) return false;
    return (
      realpathSync(join(profile, 'node_modules', STREAM_TAP_PACKAGE)) === realpathSync(pluginDir)
    );
  } catch {
    // profile 还没生成、链接断了或目录不存在：都算没装。
    return false;
  }
}

export interface StreamTapInstallInput {
  paths: DshPaths;
  pluginDir: string;
  /** dsh 可执行入口（`resolveDshEntry().entry`）。 */
  entry: string;
  /** 运行 dsh 的 Node，默认 `process.execPath`。 */
  nodePath?: string;
  /** 环境变量的继承来源，默认 `process.env`（同样经白名单过滤）。 */
  parentEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * 确保插件装进了 acp profile：已装好（`isStreamTapInstalled`）时什么都不做，否则运行
 * `dsh plugin --profile acp add link:<插件目录>`。profile 不存在时 dsh 先从随附模板生成它。
 *
 * `dsh plugin` 把参数转给 PATH 上的 pnpm，在 profile 目录里装依赖；插件包没有 `dsh.bundle`，dsh 会告警
 * “installed as a plain dependency”，这是预期的：插件行由 overlay 插入，Wevir 自己决定每次启动用不用。
 * 子进程环境同 dsh 本身（白名单，不带 Provider Key），cwd 是 `DSH_HOME`。
 *
 * 失败（pnpm 不在 PATH、超时、装完仍对不上）时抛错，消息里带输出尾部。
 */
export async function ensureStreamTapInstalled(input: StreamTapInstallInput): Promise<void> {
  if (isStreamTapInstalled(input.paths, input.pluginDir)) return;
  const pluginDir = realpathSync(input.pluginDir);
  const timeoutMs = input.timeoutMs ?? STREAM_TAP_INSTALL_TIMEOUT_MS;
  const posix = process.platform !== 'win32';
  const child = spawn(
    input.nodePath ?? process.execPath,
    [input.entry, 'plugin', '--profile', DSH_PROFILE, 'add', `link:${pluginDir}`],
    {
      cwd: input.paths.dshHome,
      env: buildDshEnv({ paths: input.paths, parent: input.parentEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
      // 超时要连同 pnpm 一起结束，所以 POSIX 上自成进程组。
      detached: posix,
      windowsHide: true,
    },
  );
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-4000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let timer: NodeJS.Timeout | undefined;
  const result = await new Promise<{ code: number | null; error?: Error; timedOut?: true }>(
    (resolve) => {
      timer = setTimeout(() => {
        try {
          if (posix && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          // 进程组已经不在（ESRCH）：它刚好自己退出了，结果以 exit 事件为准。
        }
        resolve({ code: null, timedOut: true });
      }, timeoutMs);
      child.once('error', (error) => resolve({ code: null, error }));
      child.once('exit', (code) => resolve({ code }));
    },
  );
  clearTimeout(timer);

  const tail = output.trim();
  const detail = tail === '' ? '' : `；输出尾部：${tail}`;
  if (result.timedOut) {
    throw new Error(`dsh plugin add 在 ${timeoutMs} ms 内没有完成${detail}`);
  }
  if (result.error !== undefined) {
    throw new Error(`dsh plugin add 无法启动：${result.error.message}`);
  }
  if (result.code !== 0) throw new Error(`dsh plugin add 失败（退出码 ${result.code}）${detail}`);
  if (!isStreamTapInstalled(input.paths, pluginDir)) {
    throw new Error(`dsh plugin add 成功退出，但 profile 里没有指向 ${pluginDir} 的插件${detail}`);
  }
}

// ── fd 3 解码 ──────────────────────────────────────────────────────────────────────

/** 旁路产出的 AgentEvent：文本与推理的增量（分开），以及一个 attempt 的增量流结束。 */
export type StreamTapEvent = IncrementalEvent;

/**
 * dsh `AssistantStreamFrame` 中适配器读取的字段（上游 `packages/core/agent/src/runtime-types.ts`，
 * `d743267`）。chunk 的 `chunk` 是 dsh-llm 的 `StreamChunk`：`text-delta` / `reasoning-delta` 的
 * `index` 是内容块序号，`text` 是增量文本；其余类型（`block-start`、`block-end`、`tool-call-delta`、
 * `usage`、`finish`）这里不用。
 */
export type StreamTapFrame =
  | { type: 'start'; attemptId: string }
  | { type: 'chunk'; attemptId: string; chunk: StreamTapChunk }
  | {
      type: 'end';
      attemptId: string;
      /**
       * committed 的 `eventType` 是这次 attempt 落成的会话事件：`assistant/message`（有已提交消息），或
       * `assistant/attempt`（只记下这次调用，没有消息：取消时没有非空白内容、出错重试）。
       */
      outcome: { kind: 'committed'; eventType?: string } | { kind: 'abandoned' };
    };

export type StreamTapChunk =
  | { type: 'text-delta' | 'reasoning-delta'; index: number; text: string }
  | { type: string };

/** 插件写的一行（见 ../stream-tap/index.js）。 */
export type StreamTapRecord =
  | { type: 'ready' }
  | { type: 'frame'; sessionId: string; frame: StreamTapFrame };

/**
 * 解析一行。结构不对时抛 `TypeError`，消息说明哪里不对。只检查适配器要读的字段，帧里的其他字段原样保留。
 */
export function parseStreamTapLine(line: string): StreamTapRecord {
  const value: unknown = JSON.parse(line);
  if (!isObject(value)) throw new TypeError('不是 JSON 对象');
  if (value.type === 'ready') return { type: 'ready' };
  if (value.type !== 'frame') throw new TypeError(`未知记录类型 ${JSON.stringify(value.type)}`);
  if (!isNonEmptyString(value.sessionId)) throw new TypeError('sessionId 缺失');
  const frame = value.frame;
  if (!isObject(frame)) throw new TypeError('frame 不是对象');
  if (!isNonEmptyString(frame.attemptId)) throw new TypeError('frame.attemptId 缺失');
  switch (frame.type) {
    case 'start':
      break;
    case 'chunk': {
      const chunk = frame.chunk;
      if (!isObject(chunk) || typeof chunk.type !== 'string') {
        throw new TypeError('chunk 帧缺少 chunk.type');
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        if (!Number.isInteger(chunk.index) || (chunk.index as number) < 0) {
          throw new TypeError(`${chunk.type} 的 index 不是非负整数`);
        }
        if (typeof chunk.text !== 'string') throw new TypeError(`${chunk.type} 缺少 text`);
      }
      break;
    }
    case 'end': {
      const kind = isObject(frame.outcome) ? frame.outcome.kind : undefined;
      if (kind !== 'committed' && kind !== 'abandoned') {
        throw new TypeError(`end 帧的 outcome.kind 是 ${JSON.stringify(kind)}`);
      }
      break;
    }
    default:
      throw new TypeError(`未知帧类型 ${JSON.stringify(frame.type)}`);
  }
  return { type: 'frame', sessionId: value.sessionId, frame: frame as StreamTapFrame };
}

/**
 * 一条记录对应的 AgentEvent：`text-delta` → `assistant.delta`（text），`reasoning-delta` →
 * `assistant.delta`（reasoning），`end` → `assistant.stream_ended`（落成 `assistant/attempt` 的记为
 * abandoned）；空文本的增量与其余帧不产出事件。
 * `engineSessionId` 是 dsh 的会话 ID，与 ACP 的 `sessionId` 相同。
 */
export function streamTapEvents(record: StreamTapRecord): StreamTapEvent[] {
  if (record.type !== 'frame') return [];
  const { sessionId: engineSessionId, frame } = record;
  if (frame.type === 'end') {
    return [
      {
        type: 'assistant.stream_ended',
        engineSessionId,
        attemptId: frame.attemptId,
        // 落成 assistant/attempt 的 attempt 没有已提交消息，它的增量不会被替换，对 Host 来说与丢弃相同。
        outcome:
          frame.outcome.kind === 'committed' && frame.outcome.eventType !== 'assistant/attempt'
            ? 'committed'
            : 'abandoned',
      },
    ];
  }
  if (frame.type !== 'chunk') return [];
  const chunk = frame.chunk;
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return [];
  const { index, text } = chunk as { index: number; text: string };
  if (text === '') return [];
  return [
    {
      type: 'assistant.delta',
      engineSessionId,
      attemptId: frame.attemptId,
      blockIndex: index,
      kind: chunk.type === 'text-delta' ? 'text' : 'reasoning',
      text,
    },
  ];
}

/**
 * 旁路的告警（通用的 `IncrementalWarning`）：malformed、too_long、truncated 由 `StreamTapDecoder` 报；
 * install_failed 由 `DshProcess` 的启动器报，not_loaded 由通用的 `AcpProcess` 报。`line` 最多 200 个字符。
 */
export type StreamTapWarning = IncrementalWarning;

export type StreamTapDecoderHandlers = IncrementalDecoderHandlers;

const LINE_SAMPLE_CHARS = 200;

/**
 * fd 3 的增量解码器：按 `\n` 切行（行可以跨多次 `push`，多字节字符被切开也没关系，整行凑齐才按 UTF-8
 * 解码），逐行解析并交出 AgentEvent。畸形行告警后跳过，不影响后面的行。一个 dsh 进程一个解码器。
 * 回调同步调用，不得抛错。
 */
export class StreamTapDecoder implements IncrementalDecoder {
  readonly #handlers: StreamTapDecoderHandlers;
  readonly #utf8 = new TextDecoder('utf-8', { fatal: true });
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  /** 当前行已超长、正在丢弃到下一个换行。 */
  #discarding = false;

  constructor(handlers: StreamTapDecoderHandlers) {
    this.#handlers = handlers;
  }

  push(chunk: Uint8Array): void {
    const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let newline = data.indexOf(0x0a); newline !== -1; newline = data.indexOf(0x0a, start)) {
      this.#take(data.subarray(start, newline));
      this.#endLine();
      start = newline + 1;
    }
    this.#take(data.subarray(start));
  }

  /** fd 关闭：剩下没有换行的半行告警丢弃，状态清空。 */
  end(): void {
    if (!this.#discarding && this.#pendingBytes > 0) {
      const line = Buffer.concat(this.#pending).toString('utf8');
      this.#warn('truncated', 'fd 关闭时最后一行没有换行，已丢弃', line);
    }
    this.#reset();
  }

  #take(part: Buffer): void {
    if (this.#discarding || part.length === 0) return;
    if (this.#pendingBytes + part.length > STREAM_TAP_MAX_LINE_BYTES) {
      const head = Buffer.concat([...this.#pending, part], LINE_SAMPLE_CHARS * 4);
      this.#warn(
        'too_long',
        `单行超过 ${STREAM_TAP_MAX_LINE_BYTES} 字节，已丢弃`,
        head.toString('utf8'),
      );
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#discarding = true;
      return;
    }
    this.#pending.push(part);
    this.#pendingBytes += part.length;
  }

  #endLine(): void {
    if (this.#discarding) {
      this.#reset();
      return;
    }
    const bytes = Buffer.concat(this.#pending);
    this.#reset();
    let line: string;
    try {
      line = this.#utf8.decode(bytes).trim();
    } catch {
      this.#warn('malformed', '不是合法的 UTF-8', bytes.toString('utf8'));
      return;
    }
    if (line === '') return;
    let record: StreamTapRecord;
    try {
      record = parseStreamTapLine(line);
    } catch (error) {
      this.#warn('malformed', `无法解析：${error instanceof Error ? error.message : error}`, line);
      return;
    }
    if (record.type === 'ready') this.#handlers.onReady?.();
    for (const event of streamTapEvents(record)) this.#handlers.onEvent(event);
  }

  #reset(): void {
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#discarding = false;
  }

  #warn(kind: StreamTapWarning['kind'], message: string, line: string): void {
    this.#handlers.onWarning({ kind, message, line: line.slice(0, LINE_SAMPLE_CHARS) });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
