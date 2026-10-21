// 写作风格的存储（0.95.0，domain-model §3.43）：档案与建档用的样本工作副本，都在 Host 数据目录里，不进任何项目文件夹（样本是用户的
// 私人原文，不能被提交或同步）。
//
// 布局：`<数据目录>/writing-style/profile.json` 是档案（正文、谁在什么时候写的、建档走完没有）；`samples/<落点>/<文件>.txt` 是样本，
// 一个文件一份，文件名 `<受众>__<来源>__<日期>__<序号>`（stylometry.ts 按它合并聊天与分受众）。目录 0700、文件 0600。
//
// 样本只在建档期间留着：Agent 保存档案时带上 `setup_complete`、用户删档案、关掉设置、或放了超过 `SAMPLES_MAX_AGE_MS` 都会删掉。
// 来源与日期由这里清洗后拼进文件名，模型给的原文进不了路径。

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  WRITING_STYLE_MAX_LENGTH,
  type WritingStyleAuthor,
  type WritingStyleProfile,
  WritingStyleProfileSchema,
} from '@wevir/protocol';
import { analyzeSamples, type SampleFile } from './stylometry.js';

/** 落点：写到哪里去的。Wevir 里的聊天记录归 `chat`。 */
export const WRITING_REGISTERS = ['email', 'chat', 'dm', 'doc'] as const;
export type WritingRegister = (typeof WRITING_REGISTERS)[number];

/** 受众：写给谁的（固定的几种，拼进文件名）。`agent` 是用户在 Wevir 里写给 Agent 的消息。 */
export const WRITING_AUDIENCES = [
  'customer',
  'team',
  'external',
  'internal',
  'personal',
  'agent',
] as const;
export type WritingAudience = (typeof WRITING_AUDIENCES)[number];

/** 一份样本最多多少个字符；长文档只取有代表性的一段（约 1,500 词）。 */
export const SAMPLE_MAX_CHARS = 12_000;
/** 全部样本最多多少个字符：再多分析就变差，成本也超过收益。 */
export const SAMPLES_MAX_CHARS = 300_000;
/** 最多多少个样本文件（聊天一条消息一个文件）。 */
export const SAMPLES_MAX_FILES = 1500;
/** 样本放了多久没动就删（建档中途离开，下次 Host 启动或下次用时清掉）。 */
export const SAMPLES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class WritingStyleError extends Error {}

const StoredSchema = WritingStyleProfileSchema.omit({ revision: true });
type Stored = Omit<WritingStyleProfile, 'revision'>;

/** 一批样本里的一份。 */
export interface SampleInput {
  text: string;
  /** 来源（对话、频道、文档名），清洗成 `[a-z0-9-]`，最长 40 个字符；省略时 `misc`。 */
  source?: string;
  /** `YYYY-MM-DD`；省略或不合法时用今天。 */
  date?: string;
}

/** 现有样本的概况。 */
export interface SampleSummary {
  /** 落点 → 受众 → 文件数。 */
  registers: Record<string, Record<string, number>>;
  files: number;
  chars: number;
  /** 还能放多少个字符。 */
  remainingChars: number;
}

export function sampleSlug(source: string | undefined): string {
  const slug = (source ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  return slug === '' ? 'misc' : slug;
}

function sampleDate(date: string | undefined, now: Date): string {
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return now.toISOString().slice(0, 10);
}

function revisionOf(stored: Stored): string {
  return createHash('sha256').update(JSON.stringify(stored)).digest('hex').slice(0, 16);
}

export interface WritingStyleStoreOptions {
  /** `<数据目录>/writing-style`。 */
  dir: string;
  now?: () => Date;
}

export class WritingStyleStore {
  readonly #dir: string;
  readonly #now: () => Date;
  /** 写操作排队，保存档案与写样本不会交错。 */
  #queue: Promise<unknown> = Promise.resolve();

  constructor({ dir, now = () => new Date() }: WritingStyleStoreOptions) {
    this.#dir = dir;
    this.#now = now;
  }

  get #profilePath() {
    return join(this.#dir, 'profile.json');
  }

  get samplesDir() {
    return join(this.#dir, 'samples');
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** 现在的档案；没有或文件坏了时 `undefined`。 */
  async get(): Promise<WritingStyleProfile | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#profilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const parsed = StoredSchema.safeParse(json);
    if (!parsed.success) return undefined;
    return { ...parsed.data, revision: revisionOf(parsed.data) };
  }

  /**
   * 整份替换档案（没有时新建）。带 `revision` 而档案已经变了时不写，返回现在的档案与 `conflict`。`setupComplete` 一旦为真就一直为真；
   * 这次让它变成真时顺带删掉样本。用户写的档案算建档走完。
   */
  save(
    content: string,
    options: { by: WritingStyleAuthor; setupComplete?: boolean; revision?: string },
  ): Promise<{ profile: WritingStyleProfile; conflict?: true }> {
    return this.#serial(async () => {
      const body = content.trim();
      if (body === '') throw new WritingStyleError('The profile is empty.');
      if (body.length > WRITING_STYLE_MAX_LENGTH) {
        throw new WritingStyleError(
          `The profile is ${body.length} characters; the limit is ${WRITING_STYLE_MAX_LENGTH}. Tighten it and save the whole profile again.`,
        );
      }
      const current = await this.get();
      if (
        options.revision !== undefined &&
        current !== undefined &&
        current.revision !== options.revision
      ) {
        return { profile: current, conflict: true };
      }
      const setupComplete =
        current?.setupComplete === true || options.setupComplete === true || options.by === 'user';
      const stored: Stored = {
        content: body,
        updatedAt: this.#now().toISOString(),
        updatedBy: options.by,
        setupComplete,
      };
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      const tmp = join(this.#dir, `.profile.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.#profilePath);
      if (setupComplete && current?.setupComplete !== true) await this.#removeSamples();
      return { profile: { ...stored, revision: revisionOf(stored) } };
    });
  }

  /** 删掉档案与样本；没有时也成功。 */
  delete(): Promise<void> {
    return this.#serial(async () => {
      await rm(this.#profilePath, { force: true });
      await this.#removeSamples();
    });
  }

  /** 删掉样本的工作副本；返回删前有没有。 */
  discardSamples(): Promise<boolean> {
    return this.#serial(async () => {
      const had = (await this.#sampleFiles()).length > 0;
      await this.#removeSamples();
      return had;
    });
  }

  /** 样本放了超过 `SAMPLES_MAX_AGE_MS`（按最后一次写入）时删掉；返回删了没有。 */
  pruneStale(): Promise<boolean> {
    return this.#serial(() => this.#pruneStale());
  }

  async #pruneStale(): Promise<boolean> {
    let modified: number;
    try {
      modified = (await stat(this.samplesDir)).mtimeMs;
    } catch {
      return false;
    }
    if (this.#now().getTime() - modified < SAMPLES_MAX_AGE_MS) return false;
    await this.#removeSamples();
    return true;
  }

  async #removeSamples() {
    await rm(this.samplesDir, { recursive: true, force: true });
  }

  /** 加一批样本，返回写下了几份与之后的概况。超出单份上限的截断，超出总量的不写。 */
  addSamples(
    register: WritingRegister,
    audience: WritingAudience,
    items: readonly SampleInput[],
  ): Promise<{ added: number; truncated: number; skipped: number; summary: SampleSummary }> {
    return this.#serial(async () => {
      await this.#pruneStale();
      const files = await this.#sampleFiles();
      let chars = files.reduce((sum, file) => sum + file.chars, 0);
      let count = files.length;
      const used = new Set(files.map((file) => `${file.register}/${file.stem}`));
      const dir = join(this.samplesDir, register);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let added = 0;
      let truncated = 0;
      let skipped = 0;
      const now = this.#now();
      for (const item of items) {
        let text = item.text.replace(/\r\n?/g, '\n').trim();
        if (text === '') {
          skipped += 1;
          continue;
        }
        if (text.length > SAMPLE_MAX_CHARS) {
          text = text.slice(0, SAMPLE_MAX_CHARS);
          truncated += 1;
        }
        if (chars + text.length > SAMPLES_MAX_CHARS || count >= SAMPLES_MAX_FILES) {
          skipped += 1;
          continue;
        }
        const base = `${audience}__${sampleSlug(item.source)}__${sampleDate(item.date, now)}`;
        let n = 1;
        while (used.has(`${register}/${base}__${String(n).padStart(3, '0')}`)) n += 1;
        const stem = `${base}__${String(n).padStart(3, '0')}`;
        used.add(`${register}/${stem}`);
        await writeFile(join(dir, `${stem}.txt`), text, { mode: 0o600 });
        chars += text.length;
        count += 1;
        added += 1;
      }
      return { added, truncated, skipped, summary: await this.#summary() };
    });
  }

  summary(): Promise<SampleSummary> {
    return this.#serial(() => this.#summary());
  }

  async #summary(): Promise<SampleSummary> {
    const files = await this.#sampleFiles();
    const registers: Record<string, Record<string, number>> = {};
    for (const file of files) {
      const audience = file.stem.split('__')[0] ?? 'misc';
      const counts = registers[file.register] ?? {};
      counts[audience] = (counts[audience] ?? 0) + 1;
      registers[file.register] = counts;
    }
    const chars = files.reduce((sum, file) => sum + file.chars, 0);
    return {
      registers,
      files: files.length,
      chars,
      remainingChars: Math.max(0, SAMPLES_MAX_CHARS - chars),
    };
  }

  /** 跑文体统计；没有能用的样本时 `undefined`。 */
  analyze(): Promise<ReturnType<typeof analyzeSamples>> {
    return this.#serial(async () => {
      const byRegister = new Map<string, SampleFile[]>();
      for (const file of await this.#sampleFiles()) {
        const list = byRegister.get(file.register) ?? [];
        list.push({ stem: file.stem, text: file.text });
        byRegister.set(file.register, list);
      }
      return analyzeSamples(byRegister);
    });
  }

  async #sampleFiles(): Promise<{ register: string; stem: string; text: string; chars: number }[]> {
    const result: { register: string; stem: string; text: string; chars: number }[] = [];
    for (const register of WRITING_REGISTERS) {
      let names: string[];
      try {
        names = await readdir(join(this.samplesDir, register));
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.txt')) continue;
        const text = await readFile(join(this.samplesDir, register, name), 'utf8');
        result.push({ register, stem: name.slice(0, -4), text, chars: text.length });
      }
    }
    return result;
  }
}
