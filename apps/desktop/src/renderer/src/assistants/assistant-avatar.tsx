import type { AssistantAvatar as Avatar } from '@wevir/protocol';
import { BotAvatar } from 'bot-avatars';
import { useFxTheme, useReducedMotion } from '@/fx/motion';
import { AVATAR_COLORS } from '@/session/avatar';

/**
 * 助理的头像：与子会话同一套 bot-avatars 与参数（session/subagent-avatar.tsx），形状、颜色、seed 是助理存着的那个。只有在干活时
 * 蹦跳，其余画静止的姿势（闲置动画每个实例都 60fps 重画）；暂停的睡着。纯装饰，名字由旁边的文字给出。
 */
export function AssistantAvatar({
  avatar,
  size = 28,
  working = false,
  paused = false,
  className,
}: {
  avatar: Avatar;
  size?: number;
  working?: boolean;
  paused?: boolean;
  className?: string;
}) {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  const moving = working && !reduced;
  return (
    <BotAvatar
      key={moving ? 'moving' : 'still'}
      paused={!moving}
      type={avatar.type}
      color={AVATAR_COLORS[theme][avatar.color] ?? AVATAR_COLORS[theme][0]}
      size={size}
      state={paused ? 'sleeping' : moving ? 'working' : 'default'}
      theme={theme}
      shading="smooth"
      saturation={0.8}
      seed={avatar.seed}
      aria-hidden
      data-avatar-type={avatar.type}
      className={className}
    />
  );
}
