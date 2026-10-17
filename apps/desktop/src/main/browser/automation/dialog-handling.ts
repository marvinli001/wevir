// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/dialog-handling.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：对话框事件的类型取自本文件（协议里是开放字符串）；页面里的全局名改成 Wevir 的；beforeunload 离开页面
// （agent 要跳转、Electron 不弹原生框）；prompt 的替身在每个新文档里一直装着（contents.ts 用 Page.addScriptToEvaluateOnNewDocument），
// 不再在命令结束时还原。0.48.0：标签页有对话框策略（browser_dialogs）：confirm 与 prompt 也由替身回答（`disableDialogs` 下原生的
// confirm 只能是 false），按策略接受或取消、给 prompt 填文字，策略烤进每个新文档的脚本里；beforeunload 的策略由 browser-host.ts
// 在 `will-prevent-unload` 里看。

/** 处理掉的一个对话框（协议的 `BrowserDialogEvent`，这里的取值是确定的）。 */
export interface BrowserAutomationDialogEvent {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  action: 'accepted' | 'dismissed';
  /** 接受的 prompt 交给页面的文字。 */
  response?: string;
  timestamp: number;
}

/** 标签页的对话框策略（0.48.0）。alert 总是继续（没有可选的）。 */
export interface DialogPolicy {
  confirm: 'accept' | 'dismiss';
  prompt: 'accept' | 'dismiss';
  /** 接受 prompt 时交给页面的文字；没给时用页面给的默认值。 */
  promptText?: string;
  beforeunload: 'accept' | 'dismiss';
}

/** 默认策略，与 0.46.0 的处理一样：confirm 与 prompt 取消，beforeunload 离开。 */
export const DEFAULT_DIALOG_POLICY: Readonly<DialogPolicy> = Object.freeze({
  confirm: 'dismiss',
  prompt: 'dismiss',
  beforeunload: 'accept',
});

export const MAX_DIALOGS_PER_COMMAND = 20;

export interface JavaScriptDialogOpening {
  type?: unknown;
  message?: unknown;
  defaultPrompt?: unknown;
}

/** `disableDialogs` 下 Chromium 自己怎么回答（CDP 报上来的、没经过替身的对话框）。 */
interface NativeDialogPolicy {
  readonly action: BrowserAutomationDialogEvent['action'];
  readonly accept: boolean;
}

const DIALOG_POLICIES: Record<BrowserAutomationDialogEvent['type'], NativeDialogPolicy> = {
  alert: { action: 'accepted', accept: true },
  confirm: { action: 'dismissed', accept: false },
  prompt: { action: 'dismissed', accept: false },
  beforeunload: { action: 'accepted', accept: true },
};

export function handledDialogEvent(opening: JavaScriptDialogOpening): BrowserAutomationDialogEvent {
  const type = normalizeDialogType(opening.type);
  const policy = DIALOG_POLICIES[type];
  return {
    type,
    message: typeof opening.message === 'string' ? opening.message : String(opening.message ?? ''),
    ...(typeof opening.defaultPrompt === 'string' ? { defaultValue: opening.defaultPrompt } : {}),
    action: policy.action,
    timestamp: Date.now(),
  };
}

export function dialogAcceptValue(type: BrowserAutomationDialogEvent['type']): boolean {
  return DIALOG_POLICIES[type].accept;
}

/**
 * prompt 与 confirm 的替身，按 `policy` 回答并记下来（命令结束时由 `promptShimDrainScript` 取走）。已经装过的只换策略。
 */
export function promptShimInstallScript(policy: DialogPolicy = DEFAULT_DIALOG_POLICY): string {
  return `(() => {
    const stateKey = "__WEVIR_BROWSER_AUTOMATION_DIALOG_STATE__";
    const state = window[stateKey] || { prompts: [], installed: false };
    window[stateKey] = state;
    Object.defineProperty(state, "policy", { configurable: true, writable: true, value: ${JSON.stringify(policy)} });
    if (state.installed) return true;
    const originalPrompt = window.prompt;
    Object.defineProperty(state, "originalPrompt", { configurable: true, value: originalPrompt });
    const promptShim = (message = "", defaultValue = "") => {
      const policy = state.policy || {};
      const accept = policy.prompt === "accept";
      const fallback = defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);
      const response = accept ? (typeof policy.promptText === "string" ? policy.promptText : fallback) : null;
      state.prompts.push({
        type: "prompt",
        message: String(message ?? ""),
        defaultValue: String(defaultValue ?? ""),
        action: accept ? "accepted" : "dismissed",
        ...(accept ? { response } : {}),
        timestamp: Date.now(),
      });
      return response;
    };
    const confirmShim = (message = "") => {
      const accept = (state.policy || {}).confirm === "accept";
      state.prompts.push({
        type: "confirm",
        message: String(message ?? ""),
        action: accept ? "accepted" : "dismissed",
        timestamp: Date.now(),
      });
      return accept;
    };
    Object.defineProperty(state, "promptShim", { configurable: true, value: promptShim });
    window.prompt = promptShim;
    window.confirm = confirmShim;
    state.installed = true;
    return true;
  })()`;
}

export function promptShimDrainScript(): string {
  return `(() => {
    const state = window.__WEVIR_BROWSER_AUTOMATION_DIALOG_STATE__;
    if (!state || !Array.isArray(state.prompts)) return [];
    return state.prompts.splice(0);
  })()`;
}

function normalizeDialogType(value: unknown): BrowserAutomationDialogEvent['type'] {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
    ? value
    : 'alert';
}
