// 各页面的斜杠命令（U33）：会话页、草稿页与首页各自拼出能用的命令，交给输入框（composer.tsx）。照 Codex 桌面端的命令
// 表取 Wevir 现在做得到的：模型、思考力度、权限（二级菜单），新建会话、支线提问、文件、变更、状态、初始化；0.24.0 起还有
// 压缩上下文与代码审查（Host 声明 `session_compact` / `session_review` 时）。

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
  type LucideIcon,
  MessagesSquare,
  Pencil,
  ScanSearch,
  Shield,
  SquarePen,
} from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { openChanges } from '@/changes/changes-store';
import { ProviderLogo } from '@/components/provider-logo';
import { isPickable, pickerOrder, sourceOf } from '@/data/sources';
import { useAccounts } from '@/data/workbench-data';
import { openFiles } from '@/files/files-store';
import { currentLocale, t } from '@/i18n';
import { layoutPrefs, transientLayout } from '@/layout/layout-state';
import type { PaneController } from '@/layout/pane-controller';
import { paths } from '@/routes/paths';
import { providerLogo } from '@/settings/provider-catalog';
import type { ComposerCommand, ComposerCommandItem } from './composer-commands';
import { initPrompt } from './init-prompt';
import { effortLabel, type ModelChoice, modelsOf } from './model-picker';
import { PERMISSION_META, PERMISSION_MODES } from './permission-picker';

function modelCommand(
  providers: readonly ProviderProfile[],
  value: ModelChoice,
  lockProvider: boolean,
  accounts: ReturnType<typeof useAccounts>,
  onChange: (next: ModelChoice) => void,
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
      const listed = lockProvider
        ? provider
          ? [provider]
          : []
        : pickerOrder(
            providers.filter(
              (candidate) => candidate.id === value.providerId || isPickable(candidate, accounts),
            ),
          );
      return listed.flatMap((candidate) => {
        const source = sourceOf(candidate);
        const group = source ? t(source.name) : candidate.displayName;
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
      PERMISSION_MODES.map((candidate) => {
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

function simple(
  name: string,
  label: string,
  icon: LucideIcon,
  run: () => void,
  plus = false,
): ComposerCommand {
  return { name, label, icon, run, ...(plus && { plus: true }) };
}

/** 打开会话侧栏，展开“上下文”卡片（用量）。 */
function showStatus(): void {
  layoutPrefs.set((current) => ({
    ...current,
    railShown: true,
    railOpen: current.railOpen.includes('context')
      ? current.railOpen
      : [...current.railOpen, 'context'],
  }));
  transientLayout.set((state) => ({ ...state, railOverlayOpen: true, auxOverlayOpen: false }));
}

export interface SessionCommandOptions {
  workspaceId: string;
  sessionId: SessionId;
  providers: readonly ProviderProfile[];
  model: ModelChoice;
  /** Host 能在会话中换模型（`session_configure`）且会话可写。 */
  canConfigure: boolean;
  onModelChange: (next: ModelChoice) => void;
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
  /** Host 能压缩上下文、审查代码（0.24.0）且会话可写时给。 */
  onCompact?: () => void;
  onReview?: (target: ReviewTarget) => void;
}

/** 已有会话的命令。 */
export function useSessionCommands(options: SessionCommandOptions): ComposerCommand[] {
  const navigate = useNavigate();
  const accounts = useAccounts();
  const {
    workspaceId,
    sessionId,
    providers,
    model,
    canConfigure,
    onModelChange,
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
  } = options;
  return useMemo(() => {
    const commands: ComposerCommand[] = [];
    if (canConfigure) {
      commands.push(modelCommand(providers, model, true, accounts, onModelChange));
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
    commands.push(simple('status', t('command.status'), Gauge, showStatus));
    if (onRename) commands.push(simple('rename', t('command.rename'), Pencil, onRename));
    if (onArchive) commands.push(simple('archive', t('command.archive'), Archive, onArchive));
    commands.push(
      simple('init', t('command.init'), FileCode2, () => send(initPrompt(currentLocale()))),
    );
    return commands;
  }, [
    onRename,
    onArchive,
    onCompact,
    onReview,
    workspaceId,
    sessionId,
    providers,
    model,
    canConfigure,
    onModelChange,
    permission,
    sideEnabled,
    filesEnabled,
    diffEnabled,
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
}

/** 新会话（草稿页、首页）的命令：选模型、思考力度、权限，打开文件，初始化。 */
export function useDraftCommands(options: DraftCommandOptions): ComposerCommand[] {
  const accounts = useAccounts();
  const { providers, model, onModelChange, permission, filesEnabled, panes, send } = options;
  return useMemo(() => {
    const commands: ComposerCommand[] = [];
    if (providers && model) {
      commands.push(modelCommand(providers, model, false, accounts, onModelChange));
      const effort = effortCommand(providers, model, onModelChange);
      if (effort) commands.push(effort);
    }
    if (permission) commands.push(permissionCommand(permission.mode, permission.onChange));
    if (filesEnabled && panes) {
      commands.push(simple('files', t('command.files'), FolderTree, () => openFiles(panes)));
    }
    if (send) {
      commands.push(
        simple('init', t('command.init'), FileCode2, () => send(initPrompt(currentLocale()))),
      );
    }
    return commands;
  }, [providers, model, onModelChange, permission, filesEnabled, panes, send, accounts]);
}
