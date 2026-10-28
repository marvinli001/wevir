// 助理开在项目里的线程（0.134.0）在左栏是那个项目的普通会话，行尾带助理的头像。助理的名字与头像取 `channel.list`（左栏整体读一次，
// 之后按 `channels.changed` 更新），会话行按 `Session.channel.channelId` 查。

import type { WevirClient } from '@wevir/client-sdk';
import type { Channel, ChannelId } from '@wevir/protocol';
import { cn } from 'cn';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Hint } from '@/components/hint';
import { t } from '@/i18n';
import { AssistantAvatar } from './assistant-avatar';
import { useAssistantList } from './use-assistants';

const ThreadAssistantsContext = createContext<ReadonlyMap<string, Channel> | undefined>(undefined);

/** 给左栏的会话行提供助理（只在 Host 有助理时挂）。 */
export function ThreadAssistants({
  client,
  children,
}: {
  client: WevirClient;
  children: ReactNode;
}) {
  const { channels } = useAssistantList(client);
  const byId = useMemo(
    () => new Map((channels ?? []).map((channel) => [channel.id as string, channel])),
    [channels],
  );
  return (
    <ThreadAssistantsContext.Provider value={byId}>{children}</ThreadAssistantsContext.Provider>
  );
}

/** 会话行尾的助理头像；助理删了或还没读到时不画。 */
export function ThreadAssistantMark({
  channelId,
  className,
}: {
  channelId: ChannelId;
  className?: string;
}) {
  const channel = useContext(ThreadAssistantsContext)?.get(channelId);
  const avatar = channel?.assistant?.avatar;
  if (channel === undefined || avatar === undefined) return null;
  const label = t('session.assistant', { name: channel.title });
  return (
    <Hint label={label}>
      <span
        role="img"
        aria-label={label}
        data-thread-assistant={channelId}
        className={cn('flex shrink-0', className)}
      >
        <AssistantAvatar avatar={avatar} size={16} />
      </span>
    </Hint>
  );
}
