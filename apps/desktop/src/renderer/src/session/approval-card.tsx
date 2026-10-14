// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/react-app/domains/session/chat/permission-approval-modal.tsx
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改写（T5.3，OpenWork 候选 #9）。保留“输入框上方的内联面板、不用模态框”“一次只显示第一个”“可折叠的
// 完整参数”。按钮不再是固定的 reject / once / always，而是按审批请求携带的选项渲染（approval-model.ts）；
// 内容取同一 toolCallId 的 rawInput（Host 放在 ApprovalRequest.detail：目标、所需权限、理由、写文件的内容
// 预览）；标出“还有 N 个待审批”；另一端先处理时按 approval.resolved 收起并提示由谁处理。R5：父会话里也显示子会话的
// 审批（父会话快照里的副本），标出来自哪个子智能体，并能跳到它的视图。

import { isRpcError, type Transcript, type WevirClient } from '@wevir/client-sdk';
import type { ApprovalId, ApprovalRequest, ClientIdentity, SubagentSummary } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { decidedHere, optionLabel, presentApproval, resolutionText } from './approval-model';
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
 * 输入框上方的审批区：一次显示一个未决审批；它被结算后，不是本窗口做的决定就提示一句（“已由本机的 CLI
 * 处理：允许一次”“审批已取消（回合被取消）”）。会话自己的与子会话的审批排在一起，按请求的先后（R5）；子会话的
 * 审批另一端处理后不提示（父会话的事件流里只有摘要，没有结算的详情）。
 */
export function ApprovalDock({
  transcript,
  client,
  self,
  subagentHref,
}: {
  transcript: Transcript;
  client: WevirClient | undefined;
  self: ClientIdentity | undefined;
  /** 子会话的视图地址；给了才显示“查看子智能体”。 */
  subagentHref?: (subagent: SubagentSummary) => string;
}) {
  const items = pendingApprovals(transcript);
  const current = items[0]?.approval;
  const origin = items[0]?.subagent;
  const remaining = items.length - 1;
  const [submitting, setSubmitting] = useState<ApprovalId>();
  const [notice, setNotice] = useState<Notice>();
  const shown = useRef<ApprovalId | undefined>(undefined);

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

  const respond = async (approval: ApprovalRequest, optionId: string) => {
    if (!client) return;
    setSubmitting(approval.id);
    setNotice(undefined);
    try {
      await client.request('approval.respond', { approvalId: approval.id, optionId });
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
        <ApprovalCard
          key={current.id}
          approval={current}
          origin={origin && { subagent: origin, href: subagentHref?.(origin) }}
          remaining={remaining}
          busy={submitting === current.id}
          error={notice?.tone === 'error' ? notice.text : undefined}
          onRespond={(optionId) => void respond(current, optionId)}
        />
      )}
    </>
  );
}

function ApprovalCard({
  approval,
  origin,
  remaining,
  busy,
  error,
  onRespond,
}: {
  approval: ApprovalRequest;
  /** 来自子会话的审批：哪个子智能体，以及它的视图地址。 */
  origin: { subagent: SubagentSummary; href: string | undefined } | undefined;
  remaining: number;
  busy: boolean;
  error: string | undefined;
  onRespond: (optionId: string) => void;
}) {
  const presentation = presentApproval(approval);
  const titleId = `approval-${approval.id}`;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="approval-card"
      className="mb-2 rounded-xl border border-warning/40 bg-card shadow-sm"
    >
      {origin && <ApprovalOrigin {...origin} />}
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-medium">
            {presentation.title}
          </h3>
          {approval.detail && (
            <p className="text-xs text-muted-foreground">{approval.detail.toolName}</p>
          )}
        </div>
        {remaining > 0 && (
          <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
            {t('approval.more', { count: remaining })}
          </span>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3.5 pl-10 text-sm">
        {presentation.target && (
          <Row label={t('approval.target')}>
            <span className="font-mono text-xs break-all">{presentation.target}</span>
          </Row>
        )}
        {presentation.permission && (
          <Row label={t('approval.permission')}>{presentation.permission}</Row>
        )}
        {presentation.justification && (
          <Row label={t('approval.justification')}>{presentation.justification}</Row>
        )}
      </dl>

      {presentation.preview && (
        <div className="mt-2 px-3.5 pl-10">
          <p className="mb-1 text-xs text-muted-foreground">{t('approval.preview')}</p>
          <pre className="max-h-32 overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">
            {presentation.preview.text}
            {presentation.preview.more && `\n${t('approval.previewMore')}`}
          </pre>
        </div>
      )}

      {approval.detail?.input !== undefined && (
        <Disclosure
          className="mt-2 px-3.5 pl-9"
          summaryClassName="text-xs text-muted-foreground hover:text-foreground"
          summary={t('approval.details')}
        >
          <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-words">
            {formatJson(approval.detail.input).text}
          </pre>
        </Disclosure>
      )}

      {error && <p className="mt-2 px-3.5 pl-10 text-sm text-destructive">{error}</p>}

      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border px-3.5 py-2.5">
        {approval.options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={option.category === 'allow' ? 'default' : 'outline'}
            disabled={busy}
            onClick={() => onRespond(option.optionId)}
          >
            {optionLabel(option)}
          </Button>
        ))}
      </div>
    </section>
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
      <SubagentAvatar sessionId={subagent.sessionId} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">{t('approval.fromSubagent', { title })}</span>
      {href && (
        <Link
          to={href}
          className="flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {t('approval.viewSubagent')}
          <ChevronRight aria-hidden className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
