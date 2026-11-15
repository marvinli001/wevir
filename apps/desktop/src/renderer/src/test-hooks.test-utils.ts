import type { EffectCallback, ReactElement, ReactNode } from 'react';

export const hooks = {
  values: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<EffectCallback>,
  stateIndex: 0,
  refIndex: 0,
  reset(values: unknown[] = []) {
    this.values = values;
    this.refs = [];
    this.effects = [];
    this.stateIndex = 0;
    this.refIndex = 0;
  },
  render<T>(render: () => T): T {
    this.stateIndex = 0;
    this.refIndex = 0;
    this.effects = [];
    return render();
  },
};
export function useState(initial?: unknown) {
  const index = hooks.stateIndex++;
  if (!(index in hooks.values))
    hooks.values[index] = typeof initial === 'function' ? initial() : initial;
  return [
    hooks.values[index],
    (next: unknown) => {
      hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next;
    },
  ];
}
export function useRef(initial: unknown) {
  const index = hooks.refIndex++;
  hooks.refs[index] ??= { current: initial };
  return hooks.refs[index];
}
export function findElement(
  node: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>> {
  const pending = [node];
  while (pending.length) {
    const item = pending.shift();
    if (Array.isArray(item)) {
      pending.push(...item);
      continue;
    }
    if (!item || typeof item !== 'object' || !('props' in item)) continue;
    const element = item as ReactElement<Record<string, unknown>>;
    if (predicate(element)) return element;
    pending.push(element.props.children as ReactNode);
  }
  throw new Error('missing test element');
}
