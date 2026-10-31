// 调优的应用级工具（0.108.0，`wevir_tuning_*`，domain-model §3.50，ADR-0018）：agent 读写调用方项目的调优。三个都不用批准
// （runtime-adapter 的 `APP_TOOLS_NO_APPROVAL`）：提交的改动进入试用，按之后会话的指标保留或回退，用户随时能撤销。不受设置
// `autoTuning` 控制（它只管后台生成）。只对项目里的会话可用，“对话”里的调用说明原因。

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GuardrailRuleSchema,
  MEMORY_DESCRIPTION_MAX,
  MemoryNameSchema,
  type SessionId,
  TUNING_PROPOSAL_TITLE_MAX_LENGTH,
  type TuningProposal,
  type TuningProposalId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { Storage, WorkspaceRecord } from '@wevir/storage';
import { type AppTool, AppToolError, jsonResult } from '../app-mcp.js';
import { objectSchema, optionalString, requiredString } from '../app-tools.js';
import { HostError } from '../errors.js';
import type { ProposalService, ProposeInput } from './proposals.js';
import type { TuningService } from './service.js';
import type { TrialService } from './trials.js';

/** 调优工具的名字（都不用批准）。 */
export const TUNING_TOOLS = [
  'wevir_tuning_status',
  'wevir_tuning_propose',
  'wevir_tuning_decide',
] as const;

/** 写的工具：只读角色不给。 */
export const TUNING_WRITE_TOOLS = ['wevir_tuning_propose', 'wevir_tuning_decide'];

/** 状态里一段改动全文的上限（字符）；更长的写进文件，结果给路径。 */
const CHANGE_TEXT_MAX = 4000;
/** 最近几条结论。 */
const OUTCOMES_MAX = 10;

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

export interface TuningToolsOptions {
  storage: Pick<Storage, 'sessions' | 'workspaces'>;
  proposals: Pick<ProposalService, 'propose' | 'keep' | 'revert' | 'list'>;
  trials: Pick<TrialService, 'overview'>;
  tuning: Pick<TuningService, 'get'>;
  isChats?: (workspace: Pick<WorkspaceRecord, 'rootPath'>) => boolean;
  /** 太长的改动全文写到这里（`<目录>/<散列>.txt`）。 */
  spillDir: string;
}

export function tuningTools(options: TuningToolsOptions): AppTool[] {
  const { storage, proposals, trials, tuning } = options;

  const workspaceOf = (sessionId: SessionId): WorkspaceId => {
    const session = storage.sessions.get(sessionId);
    if (session === undefined) throw new AppToolError('This Wevir session no longer exists.');
    const workspace = storage.workspaces.get(session.workspaceId);
    if (
      workspace === undefined ||
      workspace.removedAt !== undefined ||
      options.isChats?.(workspace) === true
    ) {
      throw new AppToolError(
        'Tuning works on a project, and this session is not in one (it is a chat or its project was removed).',
      );
    }
    return workspace.id as WorkspaceId;
  };

  const hostErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof HostError) throw new AppToolError(error.message);
      throw error;
    }
  };

  const spill = async (text: string): Promise<{ text?: string; path?: string; length: number }> => {
    if (text.length <= CHANGE_TEXT_MAX) return { text, length: text.length };
    const name = `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.txt`;
    await mkdir(options.spillDir, { recursive: true });
    const path = join(options.spillDir, name);
    await writeFile(path, text, 'utf8');
    return { text: `${text.slice(0, CHANGE_TEXT_MAX)}\n…`, path, length: text.length };
  };

  const describe = async (proposal: TuningProposal): Promise<Record<string, unknown>> => {
    const change = proposal.change;
    const body =
      change.kind === 'guardrail'
        ? { rule: change.rule, ...(change.name !== undefined && { name: change.name }) }
        : { after: await spill(change.after) };
    return {
      proposalId: proposal.id,
      kind: proposal.kind,
      title: proposal.title,
      target: proposal.target,
      origin: proposal.origin ?? 'user',
      status: proposal.status,
      ...(proposal.version !== undefined && { version: proposal.version.seq }),
      change: body,
    };
  };

  const statusTool: AppTool = {
    name: 'wevir_tuning_status',
    title: 'Tuning status',
    description:
      "This project's tuning: whether background tuning is on, this month's token use, the configuration layers (rules, " +
      'skills, memory, guardrails and more), the changes in trial with their full text, metrics per configuration version ' +
      '(sessions, turns, failed turns, verification passes) and the latest trial outcomes. Read it before proposing a change.',
    inputSchema: objectSchema({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    call: (_args, { sessionId }) =>
      hostErrors(async () => {
        const workspaceId = workspaceOf(sessionId);
        const [overview, current, listed] = await Promise.all([
          trials.overview({ workspaceId }),
          tuning.get({ workspaceId }),
          proposals.list({ workspaceId }),
        ]);
        const inTrial = listed.proposals.filter((p) => p.status === 'trial');
        const outcomes = listed.proposals
          .filter((p) => p.outcome !== undefined)
          .slice(0, OUTCOMES_MAX)
          .map((p) => ({
            proposalId: p.id,
            kind: p.kind,
            title: p.title,
            status: p.status,
            outcome: p.outcome,
          }));
        return jsonResult({
          overview,
          layers: current.profile.layers.map((layer) => ({
            key: layer.key,
            items: layer.items.length,
            hash: layer.hash.slice(0, 8),
          })),
          trial: await Promise.all(inTrial.map(describe)),
          outcomes,
        });
      }),
  };

  const proposeTool: AppTool = {
    name: 'wevir_tuning_propose',
    title: 'Propose a tuning change',
    description:
      "Change this project's configuration for later sessions: AGENTS.md (kind rule, give the whole new file), a project " +
      'skill (kind skill, the SKILL.md text), a project memory note (kind memory) or a guardrail (kind guardrail, a hard ' +
      'rule enforced on Codex sessions). The change is written right away and goes into a trial: after the next sessions ' +
      'Wevir keeps it or reverts it by their verification results and failed turns, and the user can undo it. Sessions ' +
      'already running, including this one, do not reread it. Prefer this over editing those files directly. ' +
      'Propose one when the user corrects a recurring problem, you find a fixed way this project works, or a hard ' +
      'rule is needed. Max characters: title ' +
      `${TUNING_PROPOSAL_TITLE_MAX_LENGTH}, description ${MEMORY_DESCRIPTION_MAX}.`,
    inputSchema: objectSchema(
      {
        kind: { type: 'string', enum: ['rule', 'skill', 'memory', 'guardrail'] },
        title: {
          type: 'string',
          description: 'Short name of the change, shown to the user.',
          maxLength: TUNING_PROPOSAL_TITLE_MAX_LENGTH,
        },
        reason: {
          type: 'string',
          description: 'Why: what went wrong or what keeps recurring. Shown to the user.',
        },
        content: {
          type: 'string',
          description:
            'rule: the full new AGENTS.md. skill: the full SKILL.md with name and description front matter. memory: the note body.',
        },
        name: {
          type: 'string',
          description:
            'skill: folder name under .agents/skills (lowercase letters, digits, hyphens). memory: note name. guardrail: optional label.',
        },
        type: {
          type: 'string',
          enum: [...MEMORY_TYPES],
          description: 'memory only.',
        },
        description: {
          type: 'string',
          description: 'memory only: one line saying what the note is about.',
          maxLength: MEMORY_DESCRIPTION_MAX,
        },
        rule: {
          type: 'object',
          description:
            'guardrail only. One of {kind: "forbidden_command", match: "prefix" | "regex", pattern}, ' +
            '{kind: "protected_path", glob}, {kind: "stop_check", command, maxAttempts?}, {kind: "commit_check", command}.',
        },
      },
      ['kind', 'title'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    call: (args, { sessionId }) =>
      hostErrors(async () => {
        workspaceOf(sessionId);
        const title = requiredString(args, 'title').trim();
        if (title.length > TUNING_PROPOSAL_TITLE_MAX_LENGTH) {
          throw new AppToolError(
            `title is longer than ${TUNING_PROPOSAL_TITLE_MAX_LENGTH} characters.`,
          );
        }
        const reason = optionalString(args, 'reason');
        const base = { title, ...(reason !== undefined && { reason }) };
        let input: ProposeInput;
        switch (args.kind) {
          case 'rule':
            input = { ...base, kind: 'rule', content: contentOf(args) };
            break;
          case 'skill':
            input = { ...base, kind: 'skill', name: skillName(args), content: contentOf(args) };
            break;
          case 'memory': {
            const name = MemoryNameSchema.safeParse(args.name);
            if (!name.success) throw new AppToolError('name must be a valid memory note name.');
            const type = args.type;
            if (!(MEMORY_TYPES as readonly unknown[]).includes(type)) {
              throw new AppToolError(`type must be one of ${MEMORY_TYPES.join(', ')}.`);
            }
            input = {
              ...base,
              kind: 'memory',
              name: name.data,
              type: type as (typeof MEMORY_TYPES)[number],
              description: requiredString(args, 'description').trim(),
              content: contentOf(args),
            };
            break;
          }
          case 'guardrail': {
            const rule = GuardrailRuleSchema.safeParse(args.rule);
            if (!rule.success)
              throw new AppToolError(`rule is not a valid guardrail: ${rule.error.message}`);
            const name = optionalString(args, 'name');
            input = {
              ...base,
              kind: 'guardrail',
              rule: rule.data,
              ...(name !== undefined && { name }),
            };
            break;
          }
          default:
            throw new AppToolError('kind must be one of rule, skill, memory, guardrail.');
        }
        const proposal = await proposals.propose(sessionId, input);
        return jsonResult({
          proposalId: proposal.id,
          status: proposal.status,
          target: proposal.target,
          note: 'Written and in trial. New sessions in this project use it; this session does not reread it.',
        });
      }),
  };

  const decideTool: AppTool = {
    name: 'wevir_tuning_decide',
    title: 'Keep or revert a tuning change',
    description:
      'End the trial of one change early: keep (it stays) or revert (the target goes back to what it was before the change; ' +
      'a target someone edited since is left alone and reported). Reverting also works on changes kept earlier.',
    inputSchema: objectSchema(
      {
        proposalId: { type: 'string' },
        decision: { type: 'string', enum: ['keep', 'revert'] },
      },
      ['proposalId', 'decision'],
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    call: (args, { sessionId }) =>
      hostErrors(async () => {
        const workspaceId = workspaceOf(sessionId);
        const id = requiredString(args, 'proposalId') as TuningProposalId;
        const listed = await proposals.list({ workspaceId });
        if (!listed.proposals.some((p) => p.id === id)) {
          throw new AppToolError(`No tuning change ${id} in this project.`);
        }
        let proposal: TuningProposal;
        if (args.decision === 'keep') proposal = proposals.keep(id, 'agent');
        else if (args.decision === 'revert') proposal = await proposals.revert(id, 'agent');
        else throw new AppToolError('decision must be keep or revert.');
        return jsonResult({
          proposalId: proposal.id,
          status: proposal.status,
          ...(proposal.outcome !== undefined && { outcome: proposal.outcome }),
        });
      }),
  };

  return [statusTool, proposeTool, decideTool];
}

function contentOf(args: Record<string, unknown>): string {
  const value = args.content;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppToolError('content is required and must be a non-empty string.');
  }
  return value;
}

function skillName(args: Record<string, unknown>): string {
  const name = requiredString(args, 'name');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new AppToolError(
      'name must be lowercase letters, digits and hyphens (the skill folder name).',
    );
  }
  return name;
}
