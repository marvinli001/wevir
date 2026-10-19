// 跨会话记忆（domain-model §3.21）：agent 经 `wevir_memory_*` 工具把以后的会话用得上的事实存成小文件，Host 在会话开始时把索引
// 放进应用级工具的说明（app-mcp.ts 的 `instructions`）。形态照 Claude Code 的 auto memory：每条记忆一个带 frontmatter 的 .md，
// 分 user / feedback / project / reference 四类；不同的是存在 Host 数据目录里（全局一份、每个项目一份），不在项目文件夹里，
// 所有引擎共用，开源仓库也不会带进私人内容。索引不落盘，每次由文件生成，不会和文件对不上。
//
// 用户在设置里管理（0.57.0 的 `memory.*`）：看、改、停用、删。停用的笔记写成 frontmatter 的 `disabled: true`，Agent 列不出、读不到，
// 也不能用同名保存把它换掉；用户改动带着读到的版本（文件内容的散列），中间被 Agent 或别的窗口改过就不写。认不出的 frontmatter
// 字段改写时原样留着（新版本加的字段不会被旧逻辑丢掉）。
//
// 来源（0.58.0）：每次写入记下谁写的。Agent 保存时由 Host 从调工具的会话填上会话、进行中的回合与最后一个事件（`created-*` 是第一次
// 写下的，`updated-*` 是最近一次改写的），用户在设置里改时记 `updated-by: user`；之前存的笔记没有这些字段，不补造。Agent 改写或删除
// 别人（用户或别的会话）写的笔记要带着读到的版本，否则当作冲突：不会悄悄覆盖用户刚改的内容。来源只说明在哪写下，不说明内容属实；
// 文件的修改时间不参与任何判断。
//
// 布局：`<数据目录>/memory/global/<名字>.md`，`<数据目录>/memory/projects/<工作区 ID>/<名字>.md`。

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_DESCRIPTION_MAX,
  MEMORY_MAX_PER_SCOPE,
  MemoryScopeSchema,
  MemorySourceSchema,
  MemoryTypeSchema,
  type MemorySource as ProtocolMemorySource,
  type SessionId,
  type TurnId,
} from '@wevir/protocol';

export { MEMORY_CONTENT_MAX_BYTES, MEMORY_DESCRIPTION_MAX, MEMORY_MAX_PER_SCOPE };

export const MEMORY_TYPES = MemoryTypeSchema.options;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const MEMORY_SCOPES = MemoryScopeSchema.options;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** 名字：小写字母、数字、连字符，文件名也用它（同 protocol 的 `MemoryNameSchema`）。 */
export const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** 放进会话说明的索引上限（UTF-8 字节）；超出的只留条数。 */
export const MEMORY_INDEX_MAX_BYTES = 6000;

export interface MemoryNote {
  scope: MemoryScope;
  name: string;
  type: MemoryType;
  description: string;
  content: string;
  updatedAt: string;
  /** 停用的笔记 Agent 看不到；只有用户能重新启用。 */
  enabled: boolean;
  /** 这一版的标识：文件内容的散列，文件每次改动都会变。 */
  revision: string;
  /** 第一次写下的来源；0.58.0 之前存的笔记没有。 */
  origin?: MemorySource;
  /** 最近一次改写的来源；没有记录时省略。 */
  lastEdit?: MemorySource;
}

/** 一次写入的来源（Host 填写，见文件头）。线缆上 `memory.read` 另加 `status`。 */
export type MemorySource = Omit<ProtocolMemorySource, 'status'>;

/** Agent 保存或删除时的调用方：调工具的会话，加上当时进行中的回合与会话最后一个事件。 */
export interface MemoryAgentWriter {
  sessionId: SessionId;
  turnId?: TurnId;
  seq?: number;
}

export type MemorySummary = Omit<MemoryNote, 'content'>;

export type MemoryErrorCode =
  | 'invalid'
  | 'not_found'
  | 'limit'
  | 'no_project'
  | 'disabled'
  | 'conflict';

/** 参数不合规、找不到、超出上限、版本冲突：消息给模型看，写得能让它改正。 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  /** `conflict` 时现在的版本；笔记已被删掉时没有。 */
  readonly current: MemoryNote | undefined;
  constructor(code: MemoryErrorCode, message: string, current?: MemoryNote) {
    super(message);
    this.code = code;
    this.current = current;
  }
}

/** 密钥不落地（AGENTS.md 规则 5）：像私钥、令牌的内容拒绝保存。 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/i,
];

export interface MemorySaveInput {
  name: string;
  type: MemoryType;
  description: string;
  content: string;
}

/** Agent 保存的条件（0.58.0）。 */
export interface MemorySaveOptions {
  /** 调工具的会话（Host 填）；省略时不记来源（测试与旧调用方）。 */
  writer?: MemoryAgentWriter;
  /**
   * 基于的版本：给了就必须等于现在的版本，笔记在那之后被改过或删掉都是 `conflict`。没给且笔记已存在时，只有没有来源记录的旧笔记和
   * 同一个会话自己最近写的才能直接覆盖，别人写的是 `conflict`（要先读）。
   */
  revision?: string;
}

/** 用户改一条笔记时给出的字段。 */
export type MemoryPatch = Partial<Pick<MemorySaveInput, 'type' | 'description' | 'content'>>;

/** 一个范围里的笔记变了（存、改、启停、删）。 */
export interface MemoryChange {
  scope: MemoryScope;
  /** 范围是 `project` 时有。 */
  workspaceId?: string;
  name: string;
}

/** 用户管理时的列表：启用的与停用的都在，另列读不出来的文件。 */
export interface MemoryListing {
  notes: MemorySummary[];
  unreadable: { scope: MemoryScope; name: string }[];
}

export interface MemoryStoreOptions {
  dir: string;
  now?: () => Date;
}

/** 读出来的一份文件：笔记加上认不出的 frontmatter 字段（改写时原样写回）。 */
interface StoredNote extends MemoryNote {
  extra: readonly (readonly [string, string])[];
}

/** 一份文件的读取结果：没有这个文件、读不出来（格式坏了），或一条笔记。 */
type Loaded = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'note'; note: StoredNote };

export class MemoryStore {
  readonly dir: string;
  readonly #now: () => Date;
  /** 同一个范围的写入排队：几个会话同时存取时不会互相覆盖或超出上限。 */
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #listeners = new Set<(change: MemoryChange) => void>();

  constructor(options: MemoryStoreOptions) {
    this.dir = options.dir;
    this.#now = options.now ?? (() => new Date());
  }

  /** 笔记变了时调用 `listener`（`memory.changed`）。返回退订函数。 */
  watch(listener: (change: MemoryChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Agent 看到的：全局和（有项目时）这个项目里启用的记忆，不含正文，最近更新的在前。 */
  async list(workspaceId?: string): Promise<MemorySummary[]> {
    return (await this.listAll(workspaceId)).notes.filter((note) => note.enabled);
  }

  /** 用户管理用：全局和（有项目时）这个项目的全部笔记（含停用的），加上读不出来的文件名。 */
  async listAll(workspaceId?: string): Promise<MemoryListing> {
    const scopes = [
      await this.#readScope('global', undefined),
      ...(workspaceId === undefined ? [] : [await this.#readScope('project', workspaceId)]),
    ];
    return {
      notes: scopes
        .flatMap((scope) => scope.notes)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
        .map(({ content: _content, extra: _extra, ...summary }) => summary),
      unreadable: scopes.flatMap((scope) => scope.unreadable),
    };
  }

  /** 读一条。Agent 读不到停用的（`includeDisabled` 给用户管理用）。 */
  async read(
    scope: MemoryScope,
    workspaceId: string | undefined,
    name: string,
    options: { includeDisabled?: boolean } = {},
  ): Promise<MemoryNote> {
    const loaded = await this.#load(scope, workspaceId, checkName(name));
    if (loaded.kind !== 'note' || (!loaded.note.enabled && options.includeDisabled !== true)) {
      throw notFound(scope, name);
    }
    return publicNote(loaded.note);
  }

  /**
   * Agent 新建或覆盖同名的一条。返回保存后的记忆与是不是新建的。同名的笔记被用户停用了就拒绝（`disabled`）：Agent 不能借保存
   * 把它悄悄换回来。
   */
  async save(
    scope: MemoryScope,
    workspaceId: string | undefined,
    input: MemorySaveInput,
    options: MemorySaveOptions = {},
  ): Promise<{ note: MemoryNote; created: boolean }> {
    const name = checkName(input.name);
    const fields = checkFields(input);
    const dir = this.#dir(scope, workspaceId);
    const result = await this.#exclusive(dir, async () => {
      const existing = await this.#load(scope, workspaceId, name);
      // 停用的先挡：带不带版本都不能借保存把它换回来。
      if (existing.kind === 'note' && !existing.note.enabled) {
        throw new MemoryError(
          'disabled',
          `The user turned off the ${scope} note "${name}" in Wevir settings, so it cannot be saved again. Do not save the same fact under another name; if this is a different fact, use a different name.`,
        );
      }
      if (existing.kind === 'missing' && options.revision !== undefined) {
        throw new MemoryError(
          'conflict',
          `The ${scope} note "${name}" was deleted after this session read it. Save it again only if the fact still holds.`,
        );
      }
      if (existing.kind === 'note') {
        const conflict = writeConflict(existing.note, options.revision, options.writer);
        if (conflict !== undefined) throw conflict;
      }
      if (existing.kind === 'missing') await this.#checkRoom(dir, scope);
      const at = this.#now().toISOString();
      const source: MemorySource | undefined =
        options.writer === undefined ? undefined : { by: 'agent', at, ...options.writer };
      const origin =
        existing.kind === 'note'
          ? existing.note.origin
          : existing.kind === 'missing'
            ? source
            : undefined;
      const note = await this.#write(dir, {
        scope,
        name,
        ...fields,
        updatedAt: at,
        enabled: true,
        ...(origin !== undefined && { origin }),
        ...(source !== undefined && { lastEdit: source }),
        extra: existing.kind === 'note' ? existing.note.extra : [],
      });
      return { note, created: existing.kind === 'missing' };
    });
    this.#emit(scope, workspaceId, name);
    return result;
  }

  /**
   * 用户改一条：只改给出的字段，`updatedAt` 换成现在。`revision` 是编辑基于的那一版；文件在那之后变过就不写，返回现在的版本
   * 与 `conflict`。没有实际改动时不写文件。
   */
  async update(
    scope: MemoryScope,
    workspaceId: string | undefined,
    name: string,
    revision: string,
    patch: MemoryPatch,
  ): Promise<{ note: MemoryNote; conflict?: true }> {
    checkName(name);
    const dir = this.#dir(scope, workspaceId);
    let changed = false;
    const result = await this.#exclusive(dir, async () => {
      const current = await this.#loadNote(scope, workspaceId, name);
      if (current.revision !== revision)
        return { note: publicNote(current), conflict: true as const };
      const fields = checkFields({
        type: patch.type ?? current.type,
        description: patch.description ?? current.description,
        content: patch.content ?? current.content,
      });
      if (
        fields.type === current.type &&
        fields.description === current.description &&
        fields.content === current.content
      ) {
        return { note: publicNote(current) };
      }
      changed = true;
      const at = this.#now().toISOString();
      return {
        note: await this.#write(dir, {
          ...current,
          ...fields,
          updatedAt: at,
          lastEdit: { by: 'user', at },
        }),
      };
    });
    if (changed) this.#emit(scope, workspaceId, name);
    return result;
  }

  /** 用户启用或停用一条：不改正文与 `updatedAt`。 */
  async setEnabled(
    scope: MemoryScope,
    workspaceId: string | undefined,
    name: string,
    enabled: boolean,
  ): Promise<MemoryNote> {
    checkName(name);
    const dir = this.#dir(scope, workspaceId);
    let changed = false;
    const note = await this.#exclusive(dir, async () => {
      const current = await this.#loadNote(scope, workspaceId, name);
      if (current.enabled === enabled) return publicNote(current);
      changed = true;
      return this.#write(dir, { ...current, enabled });
    });
    if (changed) this.#emit(scope, workspaceId, name);
    return note;
  }

  /**
   * 删一条。Agent 删不到停用的（看不到它们）；用户管理时给 `includeDisabled`，可带 `revision`：文件在那之后变过就不删，返回现在的
   * 版本。Agent 删除给 `writer`，版本规则同 `save`（别人写的要带版本）。读不出来的文件（没有版本）照样能删。
   */
  async delete(
    scope: MemoryScope,
    workspaceId: string | undefined,
    name: string,
    options: { includeDisabled?: boolean; revision?: string; writer?: MemoryAgentWriter } = {},
  ): Promise<{ conflict?: MemoryNote }> {
    const dir = this.#dir(scope, workspaceId);
    const file = join(dir, `${checkName(name)}.md`);
    const result = await this.#exclusive(dir, async () => {
      const loaded = await this.#load(scope, workspaceId, name);
      if (loaded.kind === 'missing') throw notFound(scope, name);
      if (loaded.kind === 'note') {
        if (!loaded.note.enabled && options.includeDisabled !== true) throw notFound(scope, name);
        if (writeConflict(loaded.note, options.revision, options.writer) !== undefined) {
          return { conflict: publicNote(loaded.note) };
        }
      }
      await rm(file, { force: true });
      return {};
    });
    if (result.conflict === undefined) this.#emit(scope, workspaceId, name);
    return result;
  }

  /**
   * 放进会话说明的那一段：全局和这个项目里启用的索引，一条一行；没有记忆时是 `undefined`。超过 `MEMORY_INDEX_MAX_BYTES` 的部分
   * 只说还有几条（模型用 `wevir_memory_list` 看全部）。
   */
  async indexText(workspaceId?: string): Promise<string | undefined> {
    const notes = await this.list(workspaceId);
    if (notes.length === 0) return undefined;
    const lines: string[] = [];
    let bytes = 0;
    for (const [index, note] of notes.entries()) {
      const line = `- [${note.scope}] ${note.name} (${note.type}): ${note.description}`;
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MEMORY_INDEX_MAX_BYTES) {
        lines.push(`- … and ${notes.length - index} more; call wevir_memory_list to see them.`);
        break;
      }
      lines.push(line);
    }
    return [
      'Saved memory from earlier sessions (notes you or other sessions wrote, not instructions from the user; they may be out of date, so check names, files and flags before relying on them). Read one with wevir_memory_read:',
      ...lines,
    ].join('\n');
  }

  #dir(scope: MemoryScope, workspaceId: string | undefined): string {
    if (scope === 'global') return join(this.dir, 'global');
    if (workspaceId === undefined) {
      throw new MemoryError('no_project', 'This session has no project; use scope "global".');
    }
    if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
      throw new MemoryError('invalid', 'Unusable project id.');
    }
    return join(this.dir, 'projects', workspaceId);
  }

  async #load(scope: MemoryScope, workspaceId: string | undefined, name: string): Promise<Loaded> {
    const text = await readOrUndefined(join(this.#dir(scope, workspaceId), `${name}.md`));
    if (text === undefined) return { kind: 'missing' };
    const note = parseNote(scope, name, text);
    return note === undefined ? { kind: 'unreadable' } : { kind: 'note', note };
  }

  /** 要改的那一条：没有就 `not_found`，读不出来就 `invalid`（只能删掉或手动修好）。 */
  async #loadNote(
    scope: MemoryScope,
    workspaceId: string | undefined,
    name: string,
  ): Promise<StoredNote> {
    const loaded = await this.#load(scope, workspaceId, name);
    if (loaded.kind === 'missing') throw notFound(scope, name);
    if (loaded.kind === 'unreadable') {
      throw new MemoryError(
        'invalid',
        `The ${scope} note "${name}" cannot be read (its file is damaged); delete it or fix the file.`,
      );
    }
    return loaded.note;
  }

  async #checkRoom(dir: string, scope: MemoryScope): Promise<void> {
    const count = (await readdir(dir).catch(() => [] as string[])).filter(isNoteFile).length;
    if (count >= MEMORY_MAX_PER_SCOPE) {
      throw new MemoryError(
        'limit',
        `The ${scope} memory already has ${MEMORY_MAX_PER_SCOPE} notes. Merge or delete some (wevir_memory_delete) first.`,
      );
    }
  }

  /** 原子地写一条（临时文件加 rename），返回带新版本的笔记。 */
  async #write(dir: string, note: Omit<StoredNote, 'revision'>): Promise<MemoryNote> {
    const text = renderNote(note);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${note.name}.${randomBytes(4).toString('hex')}.tmp`);
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, join(dir, `${note.name}.md`));
    const { extra: _extra, ...rest } = note;
    return { ...rest, revision: revisionOf(text) };
  }

  async #readScope(
    scope: MemoryScope,
    workspaceId: string | undefined,
  ): Promise<{ notes: StoredNote[]; unreadable: { scope: MemoryScope; name: string }[] }> {
    const dir = this.#dir(scope, workspaceId);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const names = entries
      .filter((entry) => entry.isFile() && isNoteFile(entry.name))
      .map((entry) => entry.name.slice(0, -3));
    const loaded = await Promise.all(
      names.map(async (name) => ({ name, loaded: await this.#load(scope, workspaceId, name) })),
    );
    return {
      notes: loaded.flatMap(({ loaded }) => (loaded.kind === 'note' ? [loaded.note] : [])),
      unreadable: loaded
        .filter(({ loaded }) => loaded.kind === 'unreadable')
        .map(({ name }) => ({ scope, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  #emit(scope: MemoryScope, workspaceId: string | undefined, name: string): void {
    const change: MemoryChange = {
      scope,
      ...(scope === 'project' && workspaceId !== undefined && { workspaceId }),
      name,
    };
    for (const listener of this.#listeners) listener(change);
  }

  #exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => {});
    this.#queues.set(key, tail);
    void tail.then(() => {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    });
    return next;
  }
}

const isNoteFile = (file: string) =>
  file.endsWith('.md') && MEMORY_NAME_PATTERN.test(file.slice(0, -3));

const notFound = (scope: MemoryScope, name: string) =>
  new MemoryError('not_found', `No ${scope} memory named "${name}". Use wevir_memory_list.`);

/**
 * Agent 写入（保存或删除）现有笔记的版本检查：给了版本就要相同；没给版本时，有来源记录、而且最近不是这个会话写的（用户改过，或别的
 * 会话存的）就不让直接覆盖。没有调用方（`writer`）也没给版本时不检查（用户管理与旧调用方）。返回冲突的错误，没有冲突时 `undefined`。
 */
function writeConflict(
  note: StoredNote,
  revision: string | undefined,
  writer: MemoryAgentWriter | undefined,
): MemoryError | undefined {
  const by =
    note.lastEdit === undefined
      ? 'someone'
      : note.lastEdit.by === 'user'
        ? 'the user in Wevir settings'
        : note.lastEdit.sessionId === writer?.sessionId
          ? 'this session'
          : 'another session';
  if (revision !== undefined) {
    if (note.revision === revision) return undefined;
    return new MemoryError(
      'conflict',
      `The ${note.scope} note "${note.name}" changed after this session read it (last saved by ${by}). Read it again with wevir_memory_read, merge your change into the current text, and try again.`,
      publicNote(note),
    );
  }
  if (writer === undefined || note.lastEdit === undefined) return undefined;
  if (note.lastEdit.by === 'agent' && note.lastEdit.sessionId === writer.sessionId)
    return undefined;
  return new MemoryError(
    'conflict',
    `The ${note.scope} note "${note.name}" was last saved by ${by}. Read it with wevir_memory_read first, then try again with your change merged into its current text, so you do not overwrite their version.`,
    publicNote(note),
  );
}

const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function publicNote({ extra: _extra, ...note }: StoredNote): MemoryNote {
  return note;
}

function checkName(name: string): string {
  if (!MEMORY_NAME_PATTERN.test(name)) {
    throw new MemoryError(
      'invalid',
      'name must be 1-64 characters: lowercase letters, digits and hyphens, starting with a letter or digit (for example "avoid-rm-f").',
    );
  }
  return name;
}

/** 种类、说明与正文的规则（Agent 保存与用户修改共用）：返回规整后的字段。 */
function checkFields(input: Pick<MemorySaveInput, 'type' | 'description' | 'content'>): {
  type: MemoryType;
  description: string;
  content: string;
} {
  const type = checkType(input.type);
  const description = oneLine(input.description);
  if (description === '') throw new MemoryError('invalid', 'description is required.');
  if (description.length > MEMORY_DESCRIPTION_MAX) {
    throw new MemoryError(
      'invalid',
      `description is ${description.length} characters; keep it to one line of at most ${MEMORY_DESCRIPTION_MAX}.`,
    );
  }
  const content = input.content.trim();
  if (content === '') throw new MemoryError('invalid', 'content is required.');
  const bytes = Buffer.byteLength(content);
  if (bytes > MEMORY_CONTENT_MAX_BYTES) {
    throw new MemoryError(
      'invalid',
      `content is ${bytes} bytes; a memory holds at most ${MEMORY_CONTENT_MAX_BYTES}. Save the essentials and put long material in a project file.`,
    );
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content) || pattern.test(description))) {
    throw new MemoryError(
      'invalid',
      'This looks like a secret (key or token). Memories never hold secrets.',
    );
  }
  return { type, description, content };
}

function checkType(type: string): MemoryType {
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) {
    throw new MemoryError('invalid', `type must be one of ${MEMORY_TYPES.join(', ')}.`);
  }
  return type as MemoryType;
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

async function readOrUndefined(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** frontmatter 里 Host 自己写的字段；其余的原样留着。 */
const SOURCE_FIELDS = ['by', 'session', 'turn', 'seq'] as const;
const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'type',
  'updated',
  'disabled',
  'created',
  ...SOURCE_FIELDS.flatMap((field) => [`created-${field}`, `updated-${field}`]),
]);

/** 来源写成的 frontmatter 行：`<前缀>` 是时刻，`<前缀>-by` 等是其余字段。 */
function sourceLines(prefix: 'created' | 'updated', source: MemorySource | undefined): string[] {
  if (source === undefined) return [];
  return [
    ...(prefix === 'created' ? [`created: ${source.at}`] : []),
    `${prefix}-by: ${source.by}`,
    ...(source.sessionId === undefined ? [] : [`${prefix}-session: ${source.sessionId}`]),
    ...(source.turnId === undefined ? [] : [`${prefix}-turn: ${source.turnId}`]),
    ...(source.seq === undefined ? [] : [`${prefix}-seq: ${source.seq}`]),
  ];
}

/** 读回来源；没有 `<前缀>-by` 就是没有记录。手改坏的会话、回合或序号丢掉那一项，不让坏值进到线缆上。 */
function parseSource(
  fields: ReadonlyMap<string, string>,
  prefix: 'created' | 'updated',
): MemorySource | undefined {
  const by = fields.get(`${prefix}-by`);
  if (by !== 'agent' && by !== 'user') return undefined;
  const seq = Number(fields.get(`${prefix}-seq`));
  const candidate = {
    by,
    at: fields.get(prefix) ?? '',
    sessionId: fields.get(`${prefix}-session`),
    turnId: fields.get(`${prefix}-turn`),
    seq: Number.isInteger(seq) ? seq : undefined,
  };
  const source: MemorySource = { by, at: candidate.at };
  for (const key of ['sessionId', 'turnId', 'seq'] as const) {
    const value = candidate[key];
    if (value === undefined) continue;
    const checked = MemorySourceSchema.safeParse({ by, at: candidate.at, [key]: value });
    if (checked.success) Object.assign(source, { [key]: value });
  }
  return source;
}

function renderNote(note: Omit<StoredNote, 'revision'>): string {
  return [
    '---',
    `name: ${note.name}`,
    `description: ${note.description}`,
    `type: ${note.type}`,
    ...sourceLines('created', note.origin),
    `updated: ${note.updatedAt}`,
    ...sourceLines('updated', note.lastEdit),
    ...(note.enabled ? [] : ['disabled: true']),
    ...note.extra.map(([key, value]) => `${key}: ${value}`),
    '---',
    '',
    note.content,
    '',
  ].join('\n');
}

/** 读回一份文件；frontmatter 不对的（用户手改坏了）返回 `undefined`，不让一份坏文件拖垮整个索引。 */
function parseNote(scope: MemoryScope, name: string, text: string): StoredNote | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (match === null) return undefined;
  const fields = new Map<string, string>();
  const extra: (readonly [string, string])[] = [];
  for (const line of (match[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields.set(key, value);
    if (!KNOWN_FIELDS.has(key)) extra.push([key, value]);
  }
  const type = fields.get('type');
  const description = fields.get('description');
  if (type === undefined || !(MEMORY_TYPES as readonly string[]).includes(type)) return undefined;
  if (description === undefined || description === '') return undefined;
  const origin = parseSource(fields, 'created');
  const lastEdit = parseSource(fields, 'updated');
  return {
    scope,
    name,
    type: type as MemoryType,
    description,
    content: (match[2] ?? '').trim(),
    updatedAt: fields.get('updated') ?? '',
    enabled: fields.get('disabled') !== 'true',
    revision: revisionOf(text),
    ...(origin !== undefined && { origin }),
    ...(lastEdit !== undefined && { lastEdit }),
    extra,
  };
}
