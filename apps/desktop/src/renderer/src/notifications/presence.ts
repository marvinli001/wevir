// 在场（0.104.0，Host 功能 `notification_intents`，domain-model §3.48）：窗口可见、有焦点、没锁屏且 5 分钟内有键鼠操作时报
// `presence.update({ active: true })`，否则报 false。值变了才发，重连后 client-sdk 重报（`setPresence`）；旧 Host 上只记下。

import type { WevirClient } from '@wevir/client-sdk';
import { useEffect } from 'react';

/** 多久没有键鼠操作算离开。 */
export const PRESENCE_IDLE_MS = 5 * 60_000;

export interface PresenceInputs {
  visible: boolean;
  focused: boolean;
  locked: boolean;
  /** 最近一次键鼠操作的时刻（毫秒）。 */
  lastInputAt: number;
  now: number;
}

export function presenceActive(inputs: PresenceInputs): boolean {
  return (
    inputs.visible &&
    inputs.focused &&
    !inputs.locked &&
    inputs.now - inputs.lastInputAt < PRESENCE_IDLE_MS
  );
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

/** 按窗口的焦点、可见、锁屏与键鼠操作报在场。挂在通知协调器里。 */
export function usePresenceReporter(client: WevirClient | undefined): void {
  useEffect(() => {
    if (client === undefined) return;
    let locked = false;
    let lastInputAt = Date.now();
    let active = false;
    let timer: number | undefined;
    const update = () => {
      window.clearTimeout(timer);
      timer = undefined;
      const now = Date.now();
      active = presenceActive({
        visible: document.visibilityState === 'visible',
        focused: document.hasFocus(),
        locked,
        lastInputAt,
        now,
      });
      client.setPresence(active);
      // 在场时到可能空闲的时刻再看一次（期间有操作就顺延）。
      if (active) timer = window.setTimeout(update, lastInputAt + PRESENCE_IDLE_MS - now);
    };
    // 在场时只挪时刻（pointermove 很密），不在场时重算。
    const onInput = () => {
      lastInputAt = Date.now();
      if (!active) update();
    };
    const stopLock = window.wevir?.onScreenLock?.((value) => {
      locked = value;
      update();
    });
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true });
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      window.clearTimeout(timer);
      stopLock?.();
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [client]);
}
