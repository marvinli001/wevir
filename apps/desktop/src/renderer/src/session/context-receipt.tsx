import type { ContextPackReceipt, ContextSourceRef } from '@wevir/protocol';
import { Layers } from 'lucide-react';
import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { t } from '@/i18n';

function sourceLabel(source: ContextSourceRef): string {
  switch (source.kind) {
    case 'memory':
      return `${source.scope}/${source.name} · ${source.revision}`;
    case 'episode':
      return `${source.id} · ${source.revision} · e${source.throughSeq}`;
    case 'constraint':
      return `${source.index + 1}`;
    case 'history':
      return `${source.sessionId} · ${source.itemId}`;
  }
}

export function ContextReceipt({
  receipt,
  inline = false,
}: {
  receipt: ContextPackReceipt;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = t('context.receipt.counts', {
    notes: receipt.included.filter((source) => source.kind === 'memory').length,
    episodes: receipt.included.filter((source) => source.kind === 'episode').length,
    bytes: receipt.bytes,
  });
  return (
    <div className={inline ? 'inline-flex' : 'my-0.5 flex justify-center'}>
      <button
        type="button"
        className="outline-none focus-visible:focus-ring flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
        onClick={() => setOpen(true)}
        data-testid="context-receipt"
      >
        <Layers aria-hidden className="size-3.5" />
        {receipt.legacy ? t('context.receipt.legacy') : label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-xl">
          <DialogHeader className="pe-8">
            <DialogTitle>{t('context.receipt.title')}</DialogTitle>
            <DialogDescription>
              {label} ·{' '}
              {t(
                receipt.engineSession === 'new' ? 'context.receipt.new' : 'context.receipt.frozen',
              )}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea fade className="-mx-1 rounded-md">
            <dl className="grid gap-3 py-1 ps-1 pe-4 text-sm">
              <div>
                <dt className="mb-1 text-muted-foreground">{t('context.receipt.hash')}</dt>
                <dd className="break-all font-mono text-xs">{receipt.hash}</dd>
              </div>
              {(['included', 'omitted'] as const).map((key) => (
                <div key={key}>
                  <dt className="mb-1 text-muted-foreground">
                    {t(key === 'included' ? 'context.receipt.included' : 'context.receipt.omitted')}{' '}
                    · {receipt[key].length}
                  </dt>
                  <dd className="space-y-1 break-all font-mono text-xs">
                    {receipt[key].map((source) => (
                      <p key={sourceLabel(source)}>{sourceLabel(source)}</p>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
