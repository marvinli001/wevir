import { cn } from 'cn';

/** Base UI 的状态回调在原语渲染时才有值。 */
export function withClasses<State>(
  base: string | undefined,
  extra: string | ((state: State) => string | undefined) | undefined,
) {
  return typeof extra === 'function' ? (state: State) => cn(base, extra(state)) : cn(base, extra);
}
