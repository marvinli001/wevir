// 调优的建议（0.87.0，`tuning.proposal.*`，domain-model §3.41，ADR-0016）：用户点按钮时用会话的模型提出配置改动，用户逐条采纳。
//
// 生成：只在 `tuning.proposal.generate` 里调模型，一次请求（这个会话还没有回顾摘要时先生成摘要，用量合计）。输入见 proposals-input.ts；
// 每条建议记下生成时目标的基准散列（`AGENTS.md` 与 SKILL.md 的文本散列、记忆的版本、这个项目的护栏规则的散列，目标不存在时是
// `missing`）。解析失败或模型不可用回 `reason`，不重试。
//
// 状态：待审 → 已采纳 / 已拒绝；目标变了 → 已过时（列出、改动与采纳时核对）。已过时的只能拒绝或重新生成（`replaces`）。采纳写入目标：
// `AGENTS.md` 与 SKILL.md 写整份文本（技能另在插件注册表里启用），记忆经 `MemoryStore.adopt`（来源记会话与建议），护栏经
// `GuardrailService.add`。采纳之后下一个会话开的档案版本把这些建议记进 `cause`（TuningService 的 `causes`）。
//
// 0.107.0（自动调优，domain-model §3.49，ADR-0018）：生成（用户点的 `user`、后台的 `auto`）与 agent 提交（`propose`，`agent`）的合格改动
// 当场写入目标，状态记 `trial`，载荷里记下改后内容的标记 `applied`（文本的散列、记忆的版本、护栏规则的 ID 与版本）；每次调模型的生成都记
// 进 `tuning_runs`。试用的结论由 TrialService 定：保留（`conclude`）或回退（`revert`）。回退核对 `applied`：没变就恢复采纳前的内容（原来
// 没有的删掉），变了说明后来有人改过，不动目标（`conflict`）。

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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
  TUNING_PROPOSAL_EVIDENCE_TEXT_MAX_LENGTH,
  TUNING_PROPOSAL_TEXT_MAX_LENGTH,
  TUNING_PROPOSALS_LIST_MAX,
  type TuningProposal,
  type TuningProposalChange,
  TuningProposalChangeSchema,
  type TuningProposalEvidence,
  TuningProposalEvidenceSchema,
  type TuningProposalId,
  type TuningProposalKind,
  type TuningProposalOrigin,
  TuningProposalOriginSchema,
  type TuningProposalStats,
  type TuningTrialOutcome,
  TuningTrialOutcomeSchema,
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

/** 写入目标之后改后内容的标记（0.107.0）：回退前核对它，不一样说明目标后来被改过。 */
type Applied =
  | { afterHash: string }
  | { revision: string }
  | { guardrailId: string; revision: number };

/** `payload_json`：改动，与用户在采纳前改过的标记、写入后的标记。 */
interface StoredPayload {
  change: TuningProposalChange;
  edited?: true;
  applied?: Applied;
}

/** 回退一条的结果：恢复了、目标本来就是采纳前的样子、目标被改过没动。 */
type RestoreResult = 'restored' | 'already' | 'conflict';

/** 没有调模型的生成不记进 `tuning_runs`。 */
const NOT_RUN = new Set(['unsupported', 'running', 'empty', 'sub_session', 'no_project']);

/** agent 提交的改动（`wevir_tuning_propose`）：`rule` 给 `AGENTS.md` 改后的全文。 */
export type ProposeInput = { title: string; reason?: string } & (
  | { kind: 'rule'; content: string }
  | { kind: 'skill'; name: string; content: string }
  | {
      kind: 'memory';
      name: string;
      type: 'user' | 'feedback' | 'project' | 'reference';
      description: string;
      content: string;
    }
  | { kind: 'guardrail'; name?: string; rule: Guardrail['rule'] }
);

/** 交给 `#build` 的一条：模型给的（`rule` 是 diff），或 agent 给的（`rule` 是全文 `after`）。 */
type BuildInput =
  | ParsedProposal
  | { kind: 'rule'; title: string; after: string; evidence: string[] };

/** `usage_json`：生成它的那次操作的用量与模型。 */
interface StoredUsage {
  usage?: TuningUsage;
  providerId?: string;
  modelId?: string;
}

type Generated = MethodResult<'tuning.proposal.generate'>;

export interface ProposalServiceOptions {
  storage: Pick<
    Storage,
    'tuningProposals' | 'sessions' | 'workspaces' | 'profileVersions' | 'tuningRuns'
  >;
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
  /** 回退删掉技能前在插件注册表里停用它（0.107.0）。 */
  disableSkill?: (path: string) => Promise<void>;
  memory: Pick<MemoryStore, 'indexText' | 'read' | 'adopt' | 'update' | 'delete'>;
  /** 护栏（0.86.0）；没有时不提出、也不能采纳护栏建议。 */
  guardrails?: {
    list(workspaceId?: WorkspaceId): Guardrail[];
    add(params: MethodParams<'guardrail.add'>): Promise<Guardrail>;
    delete(guardrailId: Guardrail['id']): Promise<void>;
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

  /** 生成并让合格的进入试用（0.107.0）；`origin` 是 `auto` 时是后台生成。调了模型的都记进 `tuning_runs`。 */
  async generate(
    params: MethodParams<'tuning.proposal.generate'>,
    options: { origin?: 'user' | 'auto' } = {},
  ): Promise<Generated> {
    const origin = options.origin ?? 'user';
    const result = await this.#generate(params, origin);
    const session = this.#options.storage.sessions.get(params.sessionId);
    if (session !== undefined && (result.reason === undefined || !NOT_RUN.has(result.reason))) {
      this.#options.storage.tuningRuns.insert({
        id: newId('trr'),
        workspaceId: session.workspaceId,
        sessionId: params.sessionId,
        origin,
        ...(result.usage !== undefined && { usage: result.usage }),
        proposals: result.proposals.length,
        ...(result.reason !== undefined && { reason: result.reason }),
        createdAt: this.#now().toISOString(),
      });
    }
    return result;
  }

  async #generate(
    params: MethodParams<'tuning.proposal.generate'>,
    origin: 'user' | 'auto',
  ): Promise<Generated> {
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
        status: 'trial',
        origin,
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
    const entered = await this.#enterTrial(records);
    if (params.replaces !== undefined) {
      const old = storage.tuningProposals.get(params.replaces);
      if (old !== undefined && (old.status === 'stale' || old.status === 'pending')) {
        storage.tuningProposals.delete(old.id);
      }
    }
    this.#emit(workspace.id);
    if (entered.length > 0) this.#options.onProfileChanged?.(workspace.id);
    return {
      proposals: entered.map((record) => this.#toProposal(record)),
      ...(usage !== undefined && { usage }),
      ...(summarized && { summarized: true as const }),
    };
  }

  /** 把模型给的一条变成存下的改动与基准散列；不能用时返回原因。 */
  async #build(
    proposal: BuildInput,
    workspace: WorkspaceRecord,
    agentsText: string | undefined,
  ): Promise<{ change: TuningProposalChange; target: string; baseHash: string } | string> {
    const root = workspace.rootPath;
    switch (proposal.kind) {
      case 'rule': {
        const before = agentsText ?? '';
        if (before.length > TUNING_PROPOSAL_TEXT_MAX_LENGTH) return 'AGENTS.md too long';
        const after =
          'after' in proposal ? proposal.after : applyUnifiedDiff(before, proposal.diff);
        if (after === undefined) return 'diff does not apply';
        if (after.length > TUNING_PROPOSAL_TEXT_MAX_LENGTH) return 'too long';
        if (after === before) return 'no change';
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
        ? ['pending', 'stale', 'trial']
        : params.status === 'decided'
          ? ['accepted', 'rejected', 'reverted']
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
    // 0.107.0：试用中的，采纳是提前保留，拒绝是撤销。
    if (record.status === 'trial') {
      const proposal =
        params.decision === 'accept'
          ? this.keep(record.id as TuningProposalId, 'user')
          : await this.revert(record.id as TuningProposalId, 'user');
      return { proposal };
    }
    const target = params.decision === 'accept' ? 'accepted' : 'rejected';
    if (
      record.status === 'accepted' ||
      record.status === 'rejected' ||
      record.status === 'reverted'
    ) {
      if (record.status === target) return { proposal: this.#toProposal(record) };
      throw invalid(['decision'], `proposal ${record.id} is already ${record.status}`);
    }
    let applied: Applied | undefined;
    if (params.decision === 'accept') {
      await this.#checkOpen(record);
      try {
        applied = await this.#apply(record);
      } catch (error) {
        if (error instanceof HostError && error.code === 'PROPOSAL_STALE') {
          this.#markStale(record);
          this.#emit(record.workspaceId);
        }
        throw error;
      }
    }
    this.#options.storage.tuningProposals.update(record.id, {
      status: target,
      decidedAt: this.#now().toISOString(),
      ...(applied !== undefined && { payload: { ...payloadOf(record), applied } }),
    });
    this.#emit(record.workspaceId);
    if (params.decision === 'accept') this.#options.onProfileChanged?.(record.workspaceId);
    return { proposal: this.#toProposal(this.#record(params.proposalId)) };
  }

  // ── 试用（0.107.0） ──────────────────────────────────────────────────

  /**
   * agent 提交一条改动（`wevir_tuning_propose`）：校验同生成（长度、密钥样文本、SKILL.md 可解析、护栏不重复、内容有变化），通过后写入
   * 并进入试用，来源 `agent`。不合格时 `INVALID_PARAMS`（原因在消息里）。
   */
  async propose(sessionId: SessionId, input: ProposeInput): Promise<TuningProposal> {
    const { storage } = this.#options;
    const session = storage.sessions.get(sessionId);
    if (session === undefined)
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    const workspace = storage.workspaces.get(session.workspaceId);
    if (
      workspace === undefined ||
      workspace.removedAt !== undefined ||
      this.#options.isChats?.(workspace) === true
    ) {
      throw invalid(['sessionId'], 'tuning changes need a session in a project');
    }
    if (input.kind === 'guardrail' && this.#options.guardrails === undefined) {
      throw invalid(['kind'], 'this host has no guardrails');
    }
    const agentsText = await readText(join(workspace.rootPath, 'AGENTS.md'));
    const parsed: BuildInput =
      input.kind === 'rule'
        ? { kind: 'rule', title: input.title, after: input.content, evidence: [] }
        : input.kind === 'skill'
          ? { ...input, evidence: [] }
          : input.kind === 'memory'
            ? { ...input, evidence: [] }
            : {
                kind: 'guardrail',
                title: input.title,
                ...(input.name !== undefined && { name: input.name }),
                rule: input.rule,
                evidence: [],
              };
    const built = await this.#build(parsed, workspace, agentsText);
    if (typeof built === 'string') throw invalid(['content'], built);
    const reason = input.reason?.trim();
    const record: TuningProposalRecord = {
      id: newId('tpr'),
      workspaceId: workspace.id,
      sessionId,
      kind: input.kind,
      title: input.title,
      target: built.target,
      baseHash: built.baseHash,
      payload: { change: built.change } satisfies StoredPayload,
      evidence:
        reason === undefined || reason === ''
          ? []
          : [{ id: 'agent', text: reason.slice(0, TUNING_PROPOSAL_EVIDENCE_TEXT_MAX_LENGTH) }],
      status: 'trial',
      origin: 'agent',
      createdAt: this.#now().toISOString(),
    };
    const [entered] = await this.#enterTrial([record], { throwOnFailure: true });
    this.#emit(workspace.id);
    this.#options.onProfileChanged?.(workspace.id);
    return this.#toProposal(entered as TuningProposalRecord);
  }

  /** 这个项目里试用中的，旧的在前。 */
  trialRecords(workspaceId: string): TuningProposalRecord[] {
    // 列表是新的在前、同一刻按写入先后；按时刻升序稳定排序，同一刻的仍按写入先后。
    const at = (record: TuningProposalRecord) => Date.parse(record.decidedAt ?? record.createdAt);
    return this.#options.storage.tuningProposals
      .list({ workspaceId, statuses: ['trial'] })
      .sort((a, b) => at(a) - at(b));
  }

  /** 试用的结论是保留：状态改为 `accepted`，记下结论。 */
  conclude(id: TuningProposalId, outcome: Omit<TuningTrialOutcome, 'result' | 'decidedAt'>): void {
    const record = this.#record(id);
    if (record.status !== 'trial') return;
    this.#options.storage.tuningProposals.update(record.id, {
      status: 'accepted',
      decidedAt: this.#now().toISOString(),
      outcome: { ...outcome, result: 'kept', decidedAt: this.#now().toISOString() },
    });
    this.#emit(record.workspaceId);
  }

  /** 用户或 agent 提前保留一条试用中的（`outcome.reason` 为 `manual`）。已保留的原样返回；其余状态 `INVALID_PARAMS`。 */
  keep(id: TuningProposalId, by: 'user' | 'agent'): TuningProposal {
    const record = this.#record(id);
    if (record.status === 'accepted') return this.#toProposal(record);
    if (record.status !== 'trial') {
      throw invalid(['proposalId'], `proposal ${record.id} is ${record.status}, not in trial`);
    }
    this.conclude(id, { decidedBy: by, reason: 'manual' });
    return this.#toProposal(this.#record(id));
  }

  /**
   * 撤销或回退（`tuning.proposal.revert`、`wevir_tuning_decide revert`、试用变差）：只对 `trial` 与 `accepted` 有效，`reverted` 原样返回，
   * 其余 `INVALID_PARAMS`。目标在采纳后被改过时：手动的回 `PROPOSAL_STALE`；自动的（`by` 为 `auto`）改记保留、`reason` 为 `conflict`。
   */
  async revert(
    id: TuningProposalId,
    by: 'user' | 'agent' | 'auto',
    outcome: Pick<TuningTrialOutcome, 'reason' | 'baseline' | 'trial'> = { reason: 'manual' },
  ): Promise<TuningProposal> {
    const record = this.#record(id);
    if (record.status === 'reverted') return this.#toProposal(record);
    if (record.status !== 'trial' && record.status !== 'accepted') {
      throw invalid(
        ['proposalId'],
        `proposal ${record.id} is ${record.status} and cannot be reverted`,
      );
    }
    const result = await this.#restore(record);
    const decidedAt = this.#now().toISOString();
    if (result === 'conflict') {
      if (by !== 'auto') {
        throw new HostError(
          'PROPOSAL_STALE',
          `the target of proposal ${record.id} changed after it was applied; change it back by hand`,
        );
      }
      this.#options.storage.tuningProposals.update(record.id, {
        status: 'accepted',
        decidedAt,
        outcome: { ...outcome, decidedBy: by, result: 'kept', reason: 'conflict', decidedAt },
      });
      this.#emit(record.workspaceId);
      return this.#toProposal(this.#record(id));
    }
    this.#options.storage.tuningProposals.update(record.id, {
      status: 'reverted',
      decidedAt,
      outcome: { ...outcome, decidedBy: by, result: 'reverted', decidedAt },
    });
    this.#emit(record.workspaceId);
    if (result === 'restored') this.#options.onProfileChanged?.(record.workspaceId);
    return this.#toProposal(this.#record(id));
  }

  /** 写入并进入试用；目标在生成之后变了的（或写不进去的）丢掉并记警告。返回进入试用的。 */
  async #enterTrial(
    records: TuningProposalRecord[],
    options: { throwOnFailure?: boolean } = {},
  ): Promise<TuningProposalRecord[]> {
    const entered: TuningProposalRecord[] = [];
    for (const record of records) {
      try {
        if (await this.#isStale(record)) throw stale(record.id);
        const applied = await this.#apply(record);
        const next: TuningProposalRecord = {
          ...record,
          status: 'trial',
          decidedAt: this.#now().toISOString(),
          payload: { ...payloadOf(record), applied } satisfies StoredPayload,
        };
        this.#options.storage.tuningProposals.insert(next);
        entered.push(next);
      } catch (error) {
        if (options.throwOnFailure === true) throw error;
        this.#options.onWarning?.('调优改动没能写入目标，丢掉', {
          sessionId: record.sessionId,
          title: record.title,
          error: (error as Error).message,
        });
      }
    }
    return entered;
  }

  /** 按 `applied` 核对目标，没变就恢复采纳前的内容。 */
  async #restore(record: TuningProposalRecord): Promise<RestoreResult> {
    const { change, applied } = payloadOf(record);
    const missingBefore = record.baseHash === MISSING;
    switch (change.kind) {
      case 'rule':
      case 'skill': {
        const current = await readText(change.path);
        const beforeState = missingBefore ? undefined : change.before;
        if (current === beforeState) return 'already';
        if (
          applied === undefined ||
          !('afterHash' in applied) ||
          current === undefined ||
          sha256(current) !== applied.afterHash
        ) {
          return 'conflict';
        }
        if (beforeState !== undefined) {
          await writeAtomic(change.path, beforeState);
          return 'restored';
        }
        if (change.kind === 'skill') {
          await this.#options.disableSkill?.(change.path).catch((error: unknown) => {
            this.#options.onWarning?.('回退的技能没能停用', {
              path: change.path,
              error: (error as Error).message,
            });
          });
          await rm(change.path, { force: true });
          await rmdir(dirname(change.path)).catch(() => {});
        } else {
          await rm(change.path, { force: true });
        }
        return 'restored';
      }
      case 'memory': {
        const current = await this.#note(record.workspaceId, change.name);
        if (missingBefore ? current === undefined : current?.content === change.before) {
          return 'already';
        }
        if (
          applied === undefined ||
          !('revision' in applied) ||
          'guardrailId' in applied ||
          current === undefined ||
          current.revision !== applied.revision
        ) {
          return 'conflict';
        }
        if (missingBefore) {
          const { conflict } = await this.#options.memory.delete(
            'project',
            record.workspaceId,
            change.name,
            { includeDisabled: true, revision: applied.revision },
          );
          return conflict === undefined ? 'restored' : 'conflict';
        }
        const { conflict } = await this.#options.memory.update(
          'project',
          record.workspaceId,
          change.name,
          applied.revision,
          { content: change.before },
        );
        return conflict === true ? 'conflict' : 'restored';
      }
      case 'guardrail': {
        const guardrails = this.#options.guardrails;
        if (guardrails === undefined || applied === undefined || !('guardrailId' in applied)) {
          return 'conflict';
        }
        const current = guardrails
          .list(record.workspaceId as WorkspaceId)
          .find((g) => g.id === applied.guardrailId);
        if (current === undefined) return 'already';
        if (current.revision !== applied.revision) return 'conflict';
        await guardrails.delete(current.id);
        return 'restored';
      }
    }
  }

  /** 写入目标，返回改后内容的标记。目标在核对之后、写之前被改了（记忆的版本冲突）回 `PROPOSAL_STALE`。 */
  async #apply(record: TuningProposalRecord): Promise<Applied> {
    const { change } = payloadOf(record);
    switch (change.kind) {
      case 'rule':
        await writeAtomic(change.path, change.after);
        return { afterHash: sha256(change.after) };
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
        return { afterHash: sha256(change.after) };
      case 'memory':
        try {
          const { note } = await this.#options.memory.adopt(
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
          return { revision: note.revision };
        } catch (error) {
          if (error instanceof MemoryError && error.code === 'conflict') throw stale(record.id);
          if (error instanceof MemoryError) throw invalid(['after'], error.message);
          throw error;
        }
      case 'guardrail': {
        const guardrails = this.#options.guardrails;
        if (guardrails === undefined) throw invalid(['proposalId'], 'this host has no guardrails');
        const added = await guardrails.add({
          workspaceId: record.workspaceId as WorkspaceId,
          ...(change.name !== undefined && { name: change.name }),
          rule: change.rule,
        });
        return { guardrailId: added.id, revision: added.revision };
      }
    }
  }

  /** 待审才能改与采纳：已处理 `INVALID_PARAMS`；已过时或目标刚变 `PROPOSAL_STALE`（刚变的标成已过时）。 */
  async #checkOpen(record: TuningProposalRecord): Promise<void> {
    if (
      record.status === 'accepted' ||
      record.status === 'rejected' ||
      record.status === 'trial' ||
      record.status === 'reverted'
    ) {
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
    const outcome = TuningTrialOutcomeSchema.safeParse(record.outcome);
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
      origin: (TuningProposalOriginSchema.safeParse(record.origin).data ??
        'user') as TuningProposalOrigin,
      ...(outcome.success && { outcome: outcome.data }),
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
  const applied = appliedOf(payload?.applied);
  return {
    change: change.data,
    ...(payload?.edited === true && { edited: true }),
    ...(applied !== undefined && { applied }),
  };
}

function appliedOf(value: unknown): Applied | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.afterHash === 'string') return { afterHash: item.afterHash };
  if (typeof item.guardrailId === 'string' && typeof item.revision === 'number') {
    return { guardrailId: item.guardrailId, revision: item.revision };
  }
  if (typeof item.revision === 'string') return { revision: item.revision };
  return undefined;
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
