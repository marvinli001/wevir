import type { HostSettings, PromptSuggestion, SessionState } from '@wevir/protocol';

// 输入建议（0.53.0，domain-model §3.23）的显示规则：Host 在回合正常结束后给出会话的“当前建议”（`Transcript.promptSuggestion`），
// 这里决定它什么时候以灰色文字放在输入框里、哪些键接受它。纯逻辑，输入框（composer.tsx）只管渲染。

/** Host 设置里输入建议的开关；旧 Host 的设置里没有这一项，当作开。 */
export function suggestionsEnabled(settings: Pick<HostSettings, 'promptSuggestions'>): boolean {
  return settings.promptSuggestions !== false;
}

export interface SuggestionContext {
  /** Host 声明了 `prompt_suggestions`。 */
  supported: boolean;
  /** 设置里开着（`suggestionsEnabled`）。 */
  enabled: boolean;
  state: SessionState | undefined;
  /** 会话只读、还没连上 Host。 */
  disabled: boolean;
  /** 计划模式开着，或计划已给出等着“实施”：这时空输入框的主按钮另有用途。 */
  planBusy: boolean;
  /** 有待回答的问题：回答前不预测。 */
  awaitingInput: boolean;
}

/**
 * 会话当前该显示的建议文字；没有时 undefined。条件：Host 支持、设置开着、会话空闲、能发消息、不在计划流程里、没有待答的问题。
 * Host 已经在这些情况下不生成，但旧的建议（设置刚关掉、计划模式刚打开）还在快照里，这里再挡一次。
 */
export function visibleSuggestion(
  suggestion: PromptSuggestion | undefined,
  context: SuggestionContext,
): string | undefined {
  if (suggestion === undefined) return undefined;
  if (!context.supported || !context.enabled || context.disabled) return undefined;
  if (context.state !== 'idle' || context.planBusy || context.awaitingInput) return undefined;
  const text = suggestion.text.trim();
  return text === '' ? undefined : text;
}

/** 输入框的状态：灰色建议只在输入框完全空着（没有文字、没有图片）时显示。 */
export function ghostText(
  suggestion: string | undefined,
  composer: { text: string; imageCount: number; menuOpen: boolean },
): string | undefined {
  if (suggestion === undefined) return undefined;
  if (composer.text !== '' || composer.imageCount > 0 || composer.menuOpen) return undefined;
  return suggestion;
}

export interface SuggestionKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** 输入法合成中。 */
  composing: boolean;
}

/** 接受建议的键：Tab 或 →，不带修饰键、不在输入法合成中。（Shift+Tab 是计划模式开关，不在这里。） */
export function isAcceptKey(event: SuggestionKey): boolean {
  if (event.composing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return event.key === 'Tab' || event.key === 'ArrowRight';
}
