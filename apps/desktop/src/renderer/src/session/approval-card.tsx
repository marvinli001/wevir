// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/react-app/domains/session/chat/permission-approval-modal.tsx
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #9）。保留“内联面板、不用模态框”（会话里画在消息流末尾，照 Claude Code）“一次只显示第一个”“可折叠的
// 完整参数”。按钮不再是固定的 reject / once / always，而是按审批请求携带的选项渲染（approval-model.ts）；
// 内容取同一 toolCallId 的 rawInput（Host 放在 ApprovalRequest.detail：目标、所需权限、理由、写文件的内容
// 预览）；标出“还有 N 个待审批”；另一端先处理时按 approval.resolved 收起并提示由谁处理。R5：父会话里也显示子会话的
// 审批（父会话快照里的副本），标出来自哪个子智能体，并能跳到它的视图。U13：版式与快捷键照 Claude Code 的权限提示。

import { isRpcError, type Transcript, type WevirClient } from '@wevir/client-sdk';
import type {
  ApprovalId,
  ApprovalOption,
  ApprovalRequest,
  ApprovalRuleScope,
  ClientIdentity,
  Session,
  SubagentSummary,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSession, useWorkbenchProviders } from '@/data/workbench-data';
import { Beam } from '@/fx/beam';
import { describe, useCan } from '@/host/host-connection';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { platformApi } from '@/platform/platform';
import {
  type ApprovalLayout,
  type ApprovalScope,
  alwaysAllow,
  approvalLayout,
  approvalScope,
  decidedHere,
  elicitationLink,
  presentApproval,
  resolutionText,
} from './approval-model';
import { Disclosure } from './disclosure';
import { formatJson } from './format';
import { SubagentAvatar } from './subagent-avatar';
import { pendingApprovals, subagentTitle } from './subagent-model';

/** 审批收起后的提示停留多久。 */
const NOTICE_MS = 6000;

interface Notice {
  text: string;
  tone: 'neutral' | 'error';
}

/**
 * 审批区（会话里在消息流末尾，任务窗格里在底部）：一次显示一个未决审批；它被结算后，不是本窗口做的决定就提示一句（“已由本机的 CLI
 * 处理：允许一次”“审批已取消（回合被取消）”）。会话自己的与子会话的审批排在一起，按请求的先后（R5）；子会话的
 * 审批另一端处理后不提示（父会话的事件流里只有摘要，没有结算的详情）。
 */
export function ApprovalDock({
  transcript,
  session,
  client,
  self,
  subagentHref,
  recap,
}: {
  transcript: Transcript;
  /** 审批所在的会话（标题按它的目录与引擎写）；不给时在会话列表里找这个会话或它的父会话。 */
  session?: Session;
  client: WevirClient | undefined;
  self: ClientIdentity | undefined;
  /** 子会话的视图地址；给了才显示“查看子智能体”。 */
  subagentHref?: (subagent: SubagentSummary) => string;
  /** 卡片最上面的“这一轮”回顾（U20，todo-card.tsx 的 TurnRecap）。 */
  recap?: ReactNode;
}) {
  const items = pendingApprovals(transcript);
  const current = items[0]?.approval;
  const origin = items[0]?.subagent;
  const remaining = items.length - 1;
  const [submitting, setSubmitting] = useState<ApprovalId>();
  const [notice, setNotice] = useState<Notice>();
  const shown = useRef<ApprovalId | undefined>(undefined);
  const scope = useApprovalScope(transcript, session);

  // 正在显示的审批不再未决：按结算结果提示（本窗口做的决定不提示）。
  useEffect(() => {
    const previous = shown.current;
    shown.current = current?.id;
    if (!previous || previous === current?.id) return;
    const resolved = transcript.approvals.get(previous);
    if (!resolved?.resolution || decidedHere(resolved.resolution, self)) return;
    setNotice({ text: resolutionText(resolved, resolved.resolution, self), tone: 'neutral' });
  }, [current?.id, transcript.approvals, self]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const respond = async (
    approval: ApprovalRequest,
    optionId: string,
    remember?: ApprovalRuleScope,
  ) => {
    if (!client) return;
    setSubmitting(approval.id);
    setNotice(undefined);
    try {
      await client.request('approval.respond', {
        approvalId: approval.id,
        optionId,
        ...(remember !== undefined && { remember }),
      });
      // 连接器要打开的链接：用户允许了才打开。
      const link = elicitationLink(approval);
      const option = approval.options.find((candidate) => candidate.optionId === optionId);
      if (link !== undefined && option?.category === 'allow') void platformApi().openExternal(link);
    } catch (error) {
      if (isRpcError(error, 'ALREADY_DECIDED') && error.data) {
        // 另一端抢先一步：提示它的决定。
        setNotice({
          text: resolutionText(approval, error.data.resolution, self),
          tone: 'neutral',
        });
      } else {
        setNotice({ text: t('approval.respondFailed', { error: describe(error) }), tone: 'error' });
      }
    } finally {
      setSubmitting(undefined);
    }
  };

  return (
    <>
      {notice && (notice.tone === 'neutral' || !current) && (
        <p
          role="status"
          className={cn(
            'mb-2 rounded-lg px-3 py-2 text-sm',
            notice.tone === 'error'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {notice.text}
        </p>
      )}
      {current && (
        // 金色的内侧呼吸光（U3，border-beam 的 pulse-inner）：等待审批时注意力在这里。
        <Beam preset="approval" className="mb-2 block">
          <ApprovalCard
            key={current.id}
            approval={current}
            scope={scope}
            origin={origin && { subagent: origin, href: subagentHref?.(origin) }}
            remaining={remaining}
            recap={recap}
            busy={submitting === current.id}
            error={notice?.tone === 'error' ? notice.text : undefined}
            onRespond={(optionId, remember) => void respond(current, optionId, remember)}
          />
        </Beam>
      )}
    </>
  );
}

/** 会话的边界：子会话的审批（R5）用父会话的目录与 Provider。 */
function useApprovalScope(
  transcript: Transcript,
  session: Session | undefined,
): ApprovalScope | undefined {
  const ownerId = transcript.parent?.sessionId ?? transcript.sessionId;
  const listed = useSession(session === undefined ? ownerId : undefined);
  const providers = useWorkbenchProviders();
  const owner = session ?? listed;
  return useMemo(
    () => (owner && providers ? approvalScope(owner, providers) : undefined),
    [owner, providers],
  );
}

/**
 * 一个审批（U13 起照 Claude Code 的权限提示）：一句问话做标题，下面是 Agent 给的理由、所需权限（警示色）与放在代码块里的
 * 目标（命令全文或路径），写文件再附内容预览；底部只有两个按钮（U15）：左边“拒绝”（1、Esc），右边“允许”（2、⌘↵，主按钮），
 * 取哪个选项见 approval-model.ts 的 `approvalLayout`。快捷键在焦点在卡片里、或不在任何输入框里时生效；卡片出现时把焦点
 * 拿过来，除非用户正在输入框里打字。
 */
function ApprovalCard({
  approval,
  scope,
  origin,
  remaining,
  recap,
  busy,
  error,
  onRespond,
}: {
  approval: ApprovalRequest;
  scope: ApprovalScope | undefined;
  /** 来自子会话的审批：哪个子智能体，以及它的视图地址。 */
  origin: { subagent: SubagentSummary; href: string | undefined } | undefined;
  remaining: number;
  recap: ReactNode;
  busy: boolean;
  error: string | undefined;
  onRespond: (optionId: string, remember?: ApprovalRuleScope) => void;
}) {
  const presentation = presentApproval(approval, scope);
  const layout = useMemo(() => approvalLayout(approval.options), [approval.options]);
  // “总是允许”加的是审批规则，要 `policy.write`（0.98.0）：远程设备没有时不显示。
  const policyWrite = useCan('policy.write');
  const always = useMemo(
    () => (policyWrite ? alwaysAllow(approval) : undefined),
    [approval, policyWrite],
  );
  const titleId = `approval-${approval.id}`;
  const cardRef = useRef<HTMLElement>(null);
  const respond = useRef(onRespond);
  respond.current = onRespond;

  useEffect(() => {
    const active = document.activeElement;
    const typing =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.value.trim() !== ''
        : isEditable(active);
    if (typing) return;
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  // 捕获阶段：先于输入框的 Esc 停止（它见到 defaultPrevented 就不再处理）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const card = cardRef.current;
      const scope = target?.closest('[data-keyboard-scope]');
      if (scope && scope !== card) return;
      if (!scope && isEditable(target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      // 数字键 3：总是允许，只对这个项目（“所有项目”要从按钮的菜单里选）。
      if (always && event.key === '3' && !hasModifier(event)) {
        event.preventDefault();
        respond.current(always.option.optionId, 'project');
        return;
      }
      const option = shortcutOption(event, layout);
      if (!option) return;
      event.preventDefault();
      respond.current(option.optionId);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, layout, always]);

  const button = (option: ApprovalOption | undefined) => {
    if (option === undefined) return null;
    const primary = option === layout.allow;
    return (
      <Button
        key={option.optionId}
        size="sm"
        variant={primary ? 'default' : 'secondary'}
        disabled={busy}
        data-option-kind={option.kind}
        onClick={() => onRespond(option.optionId)}
        className="h-8 gap-1.5 pr-1.5 pl-3"
      >
        {t(primary ? 'approval.allow' : 'approval.reject')}
        <span className="flex gap-0.5">
          <Kbd primary={primary}>{layout.numbered.indexOf(option) + 1}</Kbd>
          {primary ? <Kbd primary>{IS_MAC ? '⌘↵' : 'Ctrl ↵'}</Kbd> : <Kbd>Esc</Kbd>}
        </span>
      </Button>
    );
  };

  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      data-keyboard-scope
      aria-labelledby={titleId}
      data-testid="approval-card"
      className="rounded-2xl border border-border bg-card shadow-sm outline-none animate-in fade-in slide-in-from-bottom-2 duration-300 ease-smooth"
    >
      {recap}
      {origin && <ApprovalOrigin {...origin} />}
      <div className="px-4 pt-3.5">
        <div className="flex items-start gap-3">
          <h3 id={titleId} className="min-w-0 flex-1 text-base leading-snug font-semibold">
            {presentation.title}
          </h3>
          {remaining > 0 && (
            <span className="shrink-0 rounded-md bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
              {t('approval.more', { count: remaining })}
            </span>
          )}
        </div>
        {presentation.justification && (
          <p className="mt-1.5 text-soft-foreground">{presentation.justification}</p>
        )}
        {presentation.permission && (
          <p className="mt-1.5 text-sm text-warning">
            {t('approval.permission', { permission: presentation.permission })}
          </p>
        )}
        {presentation.target && (
          <pre
            data-approval-target
            className="mt-3 max-h-[min(11rem,22vh)] overflow-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-soft-foreground"
          >
            {presentation.target}
          </pre>
        )}
        {presentation.preview && (
          <div className="mt-2">
            <p className="mb-1 text-xs text-muted-foreground">{t('approval.preview')}</p>
            <pre className="max-h-32 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap text-soft-foreground">
              {presentation.preview.text}
              {presentation.preview.more && `\n${t('approval.previewMore')}`}
            </pre>
          </div>
        )}
        {approval.detail?.input !== undefined && (
          <Disclosure
            className="mt-2 -ml-1"
            summaryClassName="text-xs text-muted-foreground hover:text-foreground"
            summary={t('approval.details', { tool: approval.detail.toolName })}
          >
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">
              {formatJson(approval.detail.input).text}
            </pre>
          </Disclosure>
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
      <footer className="mt-3.5 flex flex-wrap items-center gap-2 px-3 pb-3">
        {button(layout.reject)}
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {always && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={busy}
                data-testid="approval-always"
                className={cn(
                  buttonVariants({ size: 'sm', variant: 'secondary' }),
                  'h-8 min-w-0 gap-1.5 pr-1.5 pl-3',
                )}
              >
                <span className="truncate">
                  {t('approval.alwaysAllow')}{' '}
                  <code className="font-mono text-xs">{always.prefix}</code>
                </span>
                <Kbd>3</Kbd>
                <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-36">
                <DropdownMenuItem
                  closeOnClick
                  onClick={() => onRespond(always.option.optionId, 'project')}
                >
                  {t('approval.scope.project')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  closeOnClick
                  onClick={() => onRespond(always.option.optionId, 'global')}
                >
                  {t('approval.scope.global')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {button(layout.allow)}
        </span>
      </footer>
    </section>
  );
}

/** 按钮里的快捷键提示：一个个小方框（Claude Code）。主按钮上用它的字色。 */
function Kbd({ primary = false, children }: { primary?: boolean; children: ReactNode }) {
  return (
    <kbd
      aria-hidden
      className={cn(
        'flex h-4.5 min-w-4.5 items-center justify-center rounded-sm border px-1 font-sans text-[0.6875rem] leading-none font-normal',
        primary
          ? 'border-primary-foreground/25 text-primary-foreground/80'
          : 'border-border-strong text-muted-foreground',
      )}
    >
      {children}
    </kbd>
  );
}

function hasModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
}

/** 这次按键选哪个选项：数字键、⌘↵（允许）、Esc（拒绝）。 */
function shortcutOption(event: KeyboardEvent, layout: ApprovalLayout): ApprovalOption | undefined {
  const modified = hasModifier(event);
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return layout.allow;
  if (modified) return undefined;
  if (event.key === 'Escape') return layout.reject;
  const digit = Number.parseInt(event.key, 10);
  return digit >= 1 ? layout.numbered[digit - 1] : undefined;
}

function isEditable(element: Element | null | undefined): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/** 审批卡片顶上一行：来自哪个子智能体（Codex 终端界面的“Thread: 〈名字〉”），能跳到它的视图。 */
function ApprovalOrigin({
  subagent,
  href,
}: {
  subagent: SubagentSummary;
  href: string | undefined;
}) {
  const title = subagentTitle(subagent);
  return (
    <div
      data-testid="approval-origin"
      className="flex items-center gap-2 border-b border-border px-3.5 py-1.5 text-xs text-muted-foreground"
    >
      <SubagentAvatar
        sessionId={subagent.sessionId}
        status={subagent.status}
        size={16}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">{t('approval.fromSubagent', { title })}</span>
      {href && (
        <Link
          to={href}
          className="flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
        >
          {t('approval.viewSubagent')}
          <ChevronRight aria-hidden className="size-3.5" />
        </Link>
      )}
    </div>
  );
}
