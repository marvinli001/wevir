// 自动化的 ⋯ 菜单（列表行与详情页共用）：立即运行、编辑、删除（确认）。失败交给 `onError`，页面用横幅显示。

import type { WevirClient } from '@wevir/client-sdk';
import type { Automation } from '@wevir/protocol';
import { Ellipsis, Pencil, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { openAutomationDialog } from './automation-dialog';
import { isRunActive } from './automations-model';

export function runAutomation(
  client: WevirClient,
  automation: Automation,
  onError: (text: string) => void,
): void {
  client
    .request('automation.run', { automationId: automation.id })
    .catch((reason: unknown) => onError(t('automations.runFailed', { error: describe(reason) })));
}

export function AutomationMenu({
  client,
  automation,
  onError,
  onDeleted,
}: {
  client: WevirClient;
  automation: Automation;
  onError: (text: string) => void;
  onDeleted?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton label={t('automations.actions')} data-action="automation-menu">
              <Ellipsis />
            </IconButton>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            disabled={isRunActive(automation.lastRun)}
            onClick={() => runAutomation(client, automation, onError)}
            data-action="run"
          >
            <Play />
            {t('automations.runNow')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => openAutomationDialog({ kind: 'edit', automation })}
            data-action="edit"
          >
            <Pencil />
            {t('automations.edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirming(true)}
            data-action="delete"
          >
            <Trash2 />
            {t('automations.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('automations.delete.title', { name: automation.title })}
        confirmLabel={t('automations.delete')}
        failure={(error) => t('automations.delete.failed', { error })}
        onConfirm={async () => {
          await client.request('automation.delete', { automationId: automation.id });
          onDeleted?.();
        }}
      >
        <p>{t('automations.delete.body')}</p>
      </ConfirmDialog>
    </>
  );
}
