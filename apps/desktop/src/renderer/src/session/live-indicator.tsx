import { createContext, useContext } from 'react';
import type { OrbState } from 'thinking-orbs';
import { Orb } from '@/fx/orb';

/** `input`：有问题等用户回答（0.10.0），orb 同等审批一样停住。 */
export type LiveState = 'running' | 'awaiting' | 'input' | 'stopping';

/** 进行中的回合用哪种 orb：TurnView 按回合 ID 定下（fx/orb-state.ts），给它里面的工作组与“正在思考”那一行。 */
export const TurnOrb = createContext<OrbState>('working');

/**
 * 进行中的回合在消息流里的状态图标位（U2 留的 20px 槽，U3 起是 thinking orb）：正在执行的工作组那一行、或回合末尾
 * “正在思考”那一行的最前面。等待审批时 orb 停在当前帧；状态由旁边的文字说明。
 */
export function LiveIndicator({ state }: { state: LiveState }) {
  const orb = useContext(TurnOrb);
  return (
    <span
      aria-hidden
      data-live-indicator={state}
      className="flex size-5 shrink-0 items-center justify-center"
    >
      <Orb state={orb} paused={state === 'awaiting' || state === 'input'} />
    </span>
  );
}
