import { type ReactNode, useState } from 'react';
import { Collapse } from './collapse';

type Row<T> = { key: string; item: T; open: boolean; enter: boolean };

/** 保留离场行的位置与 React key，等高度收完再移除。初始列表直接显示。 */
export function AnimatedRows<T>({
  as: Element = 'ul',
  className,
  items,
  keyOf,
  empty,
  tail,
  children,
  ...props
}: {
  as?: 'ul' | 'div';
  className?: string;
  items: readonly T[] | undefined;
  keyOf: (item: T) => string;
  empty?: ReactNode;
  tail?: ReactNode;
  children: (item: T) => ReactNode;
  role?: string;
  'aria-label'?: string;
  'data-account-switcher'?: boolean;
}) {
  const [state, setState] = useState(() => ({
    items,
    rows: (items ?? []).map(
      (item): Row<T> => ({ key: keyOf(item), item, open: true, enter: false }),
    ),
  }));
  if (items !== state.items) {
    const old = new Map(state.rows.map((row) => [row.key, row]));
    const rows = (items ?? []).map((item): Row<T> => {
      const key = keyOf(item);
      const previous = old.get(key);
      old.delete(key);
      return { key, item, open: true, enter: previous?.enter ?? state.items !== undefined };
    });
    for (const [index, row] of state.rows.entries()) {
      if (old.has(row.key)) rows.splice(index, 0, { ...row, open: false });
    }
    setState({ items, rows });
  }
  if (state.rows.length === 0 && tail === undefined) return empty;

  return (
    <Element className={className} {...props}>
      {state.rows.map((row) => (
        <Collapse
          key={row.key}
          as={Element === 'ul' ? 'li' : 'div'}
          open={row.open}
          fromClosed={row.enter}
          motion={row.open ? 'fade' : 'height'}
          onExit={() =>
            setState((current) => ({
              ...current,
              rows: current.rows.filter((entry) => entry.key !== row.key || entry.open),
            }))
          }
        >
          {children(row.item)}
        </Collapse>
      ))}
      {tail}
    </Element>
  );
}
