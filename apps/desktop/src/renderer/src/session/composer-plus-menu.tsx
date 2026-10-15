// 输入框左下角的“+”（U33，照 Codex 桌面端的“添加”菜单）：添加文件和文件夹（系统的选择框，插入成 @ 提及）、提及文件、
// 斜杠命令（输入框为空时），以及页面标为 `plus` 的命令（有二级菜单的是子菜单）。

import { AtSign, Check, Paperclip, Plus, Slash } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import type { ComposerCommand } from './composer-commands';

export function ComposerPlusMenu({
  commands,
  disabled,
  canMention,
  canCommand,
  onAttach,
  onMention,
  onCommand,
  onRun,
  onClosed,
}: {
  commands: readonly ComposerCommand[];
  disabled: boolean;
  /** 有文件可提及（Host 支持、知道目录）。 */
  canMention: boolean;
  /** 输入框为空，可以打开斜杠命令。 */
  canCommand: boolean;
  onAttach: () => void;
  onMention: () => void;
  onCommand: () => void;
  /** 选了一条没有二级菜单的命令（执行或插入文字由输入框处理）。 */
  onRun: (command: ComposerCommand) => void;
  /** 菜单关了（焦点回到输入框）。 */
  onClosed: () => void;
}) {
  const listed = commands.filter((command) => command.plus);
  return (
    <DropdownMenu onOpenChange={(open) => !open && onClosed()}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              disabled={disabled}
              aria-label={t('composer.add')}
              data-testid="composer-plus"
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-soft-foreground outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-expanded:bg-muted aria-expanded:text-foreground"
            />
          }
        >
          <Plus aria-hidden className="size-4" />
        </TooltipTrigger>
        <TooltipContent>{t('composer.add')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('composer.add')}</DropdownMenuLabel>
          {canMention && (
            <DropdownMenuItem onClick={onAttach} data-action="attach-files">
              <Paperclip />
              {t('composer.attachFiles')}
            </DropdownMenuItem>
          )}
          {canMention && (
            <DropdownMenuItem onClick={onMention} data-action="mention-file">
              <AtSign />
              {t('composer.mentionFile')}
            </DropdownMenuItem>
          )}
          {canCommand && (
            <DropdownMenuItem onClick={onCommand} data-action="open-commands">
              <Slash />
              {t('composer.commands')}
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
        {listed.length > 0 && <DropdownMenuSeparator />}
        {listed.map((command) => {
          const Icon = command.icon;
          if (command.items) {
            const items = command.items();
            return (
              <DropdownMenuSub key={command.name}>
                <DropdownMenuSubTrigger data-command={command.name}>
                  <Icon />
                  <span className="flex-1">{command.label}</span>
                  {command.detail && (
                    <span className="truncate text-xs text-muted-foreground">{command.detail}</span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-48">
                  {items.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      disabled={item.disabled}
                      onClick={item.run}
                      data-command-item={item.id}
                    >
                      {item.icon}
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.checked && <Check aria-hidden className="text-muted-foreground" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          }
          return (
            <DropdownMenuItem
              key={command.name}
              onClick={() => onRun(command)}
              data-command={command.name}
            >
              <Icon />
              {command.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
