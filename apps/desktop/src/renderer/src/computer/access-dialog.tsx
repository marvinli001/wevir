// 电脑操作的授权框（0.112.0）：agent 调 computer_request_access 时弹出，列出要操作的应用、各自的档位（由应用的种类定，
// 这里改不了）与 agent 写的用途，用户逐个勾选后允许，或全部拒绝。关掉框等于拒绝。

import type { ComputerAccessTier } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { t } from '@/i18n';
import type { ComputerAccessPreparation } from '../../../shared/desktop-api';

const TIER_LABEL = {
  read: 'computer.tier.read',
  click: 'computer.tier.click',
  full: 'computer.tier.full',
} as const satisfies Record<ComputerAccessTier, string>;

export function AccessDialog({
  preparation,
  sessionTitle,
  onDone,
}: {
  preparation: ComputerAccessPreparation;
  sessionTitle: string | undefined;
  onDone: (bundleIds: string[]) => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(preparation.candidates.map((candidate) => candidate.bundleId)),
  );
  const [icons, setIcons] = useState<Record<string, string>>({});

  useEffect(() => {
    let stopped = false;
    for (const candidate of preparation.candidates) {
      if (candidate.path === '') continue;
      void window.wevir?.computer
        .appIcon(candidate.path)
        .then((icon) => {
          if (!stopped && icon) setIcons((current) => ({ ...current, [candidate.bundleId]: icon }));
        })
        .catch(() => undefined);
    }
    return () => {
      stopped = true;
    };
  }, [preparation]);

  const toggle = (bundleId: string, checked: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(bundleId);
      else next.delete(bundleId);
      return next;
    });

  const separator = t('common.listSeparator');
  return (
    <Dialog open onOpenChange={(open) => !open && onDone([])}>
      <DialogContent className="sm:max-w-md" showCloseButton={false} data-dialog="computer-access">
        <DialogHeader>
          <DialogTitle>{t('computer.access.title')}</DialogTitle>
          <DialogDescription render={<div />} className="space-y-1.5 leading-relaxed">
            {sessionTitle && <p>{t('computer.access.session', { title: sessionTitle })}</p>}
            <p className="break-words">
              {t('computer.access.reason', { reason: preparation.reason })}
            </p>
            <p>{t('computer.access.body')}</p>
          </DialogDescription>
        </DialogHeader>
        {preparation.candidates.length > 0 && (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {preparation.candidates.map((candidate) => (
              <li key={candidate.bundleId}>
                <label
                  className="flex items-center gap-3 px-3 py-2.5"
                  data-app={candidate.bundleId}
                >
                  <Checkbox
                    checked={chosen.has(candidate.bundleId)}
                    onCheckedChange={(checked) => toggle(candidate.bundleId, checked === true)}
                  />
                  {icons[candidate.bundleId] ? (
                    <img src={icons[candidate.bundleId]} alt="" className="size-6 shrink-0" />
                  ) : (
                    <span aria-hidden className="size-6 shrink-0 rounded-md bg-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {candidate.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {candidate.granted
                      ? t('computer.access.granted')
                      : t(TIER_LABEL[candidate.tier])}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {preparation.notFound.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('computer.access.notFound', { apps: preparation.notFound.join(separator) })}
          </p>
        )}
        {preparation.refused.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('computer.access.refused', { apps: preparation.refused.join(separator) })}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone([])} data-action="deny">
            {t('computer.access.deny')}
          </Button>
          <Button
            onClick={() => onDone([...chosen])}
            disabled={chosen.size === 0}
            data-action="allow"
          >
            {t('computer.access.allow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
