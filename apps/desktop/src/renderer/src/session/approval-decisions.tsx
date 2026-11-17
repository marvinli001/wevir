import type { ApprovalOption } from '@wevir/protocol';
import { Ellipsis } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { type ApprovalLayout, optionLabel } from './approval-model';

export function OtherApprovalDecisions({
  layout,
  busy,
  onChoose,
}: {
  layout: ApprovalLayout;
  busy: boolean;
  onChoose: (option: ApprovalOption) => void;
}) {
  if (!layout.alternatives.length) return null;
  const label = (option: ApprovalOption) =>
    option.kind === 'reject_decline' && layout.reject?.kind === 'reject_cancel'
      ? t('approval.declineContinue')
      : optionLabel(option);
  if (!layout.numbered.length) {
    return layout.alternatives.map((option) => (
      <Button
        key={option.optionId}
        size="sm"
        variant="outline"
        disabled={busy}
        data-option-kind={option.kind}
        onClick={() => onChoose(option)}
        className="h-auto min-h-8 whitespace-normal break-all"
      >
        {label(option)}
      </Button>
    ));
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        aria-label={t('approval.otherDecisions')}
        className={buttonVariants({ size: 'icon-sm', variant: 'ghost' })}
      >
        <Ellipsis aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-max max-w-[min(22rem,90vw)]">
        {layout.alternatives.map((option) => (
          <DropdownMenuItem
            key={option.optionId}
            closeOnClick
            data-option-kind={option.kind}
            className="break-all"
            onClick={() => onChoose(option)}
          >
            {label(option)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
