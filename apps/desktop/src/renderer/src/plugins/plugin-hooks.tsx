import type { PluginHookSummary } from '@wevir/protocol';
import { ShieldAlert } from 'lucide-react';
import { t } from '@/i18n';

export function PluginHooks({ hooks }: { hooks: readonly PluginHookSummary[] }) {
  if (hooks.length === 0) return null;
  return (
    <section className="min-w-0 space-y-2" data-testid="plugin-hooks">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert aria-hidden className="size-4 shrink-0 text-warning" />
        {t('plugins.hooks.title')}
      </h3>
      <ul className="max-h-60 divide-y divide-border overflow-auto rounded-lg border border-border px-3">
        {hooks.map((hook, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 预览是不可变快照，条目位置就是钩子的身份。
          <li key={`${hook.event}:${index}`} className="space-y-1 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono break-all text-soft-foreground">
              <span>{hook.event}</span>
              {hook.matcher !== undefined && <span>{hook.matcher}</span>}
              <span>{hook.handler}</span>
              {hook.handler !== 'command' && (
                <span className="font-sans text-warning">{t('plugins.hooks.unsupported')}</span>
              )}
            </div>
            {hook.command !== undefined && (
              <pre className="font-mono break-words whitespace-pre-wrap">{hook.command}</pre>
            )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-warning">{t('plugins.hooks.trust')}</p>
    </section>
  );
}
