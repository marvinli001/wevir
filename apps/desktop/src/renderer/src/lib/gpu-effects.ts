import { useSyncExternalStore } from 'react';
import { platformApi } from '@/platform/platform';

const REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)';
let lowGpu = false;
const listeners = new Set<() => void>();

export async function bootstrapGpuEffects(): Promise<void> {
  const apply = (value: boolean) => {
    lowGpu = value;
    document.documentElement.toggleAttribute('data-low-gpu', value);
    for (const listener of listeners) listener();
  };
  platformApi().onLowGpu(apply);
  apply(await platformApi().getLowGpu());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const query = window.matchMedia(REDUCED_TRANSPARENCY);
  query.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    query.removeEventListener('change', listener);
  };
}

export function useReducedGpuEffects(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => lowGpu || window.matchMedia(REDUCED_TRANSPARENCY).matches,
  );
}
