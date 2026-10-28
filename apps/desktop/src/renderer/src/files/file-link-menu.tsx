// 消息里文件链接的右键菜单（照 Claude 桌面端）：添加到对话 | 复制 ▸（完整路径、相对路径、名称） | 打开方式 ▸（外部编辑器、默认
// 应用）、在访达中显示。弹层与菜单项同左栏的右键菜单（Base UI 的 Menu，紧凑菜单的行高），从右键的位置长出来。会话视图提供
// `FileLinkMenuProvider`，markdown-view.tsx 在 `a[data-file-link]` 上右键时经 `ShowFileLinkMenu` 打开；页面拦下右键，主进程的
// 系统菜单（main/context-menu.ts）不再弹。路径不在这台电脑上时（连着别的电脑上的 Host）只有添加到对话与复制。

import { AtSign, Copy, FolderOpen, SquareArrowOutUpRight } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useMemo, useState } from 'react';
import { COMPACT_ICON, COMPACT_ITEM } from '@/components/compact-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import { capabilities, platformApi } from '@/platform/platform';
import { type FileLinkPaths, fileLinkPaths } from './file-path';
import { openInEditor, useEditors } from './files-store';

/** 在 (x, y)（视口坐标，右键的位置）为文件链接 `href` 打开菜单；没有提供时右键照常交给系统菜单。 */
export const ShowFileLinkMenu = createContext<
  ((href: string, x: number, y: number) => void) | undefined
>(undefined);

interface MenuState {
  paths: FileLinkPaths;
  x: number;
  y: number;
}

/** 子菜单比一级菜单窄一点（同左栏）。 */
const SUB_CONTENT = 'min-w-40';

function copy(text: string): void {
  void platformApi()
    .copyText(text)
    .catch(() => undefined);
}

/**
 * 给里面的消息提供文件链接的右键菜单。`cwd` 是会话目录（相对路径按它解析）；`attach` 把路径作为 @ 提及放进这个会话的输入框，
 * 只读的会话不给。
 */
export function FileLinkMenuProvider({
  cwd,
  attach,
  children,
}: {
  cwd: string;
  attach?: ((path: string) => void) | undefined;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<MenuState>();
  const [open, setOpen] = useState(false);
  const show = useCallback(
    (href: string, x: number, y: number) => {
      const paths = fileLinkPaths(href, cwd);
      if (!paths) return;
      setMenu({ paths, x, y });
      setOpen(true);
    },
    [cwd],
  );
  return (
    <ShowFileLinkMenu value={show}>
      {children}
      {menu && (
        <FileLinkMenu
          state={menu}
          open={open}
          onClose={() => setOpen(false)}
          {...(attach && { attach })}
        />
      )}
    </ShowFileLinkMenu>
  );
}

function FileLinkMenu({
  state,
  open,
  onClose,
  attach,
}: {
  state: MenuState;
  open: boolean;
  onClose: () => void;
  attach?: (path: string) => void;
}) {
  const { paths, x, y } = state;
  const anchor = useMemo(
    () => ({ getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) }),
    [x, y],
  );
  // 本机的文件才能用编辑器、默认应用打开与在访达中显示。
  const local = capabilities().localFiles ? paths.absolute : undefined;
  const target = paths.absolute ?? paths.relative ?? paths.name;
  return (
    <DropdownMenu open={open} onOpenChange={(next) => !next && onClose()}>
      <DropdownMenuContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={2}
        className="w-auto min-w-48"
        data-file-link-menu=""
      >
        {attach && (
          <>
            <DropdownMenuItem
              className={COMPACT_ITEM}
              onClick={() => attach(target)}
              data-menu-item="attach"
            >
              <AtSign className={COMPACT_ICON} />
              {t('selection.addToChat')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={COMPACT_ITEM} data-menu-item="copy">
            <Copy className={COMPACT_ICON} />
            {t('session.copy')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={SUB_CONTENT}>
            <DropdownMenuItem
              className={COMPACT_ITEM}
              onClick={() => copy(target)}
              data-menu-item="copy-path"
            >
              {t('fileLink.fullPath')}
            </DropdownMenuItem>
            {paths.relative !== undefined && paths.relative !== target && (
              <DropdownMenuItem
                className={COMPACT_ITEM}
                onClick={() => copy(paths.relative ?? '')}
                data-menu-item="copy-relative"
              >
                {t('fileLink.relativePath')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className={COMPACT_ITEM}
              onClick={() => copy(paths.name)}
              data-menu-item="copy-name"
            >
              {t('fileLink.name')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {local !== undefined && (
          <>
            <OpenWithSub path={local} line={paths.line} />
            <DropdownMenuItem
              className={COMPACT_ITEM}
              onClick={() =>
                void platformApi()
                  .revealPath(local)
                  .catch(() => undefined)
              }
              data-menu-item="reveal"
            >
              <FolderOpen className={COMPACT_ICON} />
              {t(IS_MAC ? 'files.revealFinder' : 'files.revealFolder')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 打开方式：本机装了的外部编辑器（跳到链接里的行），最后是系统的默认应用。只在菜单打开时渲染，编辑器的查找推迟到那时。 */
function OpenWithSub({ path, line }: { path: string; line: number | undefined }) {
  const editors = useEditors() ?? [];
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className={COMPACT_ITEM} data-menu-item="open-with">
        <SquareArrowOutUpRight className={COMPACT_ICON} />
        {t('files.openWith')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={SUB_CONTENT}>
        {editors.map((editor) => (
          <DropdownMenuItem
            key={editor.id}
            className={COMPACT_ITEM}
            onClick={() => openInEditor(editor.id, path, line)}
            data-menu-item={`editor-${editor.id}`}
          >
            {editor.name}
          </DropdownMenuItem>
        ))}
        {editors.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          className={COMPACT_ITEM}
          onClick={() =>
            void platformApi()
              .openPath(path)
              .catch(() => undefined)
          }
          data-menu-item="open-default"
        >
          {t('files.openDefault')}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
