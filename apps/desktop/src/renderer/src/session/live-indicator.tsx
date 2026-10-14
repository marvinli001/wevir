import { StatusDot } from '@/components/status-dot';

export type LiveState = 'running' | 'awaiting' | 'stopping';

/**
 * 进行中的回合在消息流里的状态图标位（U2）：正在执行的工作组那一行、或回合末尾“正在思考”那一行的最前面，固定 20px
 * 见方。现在是状态圆点（运行中闪烁、待审批不闪、正在停止闪警示色）；U3 在这里换成 thinking orb，调用方不用改。
 */
export function LiveIndicator({ state }: { state: LiveState }) {
  return (
    <span
      aria-hidden
      data-live-indicator={state}
      className="flex size-5 shrink-0 items-center justify-center"
    >
      <StatusDot tone={state === 'running' ? 'accent' : 'warning'} pulse={state !== 'awaiting'} />
    </span>
  );
}
