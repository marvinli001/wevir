// 弹簧缓动（desktop-tokens.md §44）：按刚度、阻尼与质量解出阻尼振子从 0 到 1 的位移，采样成 CSS 的 linear()，
// 时长取位移最后一次离终点超过 SETTLE_EPSILON 的时刻。styles/theme.css 的 --spring-* 与 --spring-*-duration
// 由它生成，改参数后运行 `node scripts/spring-easing.ts`，把打印的块贴回 theme.css；spring-easing.test.ts 核对两边
// 一致。只用解析解，不做数值积分。

/** 采样点与直线插值的偏差不超过这么多就省掉（位移的比例）。 */
const SIMPLIFY_TOLERANCE = 0.002;
/** 离终点不超过位移的这么多算停下：8 px 的位移剩 0.04 px。 */
const SETTLE_EPSILON = 0.005;
/** 求时长与采样用的步长（秒）。 */
const STEP = 0.001;

export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
}

/** 令牌名 → 参数。press：按钮松开；reveal：菜单、弹层、对话框入场；bounce：确认反馈；snap：过阻尼，面板吸附。 */
export const SPRINGS = {
  press: { stiffness: 600, damping: 30, mass: 1 },
  reveal: { stiffness: 320, damping: 28, mass: 1 },
  bounce: { stiffness: 380, damping: 18, mass: 1 },
  snap: { stiffness: 800, damping: 60, mass: 1 },
} as const satisfies Record<string, Spring>;

/** t 秒时的位移（0 → 1，初速度 0）。 */
export function springAt({ stiffness, damping, mass }: Spring, t: number): number {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * t);
    return 1 - decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const root = w0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * w0 + root;
  const r2 = -zeta * w0 - root;
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/** 停下的时刻（秒）：之后位移离终点都不超过 SETTLE_EPSILON。 */
export function settleTime(spring: Spring): number {
  let last = 0;
  for (let t = 0; t < 5; t += STEP) {
    if (Math.abs(springAt(spring, t) - 1) > SETTLE_EPSILON) last = t;
  }
  return last;
}

export interface SpringEasing {
  /** CSS 的 linear() 缓动。 */
  easing: string;
  /** linear() 的各个停靠点（"值 位置%"）。 */
  stops: string[];
  /** 配套的时长（ms，取整到 10）。 */
  durationMs: number;
}

export function springEasing(spring: Spring): SpringEasing {
  const durationMs = Math.ceil((settleTime(spring) * 1000) / 10) * 10;
  const duration = durationMs / 1000;
  const samples: [number, number][] = [];
  for (let ms = 0; ms <= durationMs; ms += 5) {
    const t = ms / 1000;
    samples.push([t / duration, ms === durationMs ? 1 : springAt(spring, t)]);
  }
  const kept = simplify(samples);
  const parts = kept.map(([x, y], index) => {
    const value = round(y, 3);
    if (index === 0 || index === kept.length - 1) return String(value);
    return `${value} ${round(x * 100, 1)}%`;
  });
  return { easing: `linear(${parts.join(', ')})`, stops: parts, durationMs };
}

/** 去掉落在前后两点连线附近的点。 */
function simplify(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [points[0] as [number, number]];
  let anchor = 0;
  for (let i = 2; i < points.length; i++) {
    const [x0, y0] = points[anchor] as [number, number];
    const [x1, y1] = points[i] as [number, number];
    const fits = points.slice(anchor + 1, i).every(([x, y]) => {
      const expected = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      return Math.abs(expected - y) <= SIMPLIFY_TOLERANCE;
    });
    if (!fits) {
      anchor = i - 1;
      out.push(points[anchor] as [number, number]);
    }
  }
  out.push(points[points.length - 1] as [number, number]);
  return out;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** theme.css 里 :root 的那一块，照 Biome 的格式一个停靠点一行。 */
export function springCss(): string {
  return Object.entries(SPRINGS)
    .map(([name, spring]) => {
      const { stops, durationMs } = springEasing(spring);
      const params = `stiffness ${spring.stiffness} / damping ${spring.damping} / mass ${spring.mass}`;
      return [
        `  /* ${name}：${params} */`,
        `  --spring-${name}: linear(\n${stops.map((stop) => `    ${stop}`).join(',\n')}\n  );`,
        `  --spring-${name}-duration: ${durationMs}ms;`,
      ].join('\n');
    })
    .join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(springCss());
}
