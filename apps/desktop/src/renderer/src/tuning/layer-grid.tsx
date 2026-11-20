// 配置层的卡片网格与每层的对话框：卡片写图标、层名与摘要，点开是这一层的条目（打开文件、管理入口）。护栏层的对话框在
// guardrails-layer.tsx，共用这里的 LayerDialogFrame。

import type { ProfileLayer, ProfileLayerKey } from '@wevir/protocol';
import {
  Brain,
  ChevronRight,
  ExternalLink,
  FileText,
  Layers,
  type LucideIcon,
  MessageSquareText,
  Plug,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  UsersRound,
  XIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { paths } from '@/routes/paths';
import { canOpenExternally } from '../../../shared/open-path.js';
import {
  isKnownLayer,
  itemDetail,
  itemLabel,
  layerManage,
  layerName,
  layerScopes,
  layerSummary,
  scopeName,
} from './tuning-model';

const LAYER_ICONS: Record<ProfileLayerKey, LucideIcon> = {
  system: SquareTerminal,
  rules: FileText,
  instructions: MessageSquareText,
  memory: Brain,
  skills: Sparkles,
  roles: UsersRound,
  guardrails: ShieldCheck,
  connectors: Plug,
};

function LayerIcon({ layerKey }: { layerKey: string }) {
  const Icon = isKnownLayer(layerKey) ? LAYER_ICONS[layerKey] : Layers;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-foreground">
      <Icon aria-hidden className="size-4.5" />
    </span>
  );
}

export function LayerGrid({
  layers,
  onOpen,
}: {
  layers: readonly ProfileLayer[];
  onOpen: (key: string) => void;
}) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2" data-testid="tuning-profile">
      {layers.map((layer) => (
        <li key={layer.key}>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => onOpen(layer.key)}
            data-layer={layer.key}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:focus-field"
          >
            <LayerIcon layerKey={layer.key} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{layerName(layer.key)}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground tabular-nums">
                {layerSummary(layer)}
              </span>
            </span>
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 一层的对话框外框：图标、层名与摘要，右边一个操作，下面可滚动的内容。 */
export function LayerDialogFrame({
  layer,
  action,
  onClose,
  children,
}: {
  layer: ProfileLayer;
  action?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const scopes = layerScopes(layer);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-xl"
        data-testid="tuning-layer"
        data-layer={layer.key}
      >
        <div className="flex items-center gap-3 border-b border-border p-4 pr-3">
          <LayerIcon layerKey={layer.key} />
          <div className="min-w-0 flex-1">
            <DialogTitle>{layerName(layer.key)}</DialogTitle>
            <DialogDescription className="mt-1 truncate text-xs">
              {[layerSummary(layer), scopes].filter((part) => part !== '').join(' · ')}
            </DialogDescription>
          </div>
          {action}
          <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
            <XIcon />
            <span className="sr-only">{t('common.close')}</span>
          </DialogClose>
        </div>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/** 普通层的对话框：条目列表，有管理入口的层右上角是“管理”。 */
export function LayerDialog({ layer, onClose }: { layer: ProfileLayer; onClose: () => void }) {
  const location = useLocation();
  const manage = layerManage(layer.key);
  return (
    <LayerDialogFrame
      layer={layer}
      onClose={onClose}
      action={
        manage !== undefined && (
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                to={
                  manage.kind === 'settings'
                    ? paths.settings(manage.tab)
                    : paths.plugins(manage.tab)
                }
                state={{ from: location }}
              />
            }
            data-action="manage"
          >
            {t('tuning.manage')}
          </Button>
        )
      }
    >
      {layer.items.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('tuning.noItems')}</p>
      ) : (
        <ul className="-mx-2 space-y-px" data-testid="tuning-items">
          {layer.items.map((item) => {
            const detail = itemDetail(layer.key, item);
            const path = item.path;
            return (
              <li
                key={item.id}
                className="flex h-8 min-w-0 items-center gap-3 rounded-md px-2 text-xs transition-colors duration-150 hover:bg-muted/50"
                title={path ?? item.id}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {itemLabel(layer.key, item)}
                </span>
                {detail !== undefined && (
                  <span className="max-w-48 shrink truncate text-muted-foreground">{detail}</span>
                )}
                <span className="shrink-0 text-muted-foreground">{scopeName(item.scope)}</span>
                {path !== undefined && capabilities().localFiles && (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="-mr-1 shrink-0"
                    aria-label={t('tuning.open')}
                    title={t('tuning.open')}
                    data-action="open"
                    onClick={() => {
                      const open = canOpenExternally(path)
                        ? platformApi().openPath(path)
                        : platformApi().revealPath(path);
                      void open.catch(() => undefined);
                    }}
                  >
                    <ExternalLink aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </LayerDialogFrame>
  );
}
