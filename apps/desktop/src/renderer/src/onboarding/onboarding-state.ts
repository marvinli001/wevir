// 首次引导走完或跳过之后不再出现（U6）。只记在本机；Host 里已有 Provider 时首页本来就不会进引导。

import { createPersistedStore } from '@/lib/store';

export const onboardingDone = createPersistedStore<boolean>('wevir.onboarding.v1', false, (raw) =>
  typeof raw === 'boolean' ? raw : undefined,
);
