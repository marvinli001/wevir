// browser_run 的沙箱：agent 写的一段 JS 在 QuickJS（quickjs-emscripten 的 WASM 版本，MIT）里跑。照 ego lite 与 Codex 的
// node_repl + `tab.playwright`：一次调用组合多步浏览器操作；和它们不同，脚本不在 Node 里跑，拿不到 Node、文件系统与网络，
// 只看得到这里放进去的 `tab` / `browser` 对象、`sleep` 与 `console`。每个浏览器调用都交给宿主（browser-batch.ts），由它按
// 单个工具的同一条路走 BrowserBroker。
//
// 每次运行用一个新的 WASM 模块（编译约 20 ms）：运行结束时还挂着的宿主调用、用完的句柄不会拖累之后的运行，也不用担心
// QuickJS 在释放时因句柄泄漏而中止整个模块。

import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
} from 'quickjs-emscripten-core';

/** 脚本里的一次浏览器调用失败（`BrowserError`，带错误码）。 */
export class ScriptCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ScriptHost {
  /**
   * 一次宿主调用：`name` 是工具名（`browser_click`）或 `sleep`，`input` 是参数。返回给脚本的值要能转成 JSON；失败时抛
   * `ScriptCallError`（脚本里是带 `code` 的 `BrowserError`）。`signal` 在运行结束（超时、取消、出错）时中止。
   */
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

export interface ScriptRunOptions {
  source: string;
  host: ScriptHost;
  /** 脚本里的 `tab`：给了标签页时绑上它。 */
  browserId?: string;
  /** 总时限。 */
  timeoutMs: number;
  /** 宿主调用（浏览器调用与 sleep）的上限。 */
  maxCalls: number;
  /** 引擎取消工具调用时中止。 */
  signal: AbortSignal;
}

export type ScriptStatus = 'ok' | 'error' | 'timeout' | 'cancelled' | 'limit';

export interface ScriptRunResult {
  status: ScriptStatus;
  /** `ok`：返回值的 JSON（`undefined` 时没有）。 */
  value?: string;
  /** 不是 `ok` 时：说明（脚本抛的错误、语法错误、超时）。 */
  error?: string;
  /** 抛出的 `BrowserError` 的错误码。 */
  errorCode?: string;
  /** console 的输出，一项一行（已截短）。 */
  logs: string[];
  /** 截掉的输出行数。 */
  logsDropped: number;
  calls: number;
  elapsedMs: number;
}

/** 脚本的源码上限（字符）。 */
export const SCRIPT_MAX_CHARS = 20_000;
/** QuickJS 的内存与栈上限。 */
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
/** console 输出最多留多少行、多少字符，返回值最多多少字符。 */
const MAX_LOG_LINES = 300;
const MAX_LOG_CHARS = 16_000;
const MAX_LINE_CHARS = 2_000;
const MAX_VALUE_CHARS = 16_000;

/**
 * 沙箱里先跑的一段：把宿主的两个函数包成 `tab` / `browser` / `sleep` / `console`，之后从全局上删掉它们。参数既可以按位置
 * 给（`tab.click('@e3')`、`tab.fill('@e4', 'text')`、`tab.type('text')`），也可以给一个和同名工具的参数一样的对象。
 */
const PRELUDE = String.raw`(() => {
  const call = globalThis.__wevir_call;
  const write = globalThis.__wevir_log;
  delete globalThis.__wevir_call;
  delete globalThis.__wevir_log;
  class BrowserError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'BrowserError';
      this.code = code;
    }
  }
  const invoke = async (name, input) => {
    const out = JSON.parse(await call(name, JSON.stringify(input === undefined ? {} : input)));
    if (!out.ok) throw new BrowserError(out.code, out.message);
    return out.value;
  };
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const options = (value) => (isObject(value) ? value : {});
  const isRef = (value) => typeof value === 'string' && /^@e\d+$/.test(value);
  const text = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (value === undefined) return 'undefined';
    if (typeof value === 'function') return '[function]';
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  const makeTab = (browserId) => {
    const run = (name, input) => invoke('browser_' + name, { ...input, browserId });
    return Object.freeze({
      id: browserId,
      snapshot: (o) => run('snapshot', options(o)),
      screenshot: (o) => run('screenshot', options(o)),
      click: (ref, o) => run('click', isObject(ref) ? ref : { ...options(o), ref }),
      fill: (ref, value) => run('fill', isObject(ref) ? ref : { ref, value }),
      type: (a, b) => run('type', isObject(a) ? a : isRef(a) && b !== undefined ? { ref: a, text: b } : { text: a }),
      keypress: (a, b) => run('keypress', isObject(a) ? a : isRef(a) && b !== undefined ? { ref: a, key: b } : { key: a }),
      select: (ref, value) => run('select', isObject(ref) ? ref : { ref, value }),
      hover: (ref) => run('hover', isObject(ref) ? ref : { ref }),
      drag: (source, target) => run('drag', isObject(source) ? source : { sourceRef: source, targetRef: target }),
      scroll: (a, o) => run('scroll', isObject(a) ? a : { ...options(o), deltaY: a }),
      navigate: (url) => run('navigate', isObject(url) ? url : { url }),
      back: () => run('back', {}),
      forward: () => run('forward', {}),
      reload: () => run('reload', {}),
      wait: (a) => run('wait', isObject(a) ? a : { text: a }),
      query: (selector, o) => run('query', isObject(selector) ? selector : { ...options(o), selector }),
      logs: (o) => run('logs', options(o)),
      network: (o) => run('network', options(o)),
      evaluate: (fn, o) => run('evaluate', isObject(fn) ? fn : { ...options(o), function: typeof fn === 'function' ? String(fn) : fn }),
    });
  };
  const browser = Object.freeze({
    tabs: () => invoke('browser_list_tabs', {}),
    tab: (id) => makeTab(String(id)),
    newTab: async (url) => makeTab((await invoke('browser_new_tab', url === undefined ? {} : { url })).browserId),
    closeTab: (id) => invoke('browser_close_tab', { browserId: String(isObject(id) ? id.id : id) }),
  });
  const log = (level) => (...args) => write(level, args.map(text).join(' '));
  globalThis.console = Object.freeze({ log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') });
  globalThis.browser = browser;
  globalThis.sleep = (ms) => invoke('sleep', { ms });
  globalThis.BrowserError = BrowserError;
  globalThis.__wevir_result = (value) => {
    if (value === undefined) return undefined;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? JSON.stringify(String(value)) : json;
    } catch {
      return JSON.stringify(String(value));
    }
  };
  globalThis.__wevir_error = (error) => {
    if (error instanceof BrowserError) return JSON.stringify({ code: error.code, message: error.message });
    const where = error && typeof error.stack === 'string' ? (error.stack.match(/script\.js:(\d+)/) || [])[1] : undefined;
    return JSON.stringify({ message: text(error) + (where ? ' (line ' + where + ')' : '') });
  };
})();`;

/** 跑一段脚本。永远 resolve：出错、超时、取消都是结果。 */
export async function runBrowserScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  const logs: string[] = [];
  let logChars = 0;
  let logsDropped = 0;
  let calls = 0;
  let stop: { status: Exclude<ScriptStatus, 'ok' | 'error'>; message: string } | undefined;
  const finished = new AbortController();
  const result = (
    status: ScriptStatus,
    extra: Partial<Pick<ScriptRunResult, 'value' | 'error' | 'errorCode'>> = {},
  ): ScriptRunResult => ({
    status,
    ...extra,
    logs,
    logsDropped,
    calls,
    elapsedMs: Date.now() - started,
  });
  if (options.signal.aborted) return result('cancelled', { error: 'The tool call was cancelled.' });

  const { newQuickJSWASMModuleFromVariant } = await import('quickjs-emscripten-core');
  const module = await newQuickJSWASMModuleFromVariant(
    import('@jitl/quickjs-wasmfile-release-sync'),
  );
  const runtime: QuickJSRuntime = module.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  const vm: QuickJSContext = runtime.newContext();
  const deferreds = new Set<QuickJSDeferredPromise>();

  // 停下的原因（第一个算数）：超时、取消、调用次数到了上限。
  let wake: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const halt = (status: Exclude<ScriptStatus, 'ok' | 'error'>, message: string) => {
    if (stop !== undefined) return;
    stop = { status, message };
    finished.abort();
    wake();
  };
  const timeUp = () =>
    halt(
      'timeout',
      `The script did not finish within ${Math.round(options.timeoutMs / 1000)} s and was stopped.`,
    );
  const timer = setTimeout(timeUp, Math.max(0, deadline - Date.now()));
  // 算着的代码（死循环）占着事件循环，计时器到不了：中断检查自己看时间。
  runtime.setInterruptHandler(() => {
    if (stop === undefined && Date.now() > deadline) timeUp();
    return stop !== undefined;
  });
  const onAbort = () => halt('cancelled', 'The tool call was cancelled.');
  options.signal.addEventListener('abort', onAbort, { once: true });

  const pump = () => {
    if (!runtime.alive) return;
    const jobs = runtime.executePendingJobs();
    if (jobs.error) jobs.error.dispose();
  };

  const callFn = vm.newFunction('__wevir_call', (nameHandle, inputHandle) => {
    const name = vm.getString(nameHandle);
    const raw = vm.getString(inputHandle);
    const deferred = vm.newPromise();
    deferreds.add(deferred);
    const settle = (payload: unknown) => {
      if (stop !== undefined || !deferred.alive) return;
      const handle = vm.newString(JSON.stringify(payload));
      deferred.resolve(handle);
      handle.dispose();
      deferreds.delete(deferred);
      deferred.dispose();
      pump();
    };
    calls += 1;
    if (calls > options.maxCalls) {
      halt(
        'limit',
        `The script made more than ${options.maxCalls} browser calls and was stopped. Do less per run, or split the work into several runs.`,
      );
      return deferred.handle;
    }
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      input =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      input = {};
    }
    options.host.call(name, input, finished.signal).then(
      (value) => settle({ ok: true, value: value ?? null }),
      (error: unknown) =>
        settle(
          error instanceof ScriptCallError
            ? { ok: false, code: error.code, message: error.message }
            : {
                ok: false,
                code: 'browser_unknown_error',
                message: error instanceof Error ? error.message : String(error),
              },
        ),
    );
    return deferred.handle;
  });
  const logFn = vm.newFunction('__wevir_log', (levelHandle, textHandle) => {
    const level = vm.getString(levelHandle);
    const line = clip(vm.getString(textHandle), MAX_LINE_CHARS);
    const written = level === 'log' || level === 'info' ? line : `[${level}] ${line}`;
    if (logs.length >= MAX_LOG_LINES || logChars + written.length > MAX_LOG_CHARS) {
      logsDropped += 1;
      return;
    }
    logs.push(written);
    logChars += written.length + 1;
  });
  vm.setProp(vm.global, '__wevir_call', callFn);
  vm.setProp(vm.global, '__wevir_log', logFn);
  callFn.dispose();
  logFn.dispose();

  const cleanup = () => {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
    finished.abort();
    // 新模块每次一个：释放出错（还有没结的 promise）时整个模块随垃圾回收一起丢掉。
    try {
      for (const deferred of deferreds) if (deferred.alive) deferred.dispose();
      vm.dispose();
      runtime.dispose();
    } catch {
      // 忽略
    }
  };

  try {
    const prelude = vm.evalCode(PRELUDE, 'prelude.js');
    if (prelude.error) {
      prelude.error.dispose();
      return result('error', { error: 'The script sandbox did not start.' });
    }
    prelude.value.dispose();
    const tabSetup = vm.evalCode(
      options.browserId === undefined
        ? 'globalThis.tab = undefined;'
        : `globalThis.tab = browser.tab(${JSON.stringify(options.browserId)});`,
      'setup.js',
    );
    if (tabSetup.error) tabSetup.error.dispose();
    else tabSetup.value.dispose();

    // 脚本放在 async 函数里：顶层能 await、能 return。源码从第 1 行开始，错误里的行号就是脚本的行号。
    const evaluated = vm.evalCode(
      `(async () => { try { return { value: __wevir_result(await (async () => {${options.source}
})()) }; } catch (error) { return { error: __wevir_error(error) }; } })()`,
      'script.js',
    );
    if (evaluated.error) {
      const message = errorText(vm, evaluated.error);
      evaluated.error.dispose();
      if (stop !== undefined) return result(stop.status, { error: stop.message });
      return result('error', { error: `The script does not compile: ${message}` });
    }
    const promise = evaluated.value;
    const settled = vm.resolvePromise(promise);
    promise.dispose();
    pump();
    const outcome = await Promise.race([settled, stopped.then(() => undefined)]);
    if (stop !== undefined || outcome === undefined) {
      if (outcome?.error) outcome.error.dispose();
      else outcome?.value.dispose();
      const halted = stop ?? { status: 'cancelled' as const, message: 'The script was stopped.' };
      return result(halted.status, { error: halted.message });
    }
    if (outcome.error) {
      const message = errorText(vm, outcome.error);
      outcome.error.dispose();
      return result('error', { error: message });
    }
    const box = vm.dump(outcome.value) as { value?: unknown; error?: unknown } | undefined;
    outcome.value.dispose();
    if (typeof box?.error === 'string') {
      const parsed = JSON.parse(box.error) as { code?: string; message?: string };
      return result('error', {
        error: parsed.message ?? 'The script failed.',
        ...(parsed.code !== undefined && { errorCode: parsed.code }),
      });
    }
    return result(
      'ok',
      typeof box?.value === 'string' ? { value: clip(box.value, MAX_VALUE_CHARS) } : {},
    );
  } finally {
    cleanup();
  }
}

/** QuickJS 里的错误（内存、栈、中断也是）写成一句话。 */
function errorText(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as unknown;
  if (dumped !== null && typeof dumped === 'object') {
    const record = dumped as { name?: unknown; message?: unknown; stack?: unknown };
    const where =
      typeof record.stack === 'string' ? /script\.js:(\d+)/.exec(record.stack)?.[1] : undefined;
    const message = `${typeof record.name === 'string' ? record.name : 'Error'}: ${String(record.message ?? '')}`;
    if (/interrupted/i.test(message)) return 'The script was interrupted.';
    return where === undefined ? message : `${message} (line ${where})`;
  }
  return String(dumped);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
