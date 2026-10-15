import { cn } from 'cn';
import {
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderCog,
  Laptop,
  Layers,
  Settings,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { environmentSummary, useActiveEnvironment } from '@/environments/environments';
import { t } from '@/i18n';
import { ProjectMenuContent, StartTruncated } from '@/projects/project-menu';
import { paths } from '@/routes/paths';

/** “已复制”停留多久。 */
const COPIED_MS = 1500;

const ITEM =
  'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs text-soft-foreground [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

/**
 * 新会话输入框上方的环境栏（U12，照 Codex 桌面端）：在哪个项目里（点开换项目或创建项目）、在哪里运行（此计算机），右边的
 * 齿轮是本地环境的设置。首页与新会话草稿页用，作为 `Composer` 的 `tray`。
 */
export function EnvironmentBar({
  current,
  workspaces,
  onSelect,
}: {
  current: WorkspaceEntry | undefined;
  workspaces: readonly WorkspaceEntry[];
  onSelect: (workspaceId: string) => void;
}) {
  const workspace = current?.workspace;
  // 新会话页选中的环境（U22.1）。
  const environment = useActiveEnvironment(workspace?.id);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="environment-project"
          title={workspace?.rootPath}
          className={cn(
            ITEM,
            'max-w-60 outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground',
          )}
        >
          <Folder aria-hidden />
          <span className={cn('truncate', !workspace && 'text-muted-foreground')}>
            {workspace?.displayName ?? t('home.chooseProject')}
          </span>
        </DropdownMenuTrigger>
        <ProjectMenuContent
          currentId={workspace?.id}
          workspaces={workspaces}
          onSelect={onSelect}
          side="top"
          sideOffset={6}
        />
      </DropdownMenu>
      {environment && (
        <span
          className={ITEM}
          data-testid="environment-name"
          title={environmentSummary(environment)}
        >
          <Layers aria-hidden />
          <span className="truncate">{environment.name}</span>
        </span>
      )}
      <span className={ITEM} data-testid="environment-location">
        <Laptop aria-hidden />
        {t('environment.local')}
      </span>
      <span className="flex-1" />
      <EnvironmentSettings rootPath={workspace?.rootPath} />
    </>
  );
}

/** 齿轮点开的“本地环境”：工作目录（点一下复制路径）与项目设置。 */
function EnvironmentSettings({ rootPath }: { rootPath: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (rootPath) void window.wevir.copyText(rootPath).then(() => setCopied(true));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            label={t('environment.settings')}
            size="icon-xs"
            className="text-muted-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
            data-testid="environment-settings"
          >
            <Settings />
          </IconButton>
        }
      />
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-80 gap-0.5 p-1.5"
        data-testid="environment-popover"
      >
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
          {t('environment.settings')}
        </p>
        <Row icon={<Laptop />} label={t('environment.location')}>
          <span className="text-muted-foreground">{t('environment.local')}</span>
        </Row>
        <Row
          icon={<Folder />}
          label={t('environment.directory')}
          disabled={!rootPath}
          onClick={copy}
          title={rootPath && t('environment.copyPath')}
        >
          {rootPath ? (
            <StartTruncated text={rootPath} className="max-w-40 text-muted-foreground" />
          ) : (
            <span className="text-muted-foreground">{t('environment.noDirectory')}</span>
          )}
          {rootPath &&
            (copied ? (
              <Check aria-label={t('environment.copied')} className="text-success" />
            ) : (
              <Copy aria-hidden />
            ))}
        </Row>
        <div className="mx-2 my-1 h-px bg-border" />
        <Row
          icon={<FolderCog />}
          label={t('environment.projectSettings')}
          onClick={() => {
            setOpen(false);
            navigate(paths.settings('workspaces'), { state: { from: location } });
          }}
        >
          <ChevronRight aria-hidden />
        </Row>
      </PopoverContent>
    </Popover>
  );
}

/** 弹层里的一行：左边图标与名称，右边是值或箭头；给了 `onClick` 才是按钮。 */
function Row({
  icon,
  label,
  children,
  onClick,
  disabled,
  title,
}: {
  icon: ReactNode;
  label: string;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  const content = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">
        {icon}
      </span>
      <span className="shrink-0">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        {children}
      </span>
    </>
  );
  const className = 'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm';
  if (!onClick) return <div className={className}>{content}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        className,
        'outline-none transition-colors duration-150 enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60',
      )}
    >
      {content}
    </button>
  );
}
