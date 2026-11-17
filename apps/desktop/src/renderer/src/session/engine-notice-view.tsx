import type { EngineNotice } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, Info, Shield, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { type PlainMessageKey, t } from '@/i18n';
import { useFold } from './fold-state';
import { useMessageActions } from './message-actions';

type ApprovalReview = Extract<EngineNotice, { kind: 'approval_review' }>;

const riskLabels: Record<string, PlainMessageKey | undefined> = {
  low: 'engineNotice.risk.low',
  medium: 'engineNotice.risk.medium',
  high: 'engineNotice.risk.high',
  critical: 'engineNotice.risk.critical',
};

export function EngineNoticeView({ detail }: { detail: EngineNotice }) {
  if (detail.kind === 'approval_review') {
    return <ApprovalReviewView key={detail.reviewId} review={detail} />;
  }
  if (detail.kind === 'output_buffering' && !detail.active) return null;
  const Icon = detail.kind === 'output_buffering' ? Info : TriangleAlert;
  return (
    <div
      data-engine-notice={detail.kind}
      className="my-1 flex min-w-0 items-start gap-2 text-sm text-muted-foreground"
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          detail.kind !== 'output_buffering' && 'text-warning',
        )}
      />
      <div className="min-w-0 break-words">
        {detail.kind === 'warning' ? (
          <p className="whitespace-pre-wrap">{detail.message}</p>
        ) : detail.kind === 'mcp_failed' ? (
          <>
            <p>{t('engineNotice.mcpFailed', { server: detail.server })}</p>
            {detail.message && (
              <p className="mt-0.5 whitespace-pre-wrap text-xs">{detail.message}</p>
            )}
          </>
        ) : (
          <p role="status">
            {t('engineNotice.buffering')}
            {detail.model && <span className="ml-2 text-xs">{detail.model}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

function ApprovalReviewView({ review }: { review: ApprovalReview }) {
  const { authorizeDenied } = useMessageActions();
  const [confirm, setConfirm] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const status = authorized && review.status === 'denied' ? 'userApproved' : review.status;
  const denied = status === 'denied';
  const [open, setOpen] = useFold(`approval-review:${review.reviewId}`, denied);
  const detailsId = useId();
  const risk =
    review.riskLevel && Object.hasOwn(riskLabels, review.riskLevel)
      ? riskLabels[review.riskLevel]
      : undefined;
  const Icon = denied
    ? ShieldX
    : status === 'approved' || status === 'userApproved'
      ? ShieldCheck
      : Shield;
  const action = (
    <pre className="max-h-48 overflow-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap break-all text-soft-foreground">
      {review.action}
    </pre>
  );

  return (
    <div className="my-1" data-approval-review={status}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(!open)}
        className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded-lg text-left text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
      >
        <Icon aria-hidden className={cn('size-4 shrink-0', denied && 'text-warning')} />
        <span className="shrink-0" aria-live="polite">
          {t(`engineNotice.review.${status}`)}
        </span>
        {!open && <span className="min-w-0 truncate font-mono text-xs">{review.action}</span>}
        <ChevronRight
          aria-hidden
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>
      <Collapse id={detailsId} open={open}>
        <div className="ml-6 grid gap-1.5 pt-1 pb-2">
          {action}
          {(review.riskLevel || review.rationale) && (
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-soft-foreground">
              {review.riskLevel && (
                <strong className="mr-2 font-medium">{risk ? t(risk) : review.riskLevel}</strong>
              )}
              {review.rationale}
            </p>
          )}
          {denied && authorizeDenied && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="justify-self-start"
              onClick={() => setConfirm(true)}
            >
              {t('engineNotice.authorize')}
            </Button>
          )}
        </div>
      </Collapse>
      {confirm && denied && authorizeDenied && (
        <ConfirmDialog
          open
          onOpenChange={setConfirm}
          title={t('engineNotice.authorize')}
          confirmLabel={t('engineNotice.authorize')}
          failure={(error) => t('approval.respondFailed', { error })}
          onConfirm={async () => {
            await authorizeDenied(review.reviewId);
            setAuthorized(true);
          }}
        >
          {action}
          {review.rationale && (
            <p className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words">
              {review.rationale}
            </p>
          )}
          <p>{t('engineNotice.retryEffect')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
