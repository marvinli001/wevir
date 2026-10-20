// 各页面的斜杠命令（U33）：会话页、草稿页与首页各自拼出能用的命令，交给输入框（composer.tsx）。照 Codex 桌面端的命令
// 表取 Wevir 现在做得到的：模型、思考力度、权限（二级菜单），新建会话、支线提问、文件、变更、状态、初始化；0.24.0 起还有
// 压缩上下文与代码审查（Host 声明 `session_compact` / `session_review`、会话当前的引擎会时）；0.35.0 起还有目标（`/goal`，Host
// 声明 `session_goals`、会话当前的引擎有目标时，也在“+”菜单里，同 Codex 桌面端）；0.36.0 起有计划模式（`/plan`、`/default`
// 与“+”菜单的开关）。

import type { PermissionMode, ProviderProfile, ReviewTarget, SessionId } from '@wevir/protocol';
import {
  Archive,
  Brain,
  Cpu,
  FileCode2,
  FolderTree,
  FoldVertical,
  Gauge,
  GitCompare,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  Pencil,
  Redo2,
  ScanSearch,
  Shield,
  SquarePen,
  Undo2,
} from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { openChanges } from '@/changes/changes-store';
import { GoalIcon } from '@/components/command-icons';
import { ProviderLogo } from '@/components/provider-logo';
import { isPickable, pickerOrder, sourceOf, sourceTitle } from '@/data/sources';
import { useAccounts } from '@/data/workbench-data';
import { openFiles } from '@/files/files-store';
import { currentLocale, t } from '@/i18n';
import type { PaneController } from '@/layout/pane-controller';
import { paths } from '@/routes/paths';
import { providerLogo } from '@/settings/provider-catalog';
import type { ComposerCommand, ComposerCommandItem } from './composer-commands';
import { composerPrefs, toggleContextMeter } from './composer-prefs';
import { initPrompt } from './init-prompt';
import { effortLabel, type ModelChoice, modelsOf } from './model-picker';
import { allowedPermissionModes, PERMISSION_META, PERMISSION_MODES } from './permission-picker';

function modelCommand(
  providers: readonly ProviderProfile[],
  value: ModelChoice,
  lockProvider: boolean,
  accounts: ReturnType<typeof useAccounts>,
  onChange: (next: ModelChoice) => void,
  /** 已有会话能接力过去的别的 Provider（0.25.0）。 */
  switchable?: (provider: ProviderProfile) => boolean,
): ComposerCommand {
  const provider = providers.find((candidate) => candidate.id === value.providerId);
  const current = provider && modelsOf(provider).find((model) => model.id === value.modelId);
  return {
    name: 'model',
    label: t('command.model'),
    icon: Cpu,
    detail: current?.displayName ?? value.modelId,
    plus: true,
    items: () => {
      const listed = pickerOrder(
        providers.filter(
          (candidate) =>
            candidate.id === value.providerId ||
            (isPickable(candidate, accounts) &&
              (!lockProvider || (switchable?.(candidate) ?? false))),
        ),
      );
      return listed.flatMap((candidate) => {
        const source = sourceOf(candidate);
        const group = source
          ? sourceTitle(candidate, accounts, t(source.name))
          : candidate.displayName;
        const logo = source?.logo ?? providerLogo(candidate);
        return modelsOf(candidate).map<ComposerCommandItem>((model) => ({
          id: `${candidate.id}/${model.id}`,
          label: model.displayName ?? model.id,
          detail: group,
          icon: <ProviderLogo logo={logo} fallback={group} className="size-4" />,
          checked: candidate.id === value.providerId && model.id === value.modelId,
          run: () => {
            if (candidate.id === value.providerId && model.id === value.modelId) return;
            onChange({ providerId: candidate.id, modelId: model.id });
          },
        }));
      });
    },
  };
}

function effortCommand(
  providers: readonly ProviderProfile[],
  value: ModelChoice,
  onChange: (next: ModelChoice) => void,
): ComposerCommand | undefined {
  const provider = providers.find((candidate) => candidate.id === value.providerId);
  const model = provider && modelsOf(provider).find((candidate) => candidate.id === value.modelId);
  const efforts = model?.reasoningEfforts ?? [];
  if (efforts.length === 0) return undefined;
  return {
    name: 'effort',
    label: t('command.effort'),
    icon: Brain,
    detail: effortLabel(value.reasoningEffort),
    plus: true,
    items: () => [
      {
        id: 'default',
        label: effortLabel(undefined),
        checked: value.reasoningEffort === undefined,
        run: () => {
          const { reasoningEffort: _cleared, ...rest } = value;
          onChange(rest);
        },
      },
      ...efforts.map((effort) => ({
        id: effort,
        label: effortLabel(effort),
        checked: value.reasoningEffort === effort,
        run: () => onChange({ ...value, reasoningEffort: effort }),
      })),
    ],
  };
}

function permissionCommand(
  mode: PermissionMode,
  onChange: (next: PermissionMode) => void,
): ComposerCommand {
  return {
    name: 'permissions',
    label: t('command.permissions'),
    icon: Shield,
    detail: t(PERMISSION_META[mode].label),
    plus: true,
    items: () =>
      PERMISSION_MODES.filter(
        (candidate) => candidate === mode || allowedPermissionModes().includes(candidate),
      ).map((candidate) => {
        const { icon: Icon, label } = PERMISSION_META[candidate];
        return {
          id: candidate,
          label: t(label),
          icon: <Icon />,
          checked: candidate === mode,
          run: () => candidate !== mode && onChange(candidate),
        };
      }),
  };
}

/** 计划模式（0.36.0）的开关：Shift+Tab、输入框底栏的芯片与这里是同一个开关。 */
export interface PlanCommandOptions {
  active: boolean;
  onToggle: () => void;
}

/**
 * 计划模式的命令（0.36.0，照 Codex 桌面端）：“+”菜单里是一项开关（开着时打勾）；斜杠菜单里关着时是 `/plan`，开着时是
 * `/default`（退出）。
 */
function planCommands(plan: PlanCommandOptions): ComposerCommand[] {
  return [
    {
      name: 'plan',
      label: t('command.plan'),
      icon: ListChecks,
      plus: true,
      checked: plan.active,
      run: plan.onToggle,
      ...(plan.active && { slash: false as const }),
    },
    ...(plan.active
      ? [{ name: 'default', label: t('command.default'), icon: ListChecks, run: plan.onToggle }]
      : []),
  ];
}

function simple(
  name: string,
  label: string,
  icon: LucideIcon,
  run: () => void,
  plus = false,
): ComposerCommand {
  return { name, label, icon, run, ...(plus && { plus: true }) };
}

/** `/status`：开关输入框底栏的上下文用量（context-meter.tsx），开着时斜杠菜单里打勾。 */
function statusCommand(shown: boolean): ComposerCommand {
  return {
    name: 'status',
    label: t('command.status'),
    icon: Gauge,
    checked: shown,
    run: toggleContextMeter,
  };
}

export interface SessionCommandOptions {
  workspaceId: string;
  sessionId: SessionId;
  providers: readonly ProviderProfile[];
  model: ModelChoice;
  /** Host 能在会话中换模型（`session_configure`）且会话可写。 */
  canConfigure: boolean;
  onModelChange: (next: ModelChoice) => void;
  /** 能接力过去的别的 Provider（0.25.0）；省略时只在当前 Provider 里换。 */
  switchable?: (provider: ProviderProfile) => boolean;
  /** 有权限模式可选时给。 */
  permission?: { mode: PermissionMode; onChange: (next: PermissionMode) => void };
  /** Host 能分出支线（/btw）。 */
  sideEnabled: boolean;
  filesEnabled: boolean;
  diffEnabled: boolean;
  panes: PaneController | undefined;
  send: (text: string) => void;
  /** Host 能改名、归档（0.23.0）时给。 */
  onRename?: () => void;
  onArchive?: () => void;
  /** Host 能压缩上下文、审查代码（0.24.0）、会话当前的引擎会（0.27.0）且会话可写时给。 */
  onCompact?: () => void;
  onReview?: (target: ReviewTarget) => void;
  /** 会话能撤销与重做（0.51.0）且可写时给；`onRedo` 只在有撤销的回合可重做时给。 */
  onUndo?: () => void;
  onRedo?: () => void;
  /** 会话能用目标（0.35.0）且可写：`/goal ` 放进输入框，接着写目标。 */
  goalEnabled?: boolean;
  /** 会话当前的引擎有计划模式（0.36.0）且会话可写时给。 */
  plan?: PlanCommandOptions;
}

/** `/goal`（0.35.0）：选中后输入框里是 `/goal `，接着写目标；也在“+”菜单里。 */
function goalCommand(): ComposerCommand {
  return { name: 'goal', label: t('command.goal'), icon: GoalIcon, insert: '/goal ', plus: true };
}

/** 已有会话的命令。 */
export function useSessionCommands(options: SessionCommandOptions): ComposerCommand[] {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const showContext = composerPrefs.use().showContext;
  const {
    workspaceId,
    sessionId,
    providers,
    model,
    canConfigure,
    onModelChange,
    switchable,
    permission,
    sideEnabled,
    filesEnabled,
    diffEnabled,
    panes,
    send,
    onRename,
    onArchive,
    onCompact,
    onReview,
    onUndo,
    onRedo,
    goalEnabled,
    plan,
  } = options;
  return useMemo(() => {
    const commands: ComposerCommand[] = [];
    if (plan) commands.push(...planCommands(plan));
    if (canConfigure) {
      commands.push(modelCommand(providers, model, true, accounts, onModelChange, switchable));
      const effort = effortCommand(providers, model, onModelChange);
      if (effort) commands.push(effort);
    }
    if (permission) commands.push(permissionCommand(permission.mode, permission.onChange));
    commands.push(
      simple('new', t('command.new'), SquarePen, () => navigate(paths.draft(workspaceId))),
    );
    if (sideEnabled) {
      commands.push({
        name: 'btw',
        label: t('command.btw'),
        icon: MessagesSquare,
        insert: '/btw ',
        plus: true,
      });
    }
    if (filesEnabled && panes) {
      commands.push(simple('files', t('command.files'), FolderTree, () => openFiles(panes)));
    }
    if (diffEnabled && panes) {
      commands.push(
        simple('diff', t('command.diff'), GitCompare, () =>
          openChanges(panes, sessionId, { kind: 'uncommitted' }),
        ),
      );
    }
    if (goalEnabled) commands.push(goalCommand());
    if (onUndo) commands.push(simple('undo', t('command.undo'), Undo2, onUndo));
    if (onRedo) commands.push(simple('redo', t('command.redo'), Redo2, onRedo));
    if (onCompact) commands.push(simple('compact', t('command.compact'), FoldVertical, onCompact));
    if (onReview) {
      commands.push({
        name: 'review',
        label: t('command.review'),
        icon: ScanSearch,
        items: () => [
          { id: 'uncommitted', label: t('review.uncommitted'), run: () => onReview('uncommitted') },
          { id: 'branch', label: t('review.baseBranch'), run: () => onReview('branch') },
        ],
      });
    }
    commands.push(statusCommand(showContext));
    if (onRename) commands.push(simple('rename', t('command.rename'), Pencil, onRename));
    if (onArchive) commands.push(simple('archive', t('command.archive'), Archive, onArchive));
    commands.push(
      simple('init', t('command.init'), FileCode2, () => send(initPrompt(currentLocale()))),
    );
    return commands;
  }, [
    plan,
    onRename,
    onArchive,
    onCompact,
    onReview,
    onUndo,
    onRedo,
    goalEnabled,
    workspaceId,
    sessionId,
    providers,
    model,
    canConfigure,
    onModelChange,
    switchable,
    permission,
    sideEnabled,
    filesEnabled,
    diffEnabled,
    showContext,
    panes,
    send,
    accounts,
    navigate,
  ]);
}

export interface DraftCommandOptions {
  providers: readonly ProviderProfile[] | undefined;
  model: ModelChoice | undefined;
  onModelChange: (next: ModelChoice) => void;
  permission?: { mode: PermissionMode; onChange: (next: PermissionMode) => void };
  filesEnabled: boolean;
  panes: PaneController | undefined;
  /** 发出第一条消息（建会话）；没有工作区时不给。 */
  send?: (text: string) => void;
  /** 选的模型能用目标（0.35.0）：`/goal 〈目标〉` 建会话并设目标。 */
  goalEnabled?: boolean;
  /** 选的模型所在的引擎有计划模式（0.36.0）时给。 */
  plan?: PlanCommandOptions;
}

/** 新会话（草稿页、首页）的命令：选模型、思考力度、权限，打开文件，初始化。 */
export function useDraftCommands(options: DraftCommandOptions): ComposerCommand[] {
  const accounts = useAccounts();
  const {
    providers,
    model,
    onModelChange,
    permission,
    filesEnabled,
    panes,
    send,
    goalEnabled,
    plan,
  } = options;
  return useMemo(() => {
    const commands: ComposerCommand[] = [];
    if (plan) commands.push(...planCommands(plan));
    if (providers && model) {
      commands.push(modelCommand(providers, model, false, accounts, onModelChange));
      const effort = effortCommand(providers, model, onModelChange);
      if (effort) commands.push(effort);
    }
    if (permission) commands.push(permissionCommand(permission.mode, permission.onChange));
    if (filesEnabled && panes) {
      commands.push(simple('files', t('command.files'), FolderTree, () => openFiles(panes)));
    }
    if (send && goalEnabled) commands.push(goalCommand());
    if (send) {
      commands.push(
        simple('init', t('command.init'), FileCode2, () => send(initPrompt(currentLocale()))),
      );
    }
    return commands;
  }, [
    providers,
    model,
    onModelChange,
    permission,
    filesEnabled,
    panes,
    send,
    goalEnabled,
    plan,
    accounts,
  ]);
}
