// 首次引导走完或跳过之后不再出现；已有项目或会话的客户端也不强制进入。

import { createPersistedStore } from '@/lib/store';

export const onboardingDone = createPersistedStore<boolean>('wevir.onboarding.v1', false, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
);
