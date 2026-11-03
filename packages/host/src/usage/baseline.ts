import type { UsageCost, UsageTokens } from '@wevir/protocol';

export interface BaselineRun {
  arm: string;
  pair: number;
  order: number;
  precision: 'exact' | 'engine' | 'estimate' | 'turn';
  success: boolean;
  check: unknown;
  environmentError?: string;
  turns: number;
  requests: {
    total: number;
    agent: number;
    compaction: number;
    subagent: number;
    auxiliary: number;
    unknown: number;
    capHit: boolean;
  };
  compactions: { manual: number; auto: number };
  tokens: UsageTokens;
  cost?: UsageCost;
  cacheHitRate: number;
  supply: {
    toolCountFirst: number;
    toolBytesFirst: number;
    toolBytesMean: number;
    toolBytesChanged: boolean;
    instructionBytes: number;
    mcpNoteBytes: number;
    wevirOutputBytes: number;
    wevirCalls: number;
  };
  estimates: {
    precision: 'estimate';
    toolTokensAtCacheRead: number;
    toolCostAtCacheRead?: number;
    toolCostAtInput?: number;
    toolCostShare?: { cacheRead: number; input: number };
  };
  wallMs: number;
  ledgerMismatch: string[];
}

export function pairedOrder(
  a: string,
  b: string,
  pairs: number,
): Array<{ arm: string; pair: number; order: number }> {
  return Array.from({ length: pairs }, (_, pair) =>
    (pair % 2 === 0 ? [a, b] : [b, a]).map((arm, index) => ({
      arm,
      pair: pair + 1,
      order: pair * 2 + index + 1,
    })),
  ).flat();
}

export function statistics(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: median(sorted),
    mean: mean(sorted),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}
function median(sorted: readonly number[]): number {
  const i = Math.floor(sorted.length / 2);
  return sorted.length === 0
    ? 0
    : sorted.length % 2 === 0
      ? ((sorted[i - 1] as number) + (sorted[i] as number)) / 2
      : (sorted[i] as number);
}

function delta(pairs: ReadonlyArray<readonly [number, number]>) {
  const differences = pairs.map(([a, b]) => b - a);
  let seed = 0x2c71a9;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const samples = Array.from({ length: 10_000 }, () =>
    mean(differences.map(() => differences[Math.floor(random() * differences.length)] as number)),
  ).sort((a, b) => a - b);
  const relative = pairs.flatMap(([a, b]) => (a === 0 ? [] : [b / a - 1])).sort((a, b) => a - b);
  return {
    ...statistics(differences),
    relativeMedian: relative.length === 0 ? null : median(relative),
    ci95: [samples[250] ?? 0, samples[9749] ?? 0] as [number, number],
  };
}

type ComparableRun = Pick<
  BaselineRun,
  | 'arm'
  | 'pair'
  | 'precision'
  | 'success'
  | 'environmentError'
  | 'tokens'
  | 'cost'
  | 'ledgerMismatch'
> & { requests: Pick<BaselineRun['requests'], 'total' | 'agent' | 'capHit'> };

export function comparePaired(runs: readonly ComparableRun[], a: string, b: string) {
  const pairs: Array<[ComparableRun, ComparableRun]> = [];
  const excluded: Array<{ pair: number; reason: string }> = [];
  for (const pair of [...new Set(runs.map((run) => run.pair))].sort((x, y) => x - y)) {
    const left = runs.filter((run) => run.pair === pair && run.arm === a);
    const right = runs.filter((run) => run.pair === pair && run.arm === b);
    const A = left[0];
    const B = right[0];
    const reason =
      left.length !== 1 || right.length !== 1 || A === undefined || B === undefined
        ? 'incomplete_pair'
        : A.requests.capHit || B.requests.capHit
          ? 'request_cap'
          : A.environmentError !== undefined || B.environmentError !== undefined
            ? 'environment'
            : A.precision !== 'exact' || B.precision !== 'exact'
              ? 'precision'
              : A.ledgerMismatch.length + B.ledgerMismatch.length > 0
                ? 'ledger_mismatch'
                : undefined;
    if (reason !== undefined || A === undefined || B === undefined) {
      excluded.push({ pair, reason: reason ?? 'incomplete_pair' });
      continue;
    }
    pairs.push([A, B]);
  }
  const n = pairs.length;
  const agentRequestsDelta = delta(pairs.map(([A, B]) => [A.requests.agent, B.requests.agent]));
  const tokensDelta = delta(pairs.map(([A, B]) => [tokenTotal(A.tokens), tokenTotal(B.tokens)]));
  const priced = n > 0 && pairs.every(([A, B]) => A.cost !== undefined && B.cost !== undefined);
  const costDelta = priced
    ? delta(pairs.map(([A, B]) => [A.cost?.total as number, B.cost?.total as number]))
    : undefined;
  const aSuccess = pairs.filter(([A]) => A.success).length;
  const bSuccess = pairs.filter(([, B]) => B.success).length;
  const verdict =
    n < 5 || costDelta === undefined
      ? ('inconclusive' as const)
      : costDelta.ci95[1] < 0 && bSuccess >= aSuccess && agentRequestsDelta.ci95[0] <= 0
        ? ('cheaper' as const)
        : costDelta.ci95[0] > 0
          ? ('costlier' as const)
          : ('inconclusive' as const);
  return {
    n,
    excluded,
    ...(costDelta !== undefined && { costDelta }),
    agentRequestsDelta,
    tokensDelta,
    wins: `${pairs.filter(([A, B]) => A.cost !== undefined && B.cost !== undefined && B.cost.total < A.cost.total).length}/${n}`,
    successRate: { A: `${aSuccess}/${n}`, B: `${bSuccess}/${n}` },
    verdict,
  };
}

export function summarizeArm(runs: readonly BaselineRun[]) {
  const numbers = new Map<string, number[]>();
  const collect = (value: unknown, path: string) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const values = numbers.get(path) ?? [];
      values.push(value);
      numbers.set(path, values);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value))
      for (const [key, item] of Object.entries(value))
        collect(item, path === '' ? key : `${path}.${key}`);
  };
  for (const run of runs) collect(run, '');
  return {
    metrics: Object.fromEntries([...numbers].map(([key, values]) => [key, statistics(values)])),
    successRate: `${runs.filter((run) => run.success).length}/${runs.length}`,
  };
}

function tokenTotal(tokens: UsageTokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}
