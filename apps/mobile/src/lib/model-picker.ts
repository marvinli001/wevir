// 输入栏里的模型按钮（components/model-picker.tsx）用到的纯逻辑：力度的名字与显示用的档位、力度条上手指位置对应的档位、换模型时
// 沿用什么，以及会话页把改动换成 `session.configure` 的参数。新建会话与会话页共用。

import type { MethodParams, ProviderModel, ProviderProfile, Session } from '@wevir/protocol';
import { type MessageKey, t } from '../i18n';
import { type ModelChoice, modelsOf } from './new-session';

const EFFORT_KEYS: Record<string, MessageKey> = {
  off: 'effort.off',
  minimal: 'effort.minimal',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
  ultra: 'effort.ultra',
};

/** 力度给人看的名字；不认识的档位照原文。 */
export function effortLabel(effort: string | undefined): string {
  if (effort === undefined) return t('effort.default');
  const key = EFFORT_KEYS[effort];
  return key !== undefined ? t(key) : effort;
}

/** 选的模型（来源没列这个模型时 undefined）。 */
export function modelOf(provider: ProviderProfile, choice: ModelChoice): ProviderModel | undefined {
  return modelsOf(provider).find((m) => m.id === choice.modelId);
}

/** 显示用的力度：选了的，否则模型的默认档位；都没有时 undefined。 */
export function effectiveEffort(
  choice: ModelChoice,
  model: ProviderModel | undefined,
): string | undefined {
  return choice.reasoningEffort ?? model?.defaultReasoningEffort;
}

/** 实际的速度：模型不支持快速模式时总是标准。 */
export function effectiveFast(choice: ModelChoice, model: ProviderModel | undefined): boolean {
  if (model?.supportsFast !== true) return false;
  return choice.fast ?? model.fastByDefault ?? false;
}

/** 手指在力度条上的横坐标对应的档位（条按档位等分，超出两端取两端）。 */
export function stepAt(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((x / width) * count)));
}

/** 换模型：力度在新模型的档位里时沿用；开着快速模式且新模型支持时沿用，否则取新模型的默认速度。 */
export function withModel(
  provider: ProviderProfile,
  choice: ModelChoice,
  modelId: string,
): ModelChoice {
  const model = modelsOf(provider).find((m) => m.id === modelId);
  const effort = choice.reasoningEffort;
  return {
    providerId: provider.id,
    modelId,
    ...(effort !== undefined &&
      (model?.reasoningEfforts as readonly string[] | undefined)?.includes(effort) && {
        reasoningEffort: effort,
      }),
    ...(choice.fast === true && model?.supportsFast === true && { fast: true }),
  };
}

/** 会话现在的模型选择；会话没写 `fast` 是标准速度（不是模型的默认速度）。 */
export function sessionChoice(
  session: Pick<Session, 'providerId' | 'modelId' | 'reasoningEffort' | 'fast'>,
): ModelChoice {
  return {
    providerId: session.providerId,
    modelId: session.modelId,
    ...(session.reasoningEffort !== undefined && { reasoningEffort: session.reasoningEffort }),
    fast: session.fast === true,
  };
}

/**
 * 会话页的改动换成 `session.configure` 的参数，只带改了的字段；没改时 undefined。换了模型时总带上力度（没有就清掉，同 Host 的
 * 规矩），速度没改时由 Host 按新模型定。只在同一个来源里换。
 */
export function configureParams(
  sessionId: Session['id'],
  current: ModelChoice,
  next: ModelChoice,
): MethodParams<'session.configure'> | undefined {
  const modelChanged = next.modelId !== current.modelId;
  const effortChanged = next.reasoningEffort !== current.reasoningEffort;
  const fastChanged = (next.fast === true) !== (current.fast === true);
  if (!modelChanged && !effortChanged && !fastChanged) return undefined;
  return {
    sessionId,
    ...(modelChanged && { modelId: next.modelId }),
    ...((modelChanged || effortChanged) && { reasoningEffort: next.reasoningEffort ?? null }),
    ...(fastChanged && { fast: next.fast === true }),
  };
}
