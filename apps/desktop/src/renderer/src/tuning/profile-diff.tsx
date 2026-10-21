// 调优页里两版之间的变化（0.85.0）：按层列出新增、删除、修改的条目；有文本的条目展开看文本 diff（变更窗格的 StyledDiffCodeView，
// 两段文本由 `tuning.blob` 取来，在本地算 diff）。

import { parseDiffFromFile } from '@pierre/diffs';
import type { CodeViewDiffItem } from '@pierre/diffs/react';
import type { WevirClient } from '@wevir/client-sdk';
import type { ProfileItemChange, ProfileLayerDiff } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { resolveDiffThemeName } from '@/changes/diff-rendering';
import { PREFERRED_HIGHLIGHTER } from '@/changes/diff-worker-pool';
import { StyledDiffCodeView } from '@/changes/styled-code-view';
import { Collapse } from '@/components/collapse';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { useTheme } from '@/theme/theme';
import { itemLabel, layerName, scopeName, textHashOf } from './tuning-model';

/** 变化种类前面的记号。 */
const MARKS: Record<ProfileItemChange['change'], string> = {
  added: '+',
  removed: '−',
  modified: '~',
};

export function ProfileDiffList({
  client,
  layers,
}: {
  client: WevirClient;
  layers: readonly ProfileLayerDiff[];
}) {
  const [open, setOpen] = useState<string>();
  if (layers.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('tuning.noChanges')}</p>;
  }
  return (
    <div className="space-y-3" data-testid="tuning-diff">
      {layers.map((layer) => (
        <section key={layer.key}>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">{layerName(layer.key)}</h4>
          <ul className="space-y-px">
            {layer.items.map((item) => {
              const key = `${layer.key}:${item.id}`;
              const before = textHashOf(item.before);
              const after = textHashOf(item.after);
              const viewable = before !== undefined || after !== undefined;
              const expanded = open === key;
              return (
                <li key={key} data-change={item.change}>
                  <button
                    type="button"
                    disabled={!viewable}
                    aria-expanded={viewable ? expanded : undefined}
                    onClick={() => setOpen(expanded ? undefined : key)}
                    className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs outline-none transition-colors duration-150 enabled:hover:bg-muted/50 focus-visible:focus-ring"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'w-3 shrink-0 text-center font-mono',
                        item.change === 'added' && 'text-success',
                        item.change === 'removed' && 'text-destructive',
                        item.change === 'modified' && 'text-warning',
                      )}
                    >
                      {MARKS[item.change]}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {itemLabel(layer.key, item)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{scopeName(item.scope)}</span>
                    {viewable && (
                      <ChevronRight
                        aria-hidden
                        className={cn(
                          'size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-smooth',
                          expanded && 'rotate-90',
                        )}
                      />
                    )}
                  </button>
                  {viewable && (
                    <Collapse open={expanded}>
                      {expanded && (
                        <TextDiff
                          client={client}
                          name={item.label}
                          {...(before !== undefined && { before })}
                          {...(after !== undefined && { after })}
                        />
                      )}
                    </Collapse>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 两段文本的 diff；一边没有（新增或删除）时那边当作空文本。 */
function TextDiff({
  client,
  name,
  before,
  after,
}: {
  client: WevirClient;
  name: string;
  before?: string;
  after?: string;
}) {
  const { resolved: theme } = useTheme();
  const [texts, setTexts] = useState<{ before: string; after: string } | { error: string }>();
  useEffect(() => {
    let alive = true;
    const read = (hash: string | undefined) =>
      hash === undefined
        ? Promise.resolve('')
        : client.request('tuning.blob', { hash }).then((result) => result.text ?? '');
    Promise.all([read(before), read(after)]).then(
      ([a, b]) => alive && setTexts({ before: a, after: b }),
      (reason: unknown) => alive && setTexts({ error: describe(reason) }),
    );
    return () => {
      alive = false;
    };
  }, [client, before, after]);
  const items = useMemo<CodeViewDiffItem<undefined>[]>(() => {
    if (texts === undefined || 'error' in texts) return [];
    const key = `${before ?? ''}:${after ?? ''}`;
    return [
      {
        id: key,
        type: 'diff',
        fileDiff: parseDiffFromFile(
          { name, contents: texts.before, cacheKey: `tuning:${before ?? 'none'}` },
          { name, contents: texts.after, cacheKey: `tuning:${after ?? 'none'}` },
        ),
        collapsed: false,
      },
    ];
  }, [texts, name, before, after]);
  if (texts === undefined) {
    return <p className="px-1.5 py-2 text-xs text-muted-foreground">{t('common.loading')}</p>;
  }
  if ('error' in texts) {
    return <p className="px-1.5 py-2 text-xs text-destructive">{texts.error}</p>;
  }
  return (
    <div
      className="my-1 h-72 overflow-hidden rounded-md border border-border"
      data-testid="tuning-text-diff"
    >
      <StyledDiffCodeView
        className="h-full min-h-0 overflow-auto"
        items={items}
        options={{
          diffStyle: 'unified',
          lineDiffType: 'none',
          overflow: 'wrap',
          theme: resolveDiffThemeName(theme),
          themeType: theme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          hunkSeparators: 'line-info',
        }}
      />
    </div>
  );
}
