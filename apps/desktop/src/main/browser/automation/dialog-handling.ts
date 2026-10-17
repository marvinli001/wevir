// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/dialog-handling.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：对话框事件的类型取自本文件（协议里是开放字符串）；页面里的全局名改成 Wevir 的；beforeunload 离开页面
// （agent 要跳转、Electron 不弹原生框）；prompt 的替身在每个新文档里一直装着（contents.ts 用 Page.addScriptToEvaluateOnNewDocument），
// 不再在命令结束时还原。

/** 处理掉的一个对话框（协议的 `BrowserDialogEvent`，这里的取值是确定的）。 */
export interface BrowserAutomationDialogEvent {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  action: 'accepted' | 'dismissed';
  timestamp: number;
}

export const MAX_DIALOGS_PER_COMMAND = 20;

export interface JavaScriptDialogOpening {
  type?: unknown;
  message?: unknown;
  defaultPrompt?: unknown;
}

interface DialogPolicy {
  readonly action: BrowserAutomationDialogEvent['action'];
  readonly accept: boolean;
}

const DIALOG_POLICIES: Record<BrowserAutomationDialogEvent['type'], DialogPolicy> = {
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

export function promptShimInstallScript(): string {
  return `(() => {
    const stateKey = "__WEVIR_BROWSER_AUTOMATION_DIALOG_STATE__";
    const state = window[stateKey] || { prompts: [], installed: false };
    window[stateKey] = state;
    if (state.installed) return true;
    const originalPrompt = window.prompt;
    Object.defineProperty(state, "originalPrompt", { configurable: true, value: originalPrompt });
    const promptShim = (message = "", defaultValue = "") => {
      state.prompts.push({
        type: "prompt",
        message: String(message ?? ""),
        defaultValue: String(defaultValue ?? ""),
        action: "dismissed",
        timestamp: Date.now(),
      });
      return null;
    };
    Object.defineProperty(state, "promptShim", { configurable: true, value: promptShim });
    window.prompt = promptShim;
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
