// 一次调用做多步的浏览器工具（domain-model §3.15.1）：照 ego lite（agent 写 JS 一次组合多步）与 Codex 的 node_repl +
// `tab.playwright`，另有一个不用写代码的批量版本，弱一些的模型也能用。
//
// - browser_batch：一组 `{ name, input }`（名字与参数同各个 browser_* 工具），按顺序执行，遇到第一个错误就停，按步骤回结果。
// - browser_run：一段 JS 在 QuickJS 沙箱（browser-script.ts）里跑，`tab.click(…)` 这类调用逐个交给同名工具。
//
// 每一步都走单个工具的同一条路（`runBrowserSpec` → BrowserBroker → 桌面端），标签页归属、用户接手后只读、看门狗与错误码
// 都和单个工具一样；会话用不了的工具（角色、工具预设）在批量与脚本里也用不了。批准：browser_run 整段批准一次；browser_batch
// 全是不用批准的工具时 Host 替用户答应引擎的审批（`browserBatchAutoAllowed`，session-manager.ts），其余按会话的权限模式走
// 引擎的审批。审批卡片里列出每一步、写出脚本全文（`browserComposeDisplay`）。

import type { SessionId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import type { AppTool, AppToolResult } from './app-mcp.js';
import { objectSchema, optionalInt, optionalString } from './app-tools.js';
import type { BrowserBroker } from './browser-broker.js';
import {
  runBrowserScript,
  SCRIPT_MAX_CHARS,
  ScriptCallError,
  type ScriptRunResult,
} from './browser-script.js';
import {
  BROWSER_NO_APPROVAL_TOOLS,
  type BrowserSpecRun,
  browserToolNames,
  browserToolSpec,
  callerCwd,
  runBrowserSpec,
} from './browser-tools.js';

/** 一个批量最多几步。 */
export const BROWSER_BATCH_MAX_ACTIONS = 50;
/** 批量与脚本的总时限：默认、上限（Codex 给应用级工具的时限是 660 秒）。 */
const COMPOSE_DEFAULT_TIMEOUT_MS = 120_000;
const COMPOSE_MAX_TIMEOUT_MS = 300_000;
const RUN_DEFAULT_TIMEOUT_MS = 60_000;
/** 一段脚本最多发多少个浏览器调用（含 sleep）。 */
export const BROWSER_RUN_MAX_CALLS = 200;
/** 一次结果最多带几张截图。 */
const MAX_IMAGES = 5;
/** 批量里不能再套批量与脚本。 */
const COMPOSE_TOOLS = ['browser_batch', 'browser_run'];

export interface BrowserComposeOptions {
  storage: Storage;
  broker: BrowserBroker;
  /**
   * 这个会话能用的工具名（`AppTools.filterTools` 之后的）：每一步按它核对。不给时都能用。
   */
  allowedTools?: (sessionId: SessionId) => Promise<ReadonlySet<string>>;
}

const BATCH_DESCRIPTION =
  'Run several browser actions in one call, in order, and get each result back. Each action is {"name": ' +
  '"browser_click", "input": {...}} with the name and input of the browser tool to call (browser_snapshot, ' +
  'browser_click, browser_fill, browser_type, browser_keypress, browser_select, browser_wait, browser_screenshot, …). ' +
  'browserId given here is used by every action that leaves it out, and after a browser_new_tab action the new ' +
  'tab is. It stops at the first action that fails and says which actions did not run. Use it when you already ' +
  'know the steps, for example filling several fields from one snapshot and submitting: ' +
  '[{"name":"browser_fill","input":{"ref":"@e3","value":"Ada"}},{"name":"browser_fill","input":{"ref":"@e4","value":"ada@example.com"}},' +
  '{"name":"browser_click","input":{"ref":"@e7"}},{"name":"browser_snapshot","input":{"changes":true}}]. ' +
  'Refs come from a snapshot taken before the batch; a click that changes the page makes later refs stale, so ' +
  'end the batch there and look again. A batch of only read-only actions (snapshot, screenshot, wait, logs, ' +
  'query, network, list_tabs) needs no approval; any other is approved once for all its actions.';

const RUN_DESCRIPTION =
  'Run a JavaScript snippet that drives the Wevir browser, for loops and decisions that would take many tool ' +
  'calls: read the page, act, check, repeat. The script runs in a sandbox (QuickJS, not Node, not the page): it ' +
  'has no require, no files and no network, only these async functions. tab is the tab given by browserId: ' +
  'tab.snapshot(opts) returns the snapshot text; tab.query(selector, opts) returns {count, elements} with refs; ' +
  'tab.click(ref), tab.fill(ref, value), tab.type(text) or tab.type(ref, text), tab.keypress(key) or ' +
  'tab.keypress(ref, key), tab.select(ref, value), tab.hover(ref), tab.drag(sourceRef, targetRef), ' +
  'tab.scroll(deltaY), tab.navigate(url), tab.back(), tab.forward(), tab.reload() return the result text; ' +
  'tab.wait(text) or tab.wait({selector, state, url, networkIdle, timeoutMs}); tab.screenshot(opts) adds the ' +
  'image to the result; tab.logs(), tab.network(filters); tab.evaluate(fn) runs fn in the page and returns its ' +
  'result. Every function also takes one object with the same input as the browser tool of that name. ' +
  'browser.tabs(), browser.newTab(url) (returns a tab), browser.tab(browserId), browser.closeTab(id); ' +
  'sleep(ms); console.log. A failed call throws a BrowserError with code (like browser_stale_ref) that you can ' +
  `catch. Top-level await and return work; the result has the console output, the returned value (as JSON) and ` +
  `the tabs at the end. At most ${BROWSER_RUN_MAX_CALLS} browser calls and timeoutMs (default 60000, at most ` +
  `${COMPOSE_MAX_TIMEOUT_MS}). Example: for (const r of (await tab.query('a.next')).elements) { await tab.click(r.ref); console.log(await tab.snapshot({viewportOnly:true})); } ` +
  'The whole script is approved once and runs with the permissions of the tools it calls. Prefer single tools ' +
  'or browser_batch when the steps are known in advance.';

/** browser_batch 与 browser_run。 */
export function browserComposeTools(options: BrowserComposeOptions): AppTool[] {
  return [
    {
      name: 'browser_batch',
      title: 'Run browser actions in a batch',
      description: BATCH_DESCRIPTION,
      inputSchema: objectSchema(
        {
          browserId: {
            type: 'string',
            description: 'Default browserId for actions that do not give one.',
          },
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: BROWSER_BATCH_MAX_ACTIONS,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Browser tool name, like browser_click.' },
                input: { type: 'object', description: 'Input of that tool.' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1_000,
            maximum: COMPOSE_MAX_TIMEOUT_MS,
            description: `Time limit for the whole batch (default ${COMPOSE_DEFAULT_TIMEOUT_MS}).`,
          },
        },
        ['actions'],
      ),
      // 不标只读：批准由引擎按权限模式问，全是不用批准的工具时 Host 替用户答应（browserBatchAutoAllowed）。
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, call) => runBatch(options, args, call.sessionId, call.signal),
    },
    {
      name: 'browser_run',
      title: 'Run a browser script',
      description: RUN_DESCRIPTION,
      inputSchema: objectSchema(
        {
          script: {
            type: 'string',
            maxLength: SCRIPT_MAX_CHARS,
            description: 'JavaScript (the body of an async function).',
          },
          browserId: { type: 'string', description: 'Tab bound to tab in the script.' },
          timeoutMs: { type: 'integer', minimum: 1_000, maximum: COMPOSE_MAX_TIMEOUT_MS },
        },
        ['script'],
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, call) => runScript(options, args, call.sessionId, call.signal),
    },
  ];
}

/** 一步：工具名（认得 `click` 与 `mcp__wevir__browser_click` 的写法）与参数。 */
interface BatchAction {
  name: string;
  input: Record<string, unknown>;
}

/** 把模型写的工具名规整成 `browser_click`。 */
export function normalizeBrowserToolName(name: string): string {
  const bare = name.trim().replace(/^mcp__wevir__/, '');
  return bare.startsWith('browser_') ? bare : `browser_${bare}`;
}

/** browser_batch 的参数里的步骤；形状不对时给出原因。 */
export function batchActions(args: Record<string, unknown>): BatchAction[] | string {
  const value = args.actions;
  if (!Array.isArray(value) || value.length === 0) {
    return 'actions must be a non-empty array of {"name": "browser_…", "input": {...}}.';
  }
  if (value.length > BROWSER_BATCH_MAX_ACTIONS) {
    return `A batch takes at most ${BROWSER_BATCH_MAX_ACTIONS} actions (got ${value.length}); split it.`;
  }
  const actions: BatchAction[] = [];
  for (const [index, item] of value.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return `Action ${index + 1} must be an object {"name": "browser_…", "input": {...}}.`;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      return `Action ${index + 1} needs a name, like "browser_click".`;
    }
    const input = record.input ?? {};
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return `The input of action ${index + 1} (${record.name}) must be an object.`;
    }
    const name = normalizeBrowserToolName(record.name);
    if (COMPOSE_TOOLS.includes(name)) {
      return `Action ${index + 1}: ${name} cannot run inside browser_batch.`;
    }
    if (browserToolSpec(name) === undefined) {
      return `Action ${index + 1}: there is no browser tool named ${JSON.stringify(record.name)}. Use one of ${browserToolNames().join(', ')}.`;
    }
    actions.push({ name, input: input as Record<string, unknown> });
  }
  return actions;
}

/**
 * 批量里全是不用批准的工具（只读的与只关自己标签页的）：Host 替用户答应引擎为 browser_batch 发来的审批。参数不对的批量
 * 不替答应（照常问，执行时再报参数错误）。
 */
export function browserBatchAutoAllowed(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const actions = batchActions(input as Record<string, unknown>);
  return (
    typeof actions !== 'string' &&
    actions.every((action) => BROWSER_NO_APPROVAL_TOOLS.includes(action.name))
  );
}

/**
 * 工具事件里的参数：Codex 放在 `arguments` 里，Cursor 的 MCP 调用放在 `args` 里（旁边是 providerIdentifier / toolName），Claude
 * 与 ACP 直接给参数（同 plugin-app-tools.ts）。
 */
export function appToolArgs(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if ('arguments' in record) return record.arguments;
  if (record.providerIdentifier === 'wevir' && 'args' in record) return record.args;
  return input;
}

/**
 * 审批卡片与消息流里显示的内容：批量列出每一步（工具名与参数），脚本写出全文。不是这两个工具、参数认不出时返回
 * undefined。
 */
export function browserComposeDisplay(toolName: string, input: unknown): string | undefined {
  const name = toolName.replace(/^mcp__wevir__/, '');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  if (name === 'browser_run') {
    if (typeof args.script !== 'string') return undefined;
    const tab = typeof args.browserId === 'string' ? `tab = ${args.browserId}\n` : '';
    return `${tab}${args.script}`;
  }
  if (name !== 'browser_batch') return undefined;
  const actions = batchActions(args);
  if (typeof actions === 'string') return undefined;
  const lines = actions.map((action, index) => {
    const shown = Object.keys(action.input).length > 0 ? ` ${JSON.stringify(action.input)}` : '';
    return `${index + 1}. ${action.name}${shown}`;
  });
  return [
    ...(typeof args.browserId === 'string' ? [`browserId: ${args.browserId}`] : []),
    ...lines,
  ].join('\n');
}

async function runBatch(
  options: BrowserComposeOptions,
  args: Record<string, unknown>,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<AppToolResult> {
  const cwd = callerCwd(options.storage, sessionId);
  const actions = batchActions(args);
  if (typeof actions === 'string') return invalid(actions);
  let defaultTab: string | undefined;
  try {
    defaultTab = optionalString(args, 'browserId');
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const allowed = await options.allowedTools?.(sessionId);
  const denied = actions.find((action) => allowed !== undefined && !allowed.has(action.name));
  if (denied) {
    return denial(
      `${denied.name} is not available in this session, so the batch was not run (no action ran).`,
    );
  }
  const timeoutMs = clampTimeout(args.timeoutMs, COMPOSE_DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const content: AppToolResult['content'] = [];
  let images = 0;
  let failed: number | undefined;
  let done = 0;
  for (const [index, action] of actions.entries()) {
    const remaining = deadline - Date.now();
    if (signal.aborted || remaining <= 0) break;
    const spec = browserToolSpec(action.name);
    if (spec === undefined) break;
    const input =
      defaultTab !== undefined &&
      action.input.browserId === undefined &&
      'browserId' in spec.properties
        ? { ...action.input, browserId: defaultTab }
        : action.input;
    const run = await runBrowserSpec(options.broker, spec, input, {
      sessionId,
      signal,
      cwd,
      timeoutMs: remaining,
    });
    done += 1;
    images += appendStep(content, `[${index + 1}] ${action.name}`, run, images);
    if (run.result.isError) {
      failed = index;
      break;
    }
    // 新开的标签页成了之后各步的默认标签页。
    if (run.payload?.ok && run.payload.result.command === 'new_tab') {
      defaultTab = run.payload.result.browserId;
    }
  }
  const total = actions.length;
  const stoppedEarly = failed === undefined && done < total;
  const head =
    failed !== undefined
      ? `Action ${failed + 1} of ${total} (${actions[failed]?.name}) failed; the batch stopped there.${failed + 1 < total ? ` ${notRun(failed + 2, total)}` : ''}`
      : stoppedEarly
        ? `The batch stopped after ${done} of ${total} actions: ${signal.aborted ? 'the call was cancelled' : `it reached its time limit of ${Math.round(timeoutMs / 1000)} s`}. ${notRun(done + 1, total)}`
        : `Ran all ${total} action${total === 1 ? '' : 's'}.`;
  return {
    content: [{ type: 'text', text: head }, ...content],
    ...((failed !== undefined || stoppedEarly) && { isError: true }),
  };
}

/** “Action 3 did not run.” 或 “Actions 3–5 did not run.” */
function notRun(from: number, to: number): string {
  return from === to ? `Action ${from} did not run.` : `Actions ${from}–${to} did not run.`;
}

/** 一步的结果接到批量的结果后面：文字前加步骤号，图片照带（最多 `MAX_IMAGES` 张）；返回带上的图片数。 */
function appendStep(
  content: AppToolResult['content'],
  label: string,
  run: BrowserSpecRun,
  imagesSoFar: number,
): number {
  let images = 0;
  let labelled = false;
  for (const item of run.result.content) {
    if (item.type === 'text') {
      // 只有第一段文字带步骤号（动作之后附上的快照接在后面）。
      content.push({
        type: 'text',
        text: labelled
          ? item.text
          : `${label}${run.result.isError ? ' failed' : ''}:\n${item.text}`,
      });
      labelled = true;
    } else if (imagesSoFar + images < MAX_IMAGES) {
      content.push(item);
      images += 1;
    } else {
      content.push({
        type: 'text',
        text: `${label}: screenshot left out (a result carries at most ${MAX_IMAGES} images).`,
      });
    }
  }
  return images;
}

async function runScript(
  options: BrowserComposeOptions,
  args: Record<string, unknown>,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<AppToolResult> {
  const cwd = callerCwd(options.storage, sessionId);
  const script = args.script;
  if (typeof script !== 'string' || script.trim() === '') {
    return invalid('script is required: the JavaScript to run.');
  }
  if (script.length > SCRIPT_MAX_CHARS) {
    return invalid(
      `script is ${script.length} characters; the limit is ${SCRIPT_MAX_CHARS}. Do less per run.`,
    );
  }
  let browserId: string | undefined;
  try {
    browserId = optionalString(args, 'browserId');
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const allowed = await options.allowedTools?.(sessionId);
  const timeoutMs = clampTimeout(args.timeoutMs, RUN_DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const images: AppToolResult['content'] = [];
  const touched = new Set<string>(browserId === undefined ? [] : [browserId]);
  const run = await runBrowserScript({
    source: script,
    timeoutMs,
    maxCalls: BROWSER_RUN_MAX_CALLS,
    signal,
    ...(browserId !== undefined && { browserId }),
    host: {
      call: async (name, input, callSignal) => {
        if (name === 'sleep') return sleep(input.ms, deadline, callSignal);
        const spec = COMPOSE_TOOLS.includes(name) ? undefined : browserToolSpec(name);
        if (spec === undefined) {
          throw new ScriptCallError(
            'browser_invalid_argument',
            `There is no browser tool ${name}.`,
          );
        }
        if (allowed !== undefined && !allowed.has(name)) {
          throw new ScriptCallError('browser_denied', `${name} is not available in this session.`);
        }
        if (typeof input.browserId === 'string') touched.add(input.browserId);
        else if ('browserId' in spec.properties && spec.name !== 'browser_new_tab') {
          throw new ScriptCallError(
            'browser_invalid_argument',
            'No tab: pass browserId to browser_run, or get one with browser.newTab(url) or browser.tab(browserId).',
          );
        }
        const result = await runBrowserSpec(options.broker, spec, input, {
          sessionId,
          signal: callSignal,
          cwd,
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        // 脚本开的标签页也写进结束时的状态。
        if (result.payload?.ok && result.payload.result.command === 'new_tab') {
          touched.add(result.payload.result.browserId);
        }
        return scriptValue(result, images);
      },
    },
  });
  const tabs = await finalTabs(options, sessionId, cwd, touched);
  return {
    content: [{ type: 'text', text: scriptText(run, tabs) }, ...images],
    ...(run.status !== 'ok' && { isError: true }),
  };
}

/** 一个浏览器调用在脚本里的值：读数据的命令给数据，动作给结果的文字；失败抛给脚本。 */
function scriptValue(run: BrowserSpecRun, images: AppToolResult['content']): unknown {
  const text = run.result.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  if (run.result.isError) {
    const code = /^\[([a-z_]+)\]/.exec(text)?.[1] ?? 'browser_unknown_error';
    throw new ScriptCallError(code, text.replace(/^\[[a-z_]+\]\s*/, ''));
  }
  for (const item of run.result.content) {
    if (item.type === 'image' && images.length < MAX_IMAGES) images.push(item);
  }
  const result = run.payload?.ok ? run.payload.result : undefined;
  switch (result?.command) {
    case 'list_tabs':
      return result.tabs;
    case 'new_tab':
      return { browserId: result.browserId, url: result.url, status: result.status };
    case 'query':
      return { count: result.count, elements: result.elements };
    case 'screenshot':
      return { width: result.width, height: result.height };
    case 'logs':
      return {
        console: result.console,
        network: result.network,
        consoleTotal: result.consoleTotal,
        networkTotal: result.networkTotal,
      };
    case 'network':
      return (
        result.detail ?? { matched: result.matched, total: result.total, entries: result.entries }
      );
    case 'evaluate':
      try {
        return JSON.parse(result.value) as unknown;
      } catch {
        return result.value;
      }
    case 'wait':
      return result.matched;
    default:
      return text;
  }
}

/** 脚本结束时这些标签页的地址与标题（读不到时不写）。 */
async function finalTabs(
  options: BrowserComposeOptions,
  sessionId: SessionId,
  cwd: string,
  touched: ReadonlySet<string>,
): Promise<string[]> {
  if (touched.size === 0 || !options.broker.available) return [];
  const payload = await options.broker.execute({
    sessionId,
    cwd,
    command: { command: 'list_tabs', args: {} },
    timeoutMs: 5_000,
  });
  if (!payload.ok || payload.result.command !== 'list_tabs') return [];
  return payload.result.tabs
    .filter((tab) => touched.has(tab.browserId))
    .map(
      (tab) =>
        `- browserId=${tab.browserId} controller=${tab.controller} title=${JSON.stringify(tab.title || 'Untitled')} url=${tab.url}`,
    );
}

function scriptText(run: ScriptRunResult, tabs: readonly string[]): string {
  const seconds = (run.elapsedMs / 1000).toFixed(1);
  const calls = `${run.calls} browser call${run.calls === 1 ? '' : 's'}`;
  const head =
    run.status === 'ok'
      ? `The script finished in ${seconds} s with ${calls}.`
      : run.status === 'error'
        ? `The script failed after ${seconds} s and ${calls}: ${run.errorCode ? `[${run.errorCode}] ` : ''}${run.error ?? 'error'}`
        : `${run.error ?? 'The script was stopped.'} (${seconds} s, ${calls})`;
  return [
    head,
    ...(run.logs.length > 0 || run.logsDropped > 0
      ? [
          'Console:',
          ...run.logs,
          ...(run.logsDropped > 0 ? [`(${run.logsDropped} more lines left out)`] : []),
        ]
      : []),
    ...(run.status === 'ok'
      ? [run.value === undefined ? 'Returned nothing.' : `Returned: ${run.value}`]
      : []),
    ...(tabs.length > 0 ? ['Tabs now:', ...tabs] : []),
  ].join('\n');
}

function sleep(value: unknown, deadline: number, signal: AbortSignal): Promise<null> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return Promise.reject(
      new ScriptCallError('browser_invalid_argument', 'sleep(ms) needs a number of milliseconds.'),
    );
  }
  const ms = Math.min(value, Math.max(0, deadline - Date.now()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(null);
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new ScriptCallError('browser_unknown_error', 'cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function clampTimeout(value: unknown, fallback: number): number {
  const parsed = optionalInt({ timeoutMs: value }, 'timeoutMs', 1_000, COMPOSE_MAX_TIMEOUT_MS);
  return parsed ?? fallback;
}

function invalid(message: string): AppToolResult {
  return {
    content: [{ type: 'text', text: `[browser_invalid_argument] ${message}` }],
    isError: true,
  };
}

function denial(message: string): AppToolResult {
  return { content: [{ type: 'text', text: `[browser_denied] ${message}` }], isError: true };
}
