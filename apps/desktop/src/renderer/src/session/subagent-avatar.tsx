import type { SubagentStatus } from '@wevir/protocol';
import { BotAvatar } from 'bot-avatars';
import { useState } from 'react';
import { useFxTheme, useReducedMotion } from '@/fx/motion';
import { AVATAR_COLORS, avatarFor, avatarState } from './avatar';

/**
 * 子会话的头像（R5；U3 起是 bot-avatars，方向稿 A 静器的参数：smooth 光影、饱和度 0.8）：形状、颜色由会话 ID 确定
 * （avatar.ts），动作跟着子会话的状态。纯装饰，名字由旁边的文字给出。`interactive` 时眼睛跟着指针、点一下会跳（只给
 * 窗格列表里的）。
 *
 * 只有运行中的（蹦跳）和指针停在上面的可交互头像在动，其余画静止的姿势：库的闲置动画（眨眼、张望、偶尔跳一下）每个
 * 实例都 60fps 重画，消息流里两个闲着的头像就要 GPU 进程约 20%、渲染进程约 12% 的 CPU。库的 paused 会冻结在当前帧（可能
 * 停在半空），所以静止时是重挂一个 paused 的实例（挂载时就画静止姿势）。减弱动效同理，库只在挂载时看一次系统设置。
 */
export function SubagentAvatar({
  sessionId,
  status,
  size = 16,
  interactive = false,
  className,
}: {
  sessionId: string;
  status?: SubagentStatus;
  /** 边长（px）；画布会画得大一点、用负外边距收回来，跳起来不被裁掉，布局上仍是这个尺寸。 */
  size?: number;
  interactive?: boolean;
  className?: string;
}) {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  const { type, color, seed } = avatarFor(sessionId);
  const moving = !reduced && (status === 'running' || (interactive && hovered));
  return (
    <BotAvatar
      key={moving ? 'moving' : 'still'}
      paused={!moving}
      {...(interactive && {
        onPointerEnter: () => setHovered(true),
        onPointerLeave: () => setHovered(false),
      })}
      type={type}
      color={AVATAR_COLORS[theme][color]}
      size={size}
      state={avatarState(status)}
      theme={theme}
      shading="smooth"
      saturation={0.8}
      interactive={interactive}
      seed={seed}
      aria-hidden
      data-avatar-type={type}
      className={className}
    />
  );
}
