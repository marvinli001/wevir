import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BaselineReportSchema, type UsageFilter, type UsageSavings } from '@wevir/protocol';
import { comparePaired } from './baseline.js';

export async function baselineSavings(
  dir: string,
  from: number,
  to: number,
  filter?: UsageFilter,
): Promise<UsageSavings | undefined> {
  if (filter?.precision !== undefined && filter.precision !== 'exact') return undefined;
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const eligible: UsageSavings[] = [];
  for (const name of files.filter((file) => file.endsWith('.json'))) {
    try {
      const file = join(dir, name);
      if ((await stat(file)).size > 8 * 1024 * 1024) continue;
      const parsed = BaselineReportSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success) continue;
      const report = parsed.data;
      const at = Date.parse(report.generatedAt);
      if (
        at < from ||
        at >= to ||
        (filter?.models?.length && !filter.models.includes(report.model)) ||
        (filter?.providerIds?.length && !filter.providerIds.includes(report.providerId)) ||
        (filter?.sources?.length && !filter.sources.includes('deepseek-official'))
      )
        continue;
      const paired = comparePaired(report.runs, 'A', 'B');
      if (paired.verdict !== 'cheaper' || paired.costDelta === undefined) continue;
      eligible.push({
        id: name.slice(0, -5),
        baseline: `${report.configs.A.name} · ${report.commit}`,
        candidate: report.configs.B.name,
        model: report.model,
        pairs: paired.n,
        precision: 'exact',
        costPerTask: -paired.costDelta.mean,
        agentRequestsDelta: paired.agentRequestsDelta.mean,
        costInterval: paired.costDelta.ci95,
        generatedAt: report.generatedAt,
        priceAt: report.priceSnapshot.at,
      });
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      throw error;
    }
  }
  return eligible.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
}
