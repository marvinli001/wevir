// “变更”窗格工具组里的“跳转到文件”（照 Codex）：弹出一个搜索框与这段 diff 里的文件，按文件名与目录筛选；↑↓ 选、回车
// 跳过去，点一项也一样。

import { cn } from 'cn';
import { FileSearch, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { ScrollFade } from '@/components/scroll-fade';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { fileIcon } from '@/layout/panes/files-pane';
import { splitPath } from './changes-model';

export function JumpToFile({
  paths,
  onJump,
}: {
  paths: readonly string[];
  onJump: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...paths].sort((a, b) => splitPath(a).name.localeCompare(splitPath(b).name));
    return needle === '' ? sorted : sorted.filter((path) => path.toLowerCase().includes(needle));
  }, [paths, query]);
  const current = Math.min(active, Math.max(matches.length - 1, 0));

  const jump = (path: string | undefined) => {
    if (path === undefined) return;
    setOpen(false);
    onJump(path);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActive(0);
        }
      }}
    >
      <PopoverTrigger
        render={
          <IconButton
            label={t('changes.jumpToFile')}
            size="icon-xs"
            className="rounded-full"
            disabled={paths.length === 0}
            data-action="changes-jump"
          >
            <FileSearch />
          </IconButton>
        }
      />
      <PopoverContent align="end" className="w-80 gap-0 overflow-hidden p-0" data-changes-jump>
        <div className="flex h-10 items-center gap-2 border-b border-border px-3">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            // biome-ignore lint/a11y/noAutofocus: 弹出层打开就是为了输入。
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setActive((current + step + matches.length) % Math.max(matches.length, 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                jump(matches[current]);
              }
            }}
            placeholder={t('changes.jumpToFile')}
            aria-label={t('changes.jumpToFile')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {matches.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('files.noMatches')}
          </p>
        ) : (
          <ScrollFade className="max-h-72 overflow-y-auto p-1.5 [--scroll-fade-size:16px]">
            <ul className="flex flex-col">
              {matches.map((path, index) => {
                const { name, dir } = splitPath(path);
                const Icon = fileIcon(path);
                return (
                  <li key={path}>
                    <button
                      type="button"
                      onClick={() => jump(path)}
                      onMouseMove={() => setActive(index)}
                      data-active={index === current || undefined}
                      title={path}
                      className={cn(
                        'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm outline-none',
                        index === current && 'bg-accent',
                      )}
                    >
                      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="shrink-0">{name}</span>
                      {dir !== '' && (
                        <span
                          dir="rtl"
                          className="min-w-0 truncate text-left text-xs text-muted-foreground"
                        >
                          <bdi dir="ltr">{dir}</bdi>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollFade>
        )}
      </PopoverContent>
    </Popover>
  );
}
