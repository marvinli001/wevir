export function sameItems<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every((item, index) => item === b[index]))
  );
}

export function sameFields<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a) as (keyof T)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => {
      const value = a[key];
      const other = b[key];
      return Array.isArray(value) && Array.isArray(other)
        ? sameItems(value, other)
        : value === other;
    })
  );
}
