import { cn } from 'cn';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** 收起动画的时长（与 className 里的 duration-200 一致），过渡事件没来时按它卸载。 */
const COLLAPSE_MS = 200;

type Visual = 'open' | 'closed';
/** 展开、收起两端外层的上边距补偿（px）。 */
type Margins = { open: number; closed: number };
const NO_MARGINS: Margins = { open: 0, closed: 0 };

type Box = { outer: HTMLDivElement; inner: HTMLDivElement; flow: boolean };
type Job = Box & {
  from: Visual;
  to: Visual;
  live: () => boolean;
  start: (margins: Margins) => void;
};

/**
 * 展开收起时高度过渡（U10）：外层 grid 的行高在 0fr 与 1fr 之间过渡，同时淡入淡出，内容从上方 4 px 落下（U24）；收起
 * 结束后卸载内容，长列表里收起的部分不占 DOM。行高用 ease-expand（先快后长尾，照 Claude 桌面端时间线的展开）。减弱动效时
 * 照全局规则瞬时完成。`fromOpen` 只在挂上时看：以展开的样子挂上，`open` 为 false 时随即收起，有收起的过渡（回合结束时
 * 过程自动收进“已处理”，那一刻外面的结构才换成分段）。
 *
 * 外层是 grid，前后兄弟的上下边距不再隔着它折叠：0fr 时两边的边距相加，卸载后又折叠成一个，间距会在动画结束那一刻收窄一跳
 * （回合里夹着插话、后台进程通知时每段都跳）。所以动画开始前量一次这段差值，用外层的上边距在动画里补上，结束时与卸载后的
 * 位置一致；同一次提交里开合的几个一起量。`flow` 时展开静止的外层与内层是 `display: contents`，内容的边距照常与前后折叠，
 * 和没包这一层时一模一样（回合进行中不包，结束时才包上），动画期间同样用边距补上 grid 带来的差值；`flow` 不接 `className`。
 */
export function Collapse({
  open,
  fromOpen = false,
  flow = false,
  id,
  className,
  children,
}: {
  open: boolean;
  fromOpen?: boolean;
  flow?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open || fromOpen);
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  // 最近一次动画的目标；token 让过时的结束回调失效（动画中途又切换）。卸载时不作废：StrictMode 的模拟卸载会留着同一个节点。
  const shown = useRef<Visual>(open || fromOpen ? 'open' : 'closed');
  const run = useRef({ token: 0, running: false, margins: NO_MARGINS, finish: () => {} });
  const present = open || mounted;

  useLayoutEffect(() => {
    if (open && !mounted) setMounted(true);
  }, [open, mounted]);

  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!present || !o || !i) return;
    const state = run.current;
    const want: Visual = open ? 'open' : 'closed';
    if (shown.current === want) {
      if (want === 'open' && !state.running) settle({ outer: o, inner: i, flow });
      return;
    }
    shown.current = want;
    const token = ++state.token;
    const box = { outer: o, inner: i, flow };
    let timer: ReturnType<typeof setTimeout> | undefined;
    state.finish = () => {
      if (state.token !== token) return;
      clearTimeout(timer);
      state.running = false;
      if (want === 'open') settle(box);
      else setMounted(false);
    };
    const go = () => {
      timer = setTimeout(() => state.finish(), COLLAPSE_MS + 50);
    };
    if (state.running) {
      // 动画中途换方向：从当前的样子直接过渡到另一端，沿用量好的补偿。
      paint(box, want, state.margins);
      go();
      return;
    }
    state.running = true;
    enqueue({
      ...box,
      from: want === 'open' ? 'closed' : 'open',
      to: want,
      live: () => state.token === token,
      start: (margins) => {
        state.margins = margins;
        go();
      },
    });
  }, [open, present, flow]);

  if (!present) return null;
  return (
    <div
      ref={outer}
      id={id}
      className={cn(
        'grid grid-rows-[1fr] transition-[grid-template-rows,opacity,margin-top] duration-200 ease-expand',
        !flow && className,
      )}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'grid-template-rows')
          run.current.finish();
      }}
    >
      <div
        ref={inner}
        className="min-h-0 overflow-hidden transition-transform duration-200 ease-expand"
      >
        {children}
      </div>
    </div>
  );
}

function setStyle(element: HTMLElement, styles: Record<string, string>) {
  for (const [name, value] of Object.entries(styles)) {
    if (value === '') element.style.removeProperty(name);
    else element.style.setProperty(name, value);
  }
}

/** 动画中的一端：grid 行高、透明度、内容的位移与上边距补偿。 */
function paint({ outer, inner }: Box, visual: Visual, margins: Margins) {
  const margin = visual === 'open' ? margins.open : margins.closed;
  setStyle(outer, {
    display: 'grid',
    'grid-template-rows': visual === 'open' ? '1fr' : '0fr',
    opacity: visual === 'open' ? '1' : '0',
    'margin-top': margin === 0 ? '' : `${margin}px`,
  });
  setStyle(inner, { display: '', translate: visual === 'open' ? '' : '0 -0.25rem' });
}

/** 展开后静止：回到类名的样子，`flow` 时两层都是 `display: contents`。 */
function settle({ outer, inner, flow }: Box) {
  const display = flow ? 'contents' : '';
  setStyle(outer, { display, 'grid-template-rows': '', opacity: '', 'margin-top': '' });
  setStyle(inner, { display, translate: '' });
}

let queue: Job[] = [];

function enqueue(job: Job) {
  if (queue.length === 0) queueMicrotask(flush);
  queue.push(job);
}

/**
 * 量完同一次提交里所有要开合的 Collapse 再一起开始（微任务在绘制之前）：每个取前后最近的、不在这批里的可见元素作参照，
 * 比较几种摆法下两者的距离，只需几次强制排版。前后参照相同的几个（相邻）把差值记在第一个上。
 */
function flush() {
  const jobs = queue.filter((job) => job.live() && job.outer.isConnected);
  queue = [];
  if (jobs.length === 0) return;
  const batch = new Set<Element>(jobs.map((job) => job.outer));
  const anchors = jobs.map(
    (job) => [beside(job.outer, batch, -1), beside(job.outer, batch, 1)] as const,
  );
  const gaps = () =>
    anchors.map(([before, after]) =>
      after === undefined
        ? 0
        : after.getBoundingClientRect().top - (before?.getBoundingClientRect().bottom ?? 0),
    );
  const freeze = { transition: 'none', 'margin-top': '' };
  for (const job of jobs) {
    setStyle(job.outer, freeze);
    setStyle(job.inner, { transition: 'none', display: '' });
  }
  const arrange = (visual: Visual | 'gone' | 'plain') => {
    for (const job of jobs) {
      const shape = visual === 'plain' && !job.flow ? 'open' : visual;
      if (shape === 'gone') setStyle(job.outer, { display: 'none' });
      else if (shape === 'plain') {
        setStyle(job.outer, { display: 'contents' });
        setStyle(job.inner, { display: 'contents' });
      } else {
        setStyle(job.outer, {
          display: 'grid',
          'grid-template-rows': shape === 'open' ? '1fr' : '0fr',
        });
        setStyle(job.inner, { display: '' });
      }
    }
    return gaps();
  };
  const gone = arrange('gone');
  const closed = arrange('closed');
  const flowing = jobs.some((job) => job.flow);
  const plain = flowing ? arrange('plain') : undefined;
  const opened = flowing ? arrange('open') : undefined;
  const claimed = new Map<Element | undefined, Set<Element | undefined>>();
  const margins = jobs.map((job, index): Margins => {
    const [before, after] = anchors[index] ?? [];
    if (after === undefined) return NO_MARGINS;
    const seen = claimed.get(before) ?? new Set();
    claimed.set(before, seen);
    if (seen.has(after)) return NO_MARGINS;
    seen.add(after);
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      closed: round((gone[index] ?? 0) - (closed[index] ?? 0)),
      open: job.flow && plain && opened ? round((plain[index] ?? 0) - (opened[index] ?? 0)) : 0,
    };
  });
  // 起点在 transition: none 下画好并排版一次，再恢复过渡、写终点，过渡才从起点开始。
  for (const [index, job] of jobs.entries()) paint(job, job.from, margins[index] ?? NO_MARGINS);
  jobs[0]?.outer.getBoundingClientRect();
  for (const [index, job] of jobs.entries()) {
    const m = margins[index] ?? NO_MARGINS;
    setStyle(job.outer, { transition: '' });
    setStyle(job.inner, { transition: '' });
    paint(job, job.to, m);
    job.start(m);
  }
}

/** 文档顺序里在 element 之前（-1）或之后（1）最近的、随文档流排的可见元素，跳过这一批的 Collapse 与它的祖先。 */
function beside(element: Element, batch: Set<Element>, direction: -1 | 1): Element | undefined {
  const step = (node: Element) =>
    direction < 0 ? node.previousElementSibling : node.nextElementSibling;
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    for (let sibling = step(node); sibling; sibling = step(sibling)) {
      if (batch.has(sibling) || sibling.getClientRects().length === 0) continue;
      const position = getComputedStyle(sibling).position;
      if (position === 'absolute' || position === 'fixed') continue;
      return sibling;
    }
  }
  return undefined;
}
