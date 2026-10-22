// 调优的建议（0.87.0，`tuning.proposal.*`，domain-model §3.41，ADR-0016）：用户点按钮时用会话的模型提出配置改动，用户逐条采纳。
//
// 生成：只在 `tuning.proposal.generate` 里调模型，一次请求（这个会话还没有回顾摘要时先生成摘要，用量合计）。输入见 proposals-input.ts；
// 每条建议记下生成时目标的基准散列（`AGENTS.md` 与 SKILL.md 的文本散列、记忆的版本、这个项目的护栏规则的散列，目标不存在时是
// `missing`）。解析失败或模型不可用回 `reason`，不重试。
//
// 状态：待审 → 已采纳 / 已拒绝；目标变了 → 已过时（列出、改动与采纳时核对）。已过时的只能拒绝或重新生成（`replaces`）。采纳写入目标：
// `AGENTS.md` 与 SKILL.md 写整份文本（技能另在插件注册表里启用），记忆经 `MemoryStore.adopt`（来源记会话与建议），护栏经
// `GuardrailService.add`。采纳之后下一个会话开的档案版本把这些建议记进 `cause`（TuningService 的 `causes`）。

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import {
  type Guardrail,
  type GuardrailBlocked,
  MEMORY_CONTENT_MAX_BYTES,
  type MethodParams,
  type MethodResult,
  type ProfileVersionCause,
  type ProfileVersionId,
  type SessionId,
  type Skill,
  TUNING_PROPOSAL_TEXT_MAX_LENGTH,
  TUNING_PROPOSALS_LIST_MAX,
  type TuningProposal,
  type TuningProposalChange,
  TuningProposalChangeSchema,
  type TuningProposalEvidence,
  TuningProposalEvidenceSchema,
  type TuningProposalId,
  type TuningProposalKind,
  type TuningProposalStats,
  type TuningUsage,
  TuningUsageSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import type { Storage, TuningProposalRecord, WorkspaceRecord } from '@wevir/storage';
import { HostError } from '../errors.js';
import type { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import { MemoryError, type MemoryStore } from '../memory.js';
import { parseSkill } from '../plugin-skills.js';
import { redactRetro } from '../retro/redact.js';
import type { RetroGenerate, RetroService } from '../retro/service.js';
import { retroSummaryInput } from '../retro/summary.js';
import type { FoundRuleFile } from '../rule-files.js';
import { looksLikeSecret } from '../secret-patterns.js';
import { applyUnifiedDiff } from './patch.js';
import {
  evidenceIndex,
  guardrailLine,
  type ParsedProposal,
  PROPOSAL_OUTPUT_SCHEMA,
  PROPOSAL_TIMEOUT_MS,
  parseProposals,
  proposalInput,
} from './proposals-input.js';

/** 目标不存在时的基准散列。 */
const MISSING = 'missing';
/** 采纳后的统计最多看用这一版的多少个会话。 */
const STATS_SESSIONS_MAX = 200;
/** 读事件找护栏命中时一页多少条。 */
const EVENTS_PAGE = 1000;

/** `payload_json`：改动，与用户在采纳前改过的标记。 */
interface StoredPayload {
  change: TuningProposalChange;
  edited?: true;
}

/** `usage_json`：生成它的那次操作的用量与模型。 */
interface StoredUsage {
  usage?: TuningUsage;
  providerId?: string;
  modelId?: string;
}

type Generated = MethodResult<'tuning.proposal.generate'>;

export interface ProposalServiceOptions {
  storage: Pick<Storage, 'tuningProposals' | 'sessions' | 'workspaces' | 'profileVersions'>;
  events: Pick<EventStore, 'readSince' | 'snapshot'>;
  retro: Pick<RetroService, 'get' | 'summarize'>;
  /** 说明（prompts/tuning-proposals.md）与发请求（SessionManager.generateOnce）；没有时生成回 `unsupported`。 */
  instructions?: string;
  generate?: RetroGenerate;
  /** “对话”工作区里的会话不能生成（没有项目）。 */
  isChats?: (workspace: Pick<WorkspaceRecord, 'rootPath'>) => boolean;
  /** 项目根的规则文件（rule-files.ts 的 `discoverRuleFiles`）。 */
  ruleFiles: (cwd: string) => Promise<FoundRuleFile[]>;
  /** 交给引擎的技能（plugins.ts 的 `enabledSkills`）。 */
  skills: () => Promise<Skill[]>;
  /** 采纳技能后在插件注册表里启用它（SKILL.md 的路径）。 */
  enableSkill: (path: string) => Promise<void>;
  memory: Pick<MemoryStore, 'indexText' | 'read' | 'adopt'>;
  /** 护栏（0.86.0）；没有时不提出、也不能采纳护栏建议。 */
  guardrails?: {
    list(workspaceId?: WorkspaceId): Guardrail[];
    add(params: MethodParams<'guardrail.add'>): Promise<Guardrail>;
  };
  /** 用户家目录：规则文件的路径缩写成 `~`。 */
  userHome: string;
  /** 采纳写了目标之后：档案可能变了（`tuning.changed`）。 */
  onProfileChanged?: (workspaceId: string) => void;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** 写临时文件再改名：写到一半不会留下半份文件。 */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function invalid(path: Array<string | number>, message: string): HostError {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

export class ProposalService {
  readonly #options: ProposalServiceOptions;
  readonly #now: () => Date;
  readonly #listeners = new Set<(workspaceId: WorkspaceId | undefined) => void>();

  constructor(options: ProposalServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  /** 建议变了（`tuning.proposal.changed`）。返回退订函数。 */
  watch(listener: (workspaceId: WorkspaceId | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(workspaceId: string | undefined): void {
    for (const listener of this.#listeners) listener(workspaceId as WorkspaceId | undefined);
  }

  /** 这个项目上一版之后采纳了、还没有版本的建议（TuningService 开新版本时记进 `cause`）。 */
  pendingCause(workspaceId: string): ProfileVersionCause | undefined {
    const ids = this.#options.storage.tuningProposals
      .unversioned(workspaceId)
      .map((record) => record.id as TuningProposalId);
    return ids.length === 0 ? undefined : { proposalIds: ids };
  }

  /** 新版本记下了这些建议：把版本记回建议。 */
  recordCause(versionId: ProfileVersionId, cause: ProfileVersionCause): void {
    const { tuningProposals } = this.#options.storage;
    let workspaceId: string | undefined;
    for (const id of cause.proposalIds) {
      tuningProposals.update(id, { versionId });
      workspaceId ??= tuningProposals.get(id)?.workspaceId;
    }
    this.#emit(workspaceId);
  }

  // ── 生成 ────────────────────────────────────────────────────────────

  async generate(params: MethodParams<'tuning.proposal.generate'>): Promise<Generated> {
    const { storage, instructions, generate } = this.#options;
    const session = storage.sessions.get(params.sessionId);
    if (session === undefined) {
      throw new HostError('SESSION_NOT_FOUND', `session ${params.sessionId} not found`);
    }
    // 子会话的配置随父会话，建议从父会话生成。
    if (session.parentSessionId !== undefined) return { proposals: [], reason: 'sub_session' };
    const workspace = storage.workspaces.get(session.workspaceId);
    if (
      workspace === undefined ||
      workspace.removedAt !== undefined ||
      this.#options.isChats?.(workspace) === true
    ) {
      return { proposals: [], reason: 'no_project' };
    }
    if (instructions === undefined || generate === undefined) {
      return { proposals: [], reason: 'unsupported' };
    }
    let usage: TuningUsage | undefined;
    const addUsage = (reported: TuningUsage) => {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + reported.inputTokens,
        outputTokens: (usage?.outputTokens ?? 0) + reported.outputTokens,
      };
    };
    const failed = (reason: string): Generated => ({
      proposals: [],
      reason,
      ...(usage !== undefined && { usage }),
    });

    let { retro } = await this.#options.retro.get(params.sessionId);
    if (retro.turns.length === 0) return failed('empty');
    let summarized = false;
    if (retro.summary === undefined) {
      // 先按回顾原来的方式写摘要（同一次操作）；摘要解析不了时没有摘要也接着提建议，其余原因说明模型现在用不了。
      const result = await this.#options.retro.summarize(params.sessionId, { onUsage: addUsage });
      if (result.summary !== undefined) {
        summarized = true;
        retro = { ...retro, summary: result.summary };
      } else if (result.reason !== 'unparsable') {
        return failed(result.reason ?? 'failed');
      }
    }

    const redacted = redactRetro(retro).retro;
    const hits = this.#guardrailHits(params.sessionId);
    const root = workspace.rootPath;
    const agentsPath = join(root, 'AGENTS.md');
    const agentsText = await readText(agentsPath);
    const allowed: TuningProposalKind[] = [
      'rule',
      'skill',
      'memory',
      ...(this.#options.guardrails !== undefined ? (['guardrail'] as const) : []),
    ];
    const input = proposalInput({
      ...(redacted.summary !== undefined && { summary: redacted.summary }),
      retro: retroSummaryInput({ ...redacted, summary: undefined }),
      guardrailHits: hits,
      ruleFiles: await this.#ruleFiles(root, agentsPath, agentsText),
      agentsMissing: agentsText === undefined,
      skills: await this.#options.skills().catch(() => []),
      ...(await this.#memoryIndex(workspace.id)),
      guardrails: (this.#options.guardrails?.list(workspace.id as WorkspaceId) ?? []).map((g) => ({
        rule: g.rule,
        ...(g.name !== undefined && { name: g.name }),
        scope: g.workspaceId === undefined ? ('global' as const) : ('project' as const),
      })),
      rejected: storage.tuningProposals
        .list({ workspaceId: workspace.id, statuses: ['rejected'], limit: 20 })
        .map((r) => ({ kind: r.kind, title: r.title, target: r.target })),
      allowed,
    });

    const result = await generate(params.sessionId, {
      instructions,
      input,
      outputSchema: { ...PROPOSAL_OUTPUT_SCHEMA },
      timeoutMs: PROPOSAL_TIMEOUT_MS,
      onUsage: addUsage,
    });
    if ('reason' in result) return failed(result.reason);
    const index = evidenceIndex(retro, hits);
    const parsed = parseProposals(result.text, { allowed, knownIds: new Set(index.keys()) });
    if (parsed === undefined) {
      this.#options.onWarning?.('调优建议无法解析，不保存', {
        sessionId: params.sessionId,
        output: result.text.slice(0, 500),
      });
      return failed('unparsable');
    }

    const createdAt = this.#now().toISOString();
    const stored: StoredUsage = {
      ...(usage !== undefined && { usage }),
      providerId: result.providerId,
      modelId: result.modelId,
    };
    const dropped = [...parsed.dropped];
    const records: TuningProposalRecord[] = [];
    for (const proposal of parsed.proposals) {
      const built = await this.#build(proposal, workspace, agentsText);
      if (typeof built === 'string') {
        dropped.push(`${proposal.kind} ${proposal.title}: ${built}`);
        continue;
      }
      const evidence: TuningProposalEvidence[] = proposal.evidence.flatMap((id) => {
        const entry = index.get(id);
        return entry === undefined ? [] : [{ id, ...entry }];
      });
      records.push({
        id: newId('tpr'),
        workspaceId: workspace.id,
        sessionId: params.sessionId,
        kind: proposal.kind,
        title: proposal.title,
        target: built.target,
        baseHash: built.baseHash,
        payload: { change: built.change } satisfies StoredPayload,
        evidence,
        status: 'pending',
        origin: 'user',
        usage: stored,
        createdAt,
      });
    }
    if (dropped.length > 0) {
      this.#options.onWarning?.('丢掉了不合格的调优建议', {
        sessionId: params.sessionId,
        dropped,
      });
    }
    for (const record of records) storage.tuningProposals.insert(record);
    if (params.replaces !== undefined) {
      const old = storage.tuningProposals.get(params.replaces);
      if (old !== undefined && (old.status === 'stale' || old.status === 'pending')) {
        storage.tuningProposals.delete(old.id);
      }
    }
    this.#emit(workspace.id);
    return {
      proposals: records.map((record) => this.#toProposal(record)),
      ...(usage !== undefined && { usage }),
      ...(summarized && { summarized: true as const }),
    };
  }

  /** 把模型给的一条变成存下的改动与基准散列；不能用时返回原因。 */
  async #build(
    proposal: ParsedProposal,
    workspace: WorkspaceRecord,
    agentsText: string | undefined,
  ): Promise<{ change: TuningProposalChange; target: string; baseHash: string } | string> {
    const root = workspace.rootPath;
    switch (proposal.kind) {
      case 'rule': {
        const before = agentsText ?? '';
        if (before.length > TUNING_PROPOSAL_TEXT_MAX_LENGTH) return 'AGENTS.md too long';
        const after = applyUnifiedDiff(before, proposal.diff);
        if (after === undefined) return 'diff does not apply';
        if (after.length > TUNING_PROPOSAL_TEXT_MAX_LENGTH) return 'too long';
        if (looksLikeSecret(after) && !looksLikeSecret(before)) return 'looks like a secret';
        return {
          change: { kind: 'rule', path: join(root, 'AGENTS.md'), before, after },
          target: 'AGENTS.md',
          baseHash: agentsText === undefined ? MISSING : sha256(agentsText),
        };
      }
      case 'skill': {
        const path = skillPath(root, proposal.name);
        const current = await readText(path);
        const content = proposal.content.endsWith('\n')
          ? proposal.content
          : `${proposal.content}\n`;
        try {
          parseSkill(content, proposal.name);
        } catch (error) {
          return (error as Error).message;
        }
        if (content.length > TUNING_PROPOSAL_TEXT_MAX_LENGTH) return 'too long';
        if ((current ?? '').length > TUNING_PROPOSAL_TEXT_MAX_LENGTH) return 'SKILL.md too long';
        if (current === content) return 'no change';
        if (looksLikeSecret(content)) return 'looks like a secret';
        return {
          change: {
            kind: 'skill',
            name: proposal.name,
            path,
            before: current ?? '',
            after: content,
          },
          target: relative(root, path).split(sep).join('/'),
          baseHash: current === undefined ? MISSING : sha256(current),
        };
      }
      case 'memory': {
        if (Buffer.byteLength(proposal.content) > MEMORY_CONTENT_MAX_BYTES) return 'too long';
        if (looksLikeSecret(proposal.content) || looksLikeSecret(proposal.description)) {
          return 'looks like a secret';
        }
        const current = await this.#note(workspace.id, proposal.name);
        if (current?.content === proposal.content) return 'no change';
        return {
          change: {
            kind: 'memory',
            name: proposal.name,
            type: proposal.type,
            description: proposal.description,
            before: current?.content ?? '',
            after: proposal.content,
          },
          target: proposal.name,
          baseHash: current?.revision ?? MISSING,
        };
      }
      case 'guardrail': {
        if (this.#options.guardrails === undefined) return 'no guardrails';
        const line = guardrailLine(proposal.rule);
        const exists = this.#options.guardrails
          .list(workspace.id as WorkspaceId)
          .some((g) => guardrailLine(g.rule) === line);
        if (exists) return 'already a guardrail';
        return {
          change: {
            kind: 'guardrail',
            ...(proposal.name !== undefined && { name: proposal.name }),
            rule: proposal.rule,
          },
          target: proposal.rule.kind,
          baseHash: this.#guardrailsHash(workspace.id),
        };
      }
    }
  }

  async #ruleFiles(
    root: string,
    agentsPath: string,
    agentsText: string | undefined,
  ): Promise<{ label: string; text: string; editable?: boolean }[]> {
    const found = await this.#options.ruleFiles(root).catch(() => []);
    const agentsReal =
      agentsText === undefined ? undefined : await realpath(agentsPath).catch(() => agentsPath);
    const files: { label: string; text: string; editable?: boolean }[] = [];
    if (agentsText !== undefined)
      files.push({ label: 'AGENTS.md', text: agentsText, editable: true });
    for (const file of found) {
      if (file.unreadable === true || file.real === agentsReal) continue;
      files.push({ label: this.#label(root, file.path), text: file.text });
    }
    return files;
  }

  #label(root: string, path: string): string {
    const inRoot = relative(root, path);
    if (!inRoot.startsWith('..') && !inRoot.startsWith(sep)) return inRoot.split(sep).join('/');
    const inHome = relative(this.#options.userHome, path);
    if (!inHome.startsWith('..')) return `~/${inHome.split(sep).join('/')}`;
    return path;
  }

  async #memoryIndex(workspaceId: string): Promise<{ memoryIndex?: string }> {
    const text = await this.#options.memory.indexText(workspaceId).catch(() => undefined);
    return text === undefined ? {} : { memoryIndex: text };
  }

  #guardrailHits(sessionId: SessionId): { seq: number; blocked: GuardrailBlocked }[] {
    const hits: { seq: number; blocked: GuardrailBlocked }[] = [];
    let since = 0;
    for (;;) {
      const batch = this.#options.events.readSince(sessionId, since, EVENTS_PAGE);
      for (const event of batch) {
        if (event.type === 'guardrail.blocked')
          hits.push({ seq: event.seq, blocked: event.payload });
      }
      const last = batch.at(-1);
      if (batch.length < EVENTS_PAGE || last === undefined) break;
      since = last.seq;
    }
    return hits;
  }

  // ── 列出、改、采纳与拒绝 ────────────────────────────────────────────────

  async list(
    params: MethodParams<'tuning.proposal.list'>,
  ): Promise<MethodResult<'tuning.proposal.list'>> {
    const statuses =
      params.status === 'open'
        ? ['pending', 'stale']
        : params.status === 'decided'
          ? ['accepted', 'rejected']
          : undefined;
    const records = this.#options.storage.tuningProposals.list({
      ...(params.workspaceId !== undefined && { workspaceId: params.workspaceId }),
      ...(statuses !== undefined && { statuses }),
      limit: TUNING_PROPOSALS_LIST_MAX,
    });
    const touched = new Set<string>();
    for (const record of records) {
      if (record.status !== 'pending') continue;
      if (await this.#isStale(record)) {
        this.#markStale(record);
        touched.add(record.workspaceId);
      }
    }
    for (const workspaceId of touched) this.#emit(workspaceId);
    return { proposals: records.map((record) => this.#toProposal(record)) };
  }

  async update(
    params: MethodParams<'tuning.proposal.update'>,
  ): Promise<MethodResult<'tuning.proposal.update'>> {
    const record = this.#record(params.proposalId);
    await this.#checkOpen(record);
    const { change } = payloadOf(record);
    let next: TuningProposalChange;
    if (change.kind === 'guardrail') {
      if (params.after !== undefined || params.description !== undefined) {
        throw invalid(['after'], 'a guardrail proposal changes its rule, not text');
      }
      const rule = params.rule ?? change.rule;
      if (rule.kind === 'forbidden_command' && rule.match === 'regex') {
        try {
          new RegExp(rule.pattern);
        } catch (error) {
          throw invalid(
            ['rule', 'pattern'],
            `invalid regular expression: ${(error as Error).message}`,
          );
        }
      }
      const name =
        params.name === undefined ? change.name : params.name === null ? undefined : params.name;
      next = { kind: 'guardrail', ...(name !== undefined && name !== '' && { name }), rule };
    } else {
      if (params.rule !== undefined || params.name !== undefined) {
        throw invalid(['rule'], 'only guardrail proposals have a rule');
      }
      if (params.description !== undefined && change.kind !== 'memory') {
        throw invalid(['description'], 'only memory proposals have a description');
      }
      next = {
        ...change,
        ...(params.after !== undefined && { after: params.after }),
        ...(params.description !== undefined &&
          change.kind === 'memory' && {
            description: params.description,
          }),
      };
    }
    if (JSON.stringify(next) === JSON.stringify(change))
      return { proposal: this.#toProposal(record) };
    const parsed = TuningProposalChangeSchema.safeParse(next);
    if (!parsed.success) throw invalid(['after'], parsed.error.message);
    this.#options.storage.tuningProposals.update(record.id, {
      payload: { change: parsed.data, edited: true } satisfies StoredPayload,
    });
    this.#emit(record.workspaceId);
    return { proposal: this.#toProposal(this.#record(params.proposalId)) };
  }

  async decide(
    params: MethodParams<'tuning.proposal.decide'>,
  ): Promise<MethodResult<'tuning.proposal.decide'>> {
    const record = this.#record(params.proposalId);
    const target = params.decision === 'accept' ? 'accepted' : 'rejected';
    if (record.status === 'accepted' || record.status === 'rejected') {
      if (record.status === target) return { proposal: this.#toProposal(record) };
      throw invalid(['decision'], `proposal ${record.id} is already ${record.status}`);
    }
    if (params.decision === 'accept') {
      await this.#checkOpen(record);
      await this.#apply(record);
    }
    this.#options.storage.tuningProposals.update(record.id, {
      status: target,
      decidedAt: this.#now().toISOString(),
    });
    this.#emit(record.workspaceId);
    if (params.decision === 'accept') this.#options.onProfileChanged?.(record.workspaceId);
    return { proposal: this.#toProposal(this.#record(params.proposalId)) };
  }

  /** 写入目标。目标在核对之后、写之前被改了（记忆的版本冲突）也按已过时处理。 */
  async #apply(record: TuningProposalRecord): Promise<void> {
    const { change } = payloadOf(record);
    switch (change.kind) {
      case 'rule':
        await writeAtomic(change.path, change.after);
        return;
      case 'skill':
        try {
          parseSkill(change.after, change.name);
        } catch (error) {
          throw invalid(['after'], (error as Error).message);
        }
        await writeAtomic(change.path, change.after);
        await this.#options.enableSkill(change.path).catch((error: unknown) => {
          this.#options.onWarning?.('采纳的技能没能启用', {
            path: change.path,
            error: (error as Error).message,
          });
        });
        return;
      case 'memory':
        try {
          await this.#options.memory.adopt(
            'project',
            record.workspaceId,
            {
              name: change.name,
              type: change.type,
              description: change.description,
              content: change.after,
            },
            {
              revision: record.baseHash === MISSING ? undefined : record.baseHash,
              sessionId: record.sessionId as SessionId,
              proposalId: record.id as TuningProposalId,
            },
          );
        } catch (error) {
          if (error instanceof MemoryError && error.code === 'conflict') {
            this.#markStale(record);
            this.#emit(record.workspaceId);
            throw stale(record.id);
          }
          if (error instanceof MemoryError) throw invalid(['after'], error.message);
          throw error;
        }
        return;
      case 'guardrail': {
        const guardrails = this.#options.guardrails;
        if (guardrails === undefined) throw invalid(['proposalId'], 'this host has no guardrails');
        await guardrails.add({
          workspaceId: record.workspaceId as WorkspaceId,
          ...(change.name !== undefined && { name: change.name }),
          rule: change.rule,
        });
        return;
      }
    }
  }

  /** 待审才能改与采纳：已处理 `INVALID_PARAMS`；已过时或目标刚变 `PROPOSAL_STALE`（刚变的标成已过时）。 */
  async #checkOpen(record: TuningProposalRecord): Promise<void> {
    if (record.status === 'accepted' || record.status === 'rejected') {
      throw invalid(['proposalId'], `proposal ${record.id} is already ${record.status}`);
    }
    if (record.status === 'stale') throw stale(record.id);
    if (await this.#isStale(record)) {
      this.#markStale(record);
      this.#emit(record.workspaceId);
      throw stale(record.id);
    }
  }

  async #isStale(record: TuningProposalRecord): Promise<boolean> {
    return (await this.#currentBase(record)) !== record.baseHash;
  }

  #markStale(record: TuningProposalRecord): void {
    this.#options.storage.tuningProposals.update(record.id, { status: 'stale' });
  }

  /** 目标现在的基准散列；读不出来时当作变了。 */
  async #currentBase(record: TuningProposalRecord): Promise<string | undefined> {
    const { change } = payloadOf(record);
    try {
      switch (change.kind) {
        case 'rule':
        case 'skill': {
          const text = await readText(change.path);
          return text === undefined ? MISSING : sha256(text);
        }
        case 'memory':
          return (await this.#note(record.workspaceId, change.name))?.revision ?? MISSING;
        case 'guardrail':
          return this.#guardrailsHash(record.workspaceId);
      }
    } catch {
      return undefined;
    }
  }

  async #note(
    workspaceId: string,
    name: string,
  ): Promise<{ revision: string; content: string } | undefined> {
    try {
      return await this.#options.memory.read('project', workspaceId, name, {
        includeDisabled: true,
      });
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'not_found') return undefined;
      throw error;
    }
  }

  /** 这个项目的护栏规则（不含全局的、命中计数与时刻）的散列。 */
  #guardrailsHash(workspaceId: string): string {
    const rules = (this.#options.guardrails?.list(workspaceId as WorkspaceId) ?? [])
      .filter((g) => g.workspaceId !== undefined)
      .map((g) => [g.id, g.revision, g.enabled]);
    return sha256(JSON.stringify(rules));
  }

  #record(id: TuningProposalId): TuningProposalRecord {
    const record = this.#options.storage.tuningProposals.get(id);
    if (record === undefined) throw new HostError('PROPOSAL_NOT_FOUND', `proposal ${id} not found`);
    return record;
  }

  #toProposal(record: TuningProposalRecord): TuningProposal {
    const { storage } = this.#options;
    const { change, edited } = payloadOf(record);
    const usage = usageOf(record);
    const title = storage.sessions.get(record.sessionId)?.title;
    const version =
      record.versionId === undefined ? undefined : storage.profileVersions.get(record.versionId);
    const evidence = Array.isArray(record.evidence)
      ? record.evidence.flatMap((item) => {
          const parsed = TuningProposalEvidenceSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    return {
      id: record.id as TuningProposalId,
      workspaceId: record.workspaceId as WorkspaceId,
      sessionId: record.sessionId as SessionId,
      ...(title !== undefined && title !== '' && { sessionTitle: title }),
      kind: record.kind as TuningProposalKind,
      title: record.title,
      target: record.target,
      change,
      evidence,
      status: record.status as TuningProposal['status'],
      ...(edited === true && { edited: true as const }),
      ...(usage.usage !== undefined && { usage: usage.usage }),
      ...(usage.providerId !== undefined && { providerId: usage.providerId }),
      ...(usage.modelId !== undefined && { modelId: usage.modelId }),
      createdAt: record.createdAt,
      ...(record.decidedAt !== undefined && { decidedAt: record.decidedAt }),
      ...(version !== undefined && {
        version: {
          id: version.id as ProfileVersionId,
          seq: version.seq,
          fingerprint: version.fingerprint,
        },
        stats: this.#stats(version.id),
      }),
    };
  }

  /** 用这一版建的会话数，与这些会话里有结果的回合后验证通过了几次（现读，不调模型）。 */
  #stats(versionId: string): TuningProposalStats {
    const { storage, events } = this.#options;
    const sessions = storage.profileVersions.sessionCounts([versionId]).get(versionId) ?? 0;
    let passed = 0;
    let total = 0;
    for (const id of storage.profileVersions.sessionIds(versionId, STATS_SESSIONS_MAX)) {
      for (const run of events.snapshot(id as SessionId)?.verification?.runs ?? []) {
        if (run.status === 'passed') passed += 1;
        if (run.status === 'passed' || run.status === 'failed' || run.status === 'timed_out') {
          total += 1;
        }
      }
    }
    return { sessions, ...(total > 0 && { checks: { passed, total } }) };
  }
}

function stale(id: string): HostError {
  return new HostError('PROPOSAL_STALE', `the target of proposal ${id} changed after it was made`);
}

function skillPath(root: string, name: string): string {
  return join(root, '.agents', 'skills', name, 'SKILL.md');
}

function payloadOf(record: TuningProposalRecord): StoredPayload {
  const payload = record.payload as Partial<StoredPayload> | null;
  const change = TuningProposalChangeSchema.safeParse(payload?.change);
  if (!change.success) throw new Error(`proposal ${record.id} has an unreadable change`);
  return { change: change.data, ...(payload?.edited === true && { edited: true }) };
}

function usageOf(record: TuningProposalRecord): StoredUsage {
  const value = (record.usage ?? {}) as Record<string, unknown>;
  const usage = TuningUsageSchema.safeParse(value.usage);
  return {
    ...(usage.success && { usage: usage.data }),
    ...(typeof value.providerId === 'string' && { providerId: value.providerId }),
    ...(typeof value.modelId === 'string' && { modelId: value.modelId }),
  };
}
