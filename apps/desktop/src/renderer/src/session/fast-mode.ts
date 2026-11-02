import type { ProviderModel, ProviderProfile } from '@wevir/protocol';

/** 模型选择里与快速模式有关的部分（`ModelChoice`）：`fast` 省略表示用模型的默认（`fastByDefault`）。 */
interface FastChoice {
  providerId: string;
  modelId: string;
  fast?: boolean;
}

/** 来源的这个模型有快速模式（0.148.0，`ProviderModel.supportsFast`）时返回它。 */
function fastModel(
  provider: Pick<ProviderProfile, 'models'> | undefined,
  modelId: string,
): ProviderModel | undefined {
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  return model?.supportsFast === true ? model : undefined;
}

/** 弹层显示快速模式开关的条件：Host 给这个来源的这个模型标了 `supportsFast`。 */
export function supportsFast(
  provider: Pick<ProviderProfile, 'models'> | undefined,
  modelId: string,
): boolean {
  return fastModel(provider, modelId) !== undefined;
}

/** 选择实际是不是快速模式（芯片前的闪电）：模型支持时取 `fast`，没选过时取模型的默认。 */
export function isFast(
  provider: Pick<ProviderProfile, 'models'> | undefined,
  choice: FastChoice,
): boolean {
  const model = fastModel(provider, choice.modelId);
  return model !== undefined && (choice.fast ?? model.fastByDefault === true);
}

/**
 * 交给 Host 的 `fast`（`session.create` / `session.configure`）：模型不支持时不带；没选过时不带，Host 取模型的默认（建会话）或
 * 沿用会话的值（换设置）。
 */
export function fastParam(
  provider: Pick<ProviderProfile, 'models'> | undefined,
  choice: FastChoice,
): { fast?: boolean } {
  return choice.fast !== undefined && supportsFast(provider, choice.modelId)
    ? { fast: choice.fast }
    : {};
}
