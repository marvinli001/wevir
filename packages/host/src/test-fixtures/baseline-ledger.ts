import { responsesCatalog } from '@wevir/model-gateway';
import type { UsageCost, UsageRecord, UsageTokens, UsageTurn } from '@wevir/protocol';
import type { BaselineRun } from '../usage/baseline.js';
import type { PricingStore } from '../usage/pricing.js';
import { costOf } from '../usage/usage-service.js';

export function ledgerRun(input: {
  arm: string;
  pair: number;
  order: number;
  success: boolean;
  check: unknown;
  wallMs: number;
  capHit: boolean;
  records: UsageRecord[];
  turns: UsageTurn[];
  observed: ReadonlyArray<{
    body: unknown;
    usage?: {
      input: number;
      cachedInput: number;
      cacheWrite?: number;
      output: number;
      reasoning?: number;
    };
  }>;
  pricing: PricingStore;
  pricingAt: number;
}): BaselineRun {
  const { records, turns } = input;
  if (records.some((row) => row.precision !== 'exact'))
    throw new Error('baseline requires exact gateway records');
  const unmatched = [...records];
  const ledgerMismatch: string[] = records.length === 0 ? ['no ledger records'] : [];
  for (const [index, observed] of input.observed.entries()) {
    const stats = responsesCatalog(observed.body as Record<string, unknown>);
    const usage = observed.usage;
    const match = unmatched.findIndex(
      (row) =>
        row.supply?.toolBytes === stats.toolBytes &&
        row.supply.requestBytes === stats.requestBytes &&
        row.supply.instructionBytes === stats.instructionBytes &&
        (usage === undefined
          ? row.usageReported === false
          : row.tokens.input === usage.input - usage.cachedInput - (usage.cacheWrite ?? 0) &&
            row.tokens.cacheRead === usage.cachedInput &&
            row.tokens.cacheWrite === (usage.cacheWrite ?? 0) &&
            row.tokens.output === usage.output &&
            row.tokens.reasoning === (usage.reasoning ?? 0)),
    );
    if (match < 0) ledgerMismatch.push(`upstream request ${index + 1}`);
    else unmatched.splice(match, 1);
  }
  ledgerMismatch.push(...unmatched.map((row) => `ledger request ${row.requestId}`));
  const tokens: UsageTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  const cost: UsageCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  let priced = true;
  let toolTokens = 0;
  let toolCostAtCacheRead = 0;
  let toolCostAtInput = 0;
  for (const row of records) {
    for (const key of Object.keys(tokens) as Array<keyof UsageTokens>)
      tokens[key] += row.tokens[key];
    const totalInput = row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite;
    const price = input.pricing.lookup(
      row.model,
      { source: row.source, ...(row.upstream !== undefined && { upstream: row.upstream }) },
      totalInput,
      input.pricingAt,
    )?.price;
    if (price === undefined || row.usageReported === false) priced = false;
    else {
      const item = costOf(row.tokens, price);
      for (const key of Object.keys(cost) as Array<keyof UsageCost>) cost[key] += item[key];
    }
    const estimated =
      row.supply === undefined ? 0 : (row.supply.toolBytes / row.supply.requestBytes) * totalInput;
    toolTokens += estimated;
    if (price !== undefined) {
      toolCostAtCacheRead += (estimated * (price.cacheRead ?? price.input)) / 1e6;
      toolCostAtInput += (estimated * price.input) / 1e6;
    }
  }
  const agent = records.filter((row) => row.kind === 'agent');
  const supplies = agent.flatMap((row) => (row.supply === undefined ? [] : [row.supply]));
  const first = supplies[0];
  const requestCount = (kind: string) => records.filter((row) => row.kind === kind).length;
  const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return {
    arm: input.arm,
    pair: input.pair,
    order: input.order,
    precision: records.every((row) => row.precision === 'exact') ? 'exact' : 'engine',
    success: input.success,
    check: input.check,
    turns: turns.filter((turn) => turn.turnId !== undefined).length,
    requests: {
      total: records.length,
      agent: agent.length,
      compaction: requestCount('compaction'),
      subagent: requestCount('subagent'),
      auxiliary: requestCount('auxiliary'),
      unknown: records.filter((row) => row.kind === undefined).length,
      capHit: input.capHit,
    },
    compactions: {
      manual: turns.reduce((sum, turn) => sum + turn.compactions.manual, 0),
      auto: turns.reduce((sum, turn) => sum + turn.compactions.auto, 0),
    },
    tokens,
    ...(priced && { cost }),
    cacheHitRate: inputTokens === 0 ? 0 : tokens.cacheRead / inputTokens,
    supply: {
      toolCountFirst: first?.toolCount ?? 0,
      toolBytesFirst: first?.toolBytes ?? 0,
      toolBytesMean:
        supplies.reduce((sum, supply) => sum + supply.toolBytes, 0) / (supplies.length || 1),
      toolBytesChanged: supplies.some((supply) => supply.toolBytes !== first?.toolBytes),
      instructionBytes: records.reduce((sum, row) => sum + (row.supply?.instructionBytes ?? 0), 0),
      mcpNoteBytes: records.reduce((sum, row) => sum + (row.supply?.mcpNoteBytes ?? 0), 0),
      wevirOutputBytes: records.reduce(
        (sum, row) => sum + (row.supply?.wevirOutputBytesNew ?? 0),
        0,
      ),
      wevirCalls: turns.reduce((sum, turn) => sum + turn.toolCalls.calls, 0),
    },
    estimates: {
      precision: 'estimate',
      toolTokensAtCacheRead: toolTokens,
      ...(priced && {
        toolCostAtCacheRead,
        toolCostAtInput,
        ...(cost.total > 0 && {
          toolCostShare: {
            cacheRead: toolCostAtCacheRead / cost.total,
            input: toolCostAtInput / cost.total,
          },
        }),
      }),
    },
    wallMs: input.wallMs,
    ledgerMismatch,
  };
}
