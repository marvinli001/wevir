import { ProviderReasoningLevelSchema } from '@wevir/protocol';

const ORDER: readonly string[] = ProviderReasoningLevelSchema.options;

/**
 * 换模型时沿用的思考力度：新模型有这一档就照用，没有就取它最接近的一档（一样近取低的）；默认档（省略）与没有档位的模型给
 * undefined。
 */
export function carryEffort(
  effort: string | undefined,
  efforts: readonly string[] | undefined,
): string | undefined {
  if (effort === undefined || !efforts || efforts.length === 0) return undefined;
  if (efforts.includes(effort)) return effort;
  const rank = ORDER.indexOf(effort);
  if (rank < 0) return undefined;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of efforts) {
    const index = ORDER.indexOf(candidate);
    if (index < 0) continue;
    const distance = Math.abs(index - rank);
    if (distance < bestDistance || (distance === bestDistance && index < rank)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
