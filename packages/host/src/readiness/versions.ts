// 版本与版本要求（项目环境就绪，0.70.0）：从 `--version` 的输出里取版本号，判断它满不满足项目写的要求。只认常见写法：npm 的 semver
// 范围（`>=24.15`、`^12.6.0`、`~3.1`、`24.x`、`1.2 - 1.4`、`||`）与 PEP 440 的比较（`>=3.11,<4`、`~=3.12`、`==3.12.*`）；认不出时是
// `undefined`（报告里记“未知”，不当成不满足）。

export type Version = readonly [number, number, number];

/** 输出里第一个像版本号的（`v24.21.0`、`Python 3.12.4`、`go1.22.3`、`rustc 1.85.0 (…)`）。 */
export function parseVersionOutput(text: string): string | undefined {
  return (
    /(?:^|[^\d.])v?(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? /(?:^|\D)(\d+)(?:\D|$)/.exec(text)?.[1]
  );
}

export function parseVersion(text: string): Version | undefined {
  const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** 版本满足 npm 的 semver 范围吗；范围认不出时 undefined。 */
export function satisfiesNpmRange(version: string, range: string): boolean | undefined {
  const parsed = parseVersion(version);
  if (!parsed) return undefined;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'latest') return true;
  const alternatives = trimmed.split('||').map((part) => part.trim());
  let known = false;
  for (const alternative of alternatives) {
    const result = satisfiesAll(parsed, alternative);
    if (result === true) return true;
    if (result === false) known = true;
  }
  return known ? false : undefined;
}

function satisfiesAll(version: Version, set: string): boolean | undefined {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen) {
    const low = parsePartial(hyphen[1] as string);
    const high = parsePartial(hyphen[2] as string);
    if (!low || !high) return undefined;
    return compareVersions(version, low.version) >= 0 && belowUpper(version, high);
  }
  const comparators = set.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/);
  for (const comparator of comparators) {
    if (comparator === '') continue;
    const result = satisfiesOne(version, comparator);
    if (result === undefined) return undefined;
    if (!result) return false;
  }
  return true;
}

interface Partial {
  version: Version;
  /** 写了几段（`24` 是 1，`24.15` 是 2）。 */
  parts: number;
}

function parsePartial(text: string): Partial | undefined {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(text);
  if (!match) return undefined;
  const values: number[] = [];
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || /^[xX*]$/.test(part)) break;
    values.push(Number(part));
  }
  return {
    version: [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0],
    parts: values.length,
  };
}

function belowUpper(version: Version, upper: Partial): boolean {
  if (upper.parts === 3) return compareVersions(version, upper.version) <= 0;
  return compareVersions(version, bump(upper.version, upper.parts)) < 0;
}

/** 把第 `parts` 段加一、后面清零（`24.15` 写了两段 → `24.16.0`）。 */
function bump(version: Version, parts: number): Version {
  if (parts <= 0) return [Number.MAX_SAFE_INTEGER, 0, 0];
  if (parts === 1) return [version[0] + 1, 0, 0];
  return [version[0], version[1] + 1, 0];
}

function satisfiesOne(version: Version, comparator: string): boolean | undefined {
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(comparator);
  if (!match) return undefined;
  const operator = match[1] ?? '';
  const partial = parsePartial(match[2] as string);
  if (!partial) return undefined;
  const { version: target, parts } = partial;
  const cmp = compareVersions(version, target);
  switch (operator) {
    case '>=':
      return cmp >= 0;
    case '>':
      return parts === 3 ? cmp > 0 : compareVersions(version, bump(target, parts)) >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return belowUpper(version, partial);
    case '^': {
      if (cmp < 0) return false;
      if (target[0] > 0 || parts === 1) return version[0] === target[0];
      if (target[1] > 0 || parts === 2) return version[0] === 0 && version[1] === target[1];
      return compareVersions(version, target) === 0;
    }
    case '~':
      if (cmp < 0) return false;
      return parts === 1
        ? version[0] === target[0]
        : version[0] === target[0] && version[1] === target[1];
    default:
      if (parts === 0) return true;
      if (parts === 3) return cmp === 0;
      return cmp >= 0 && compareVersions(version, bump(target, parts)) < 0;
  }
}

/** 版本满足 PEP 440 的要求吗（逗号分隔的比较）；认不出时 undefined。 */
export function satisfiesPep440(version: string, specifier: string): boolean | undefined {
  const parsed = parseVersion(version);
  if (!parsed) return undefined;
  for (const raw of specifier.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const match = /^(~=|===|==|!=|>=|<=|>|<)\s*(\d+(?:\.\d+){0,2})(\.\*)?$/.exec(part);
    if (!match) return undefined;
    const operator = match[1] as string;
    const target = parseVersion(match[2] as string) as Version;
    const parts = (match[2] as string).split('.').length;
    const wildcard = match[3] !== undefined;
    const cmp = compareVersions(parsed, target);
    let ok: boolean;
    switch (operator) {
      case '>=':
        ok = cmp >= 0;
        break;
      case '<=':
        ok = cmp <= 0;
        break;
      case '>':
        ok = cmp > 0;
        break;
      case '<':
        ok = cmp < 0;
        break;
      case '~=':
        ok = cmp >= 0 && compareVersions(parsed, bump(target, Math.max(parts - 1, 1))) < 0;
        break;
      case '!=':
        ok = wildcard ? !samePrefix(parsed, target, parts) : cmp !== 0;
        break;
      default:
        ok = wildcard ? samePrefix(parsed, target, parts) : cmp === 0;
    }
    if (!ok) return false;
  }
  return true;
}

function samePrefix(a: Version, b: Version, parts: number): boolean {
  for (let i = 0; i < parts; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `go 1.22` / `go 1.22.3` 这样的最低版本：`found` 不低于它吗。 */
export function atLeast(found: string, minimum: string): boolean | undefined {
  const a = parseVersion(found);
  const b = parseVersion(minimum);
  if (!a || !b) return undefined;
  return compareVersions(a, b) >= 0;
}
