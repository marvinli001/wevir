import { cn } from 'cn';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

/** 收起动画的时长（与 className 里的 duration-200 一致），过渡事件没来时按它卸载。 */
const COLLAPSE_MS = 200;

type Visual = 'open' | 'closed';
/** 一端外层的上下边距补偿（px）。 */
type Edge = { top: number; bottom: number };
/** 展开、收起两端的补偿。 */
type Margins = { open: Edge; closed: Edge };
const NO_EDGE: Edge = { top: 0, bottom: 0 };
const NO_MARGINS: Margins = { open: NO_EDGE, closed: NO_EDGE };

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
 * 照全局规则瞬时完成。`fromOpen` 只在挂上时看：以展开的样子挂上，`open` 为 false 时随即收起，有收起的过渡（回合结束那一刻
 * 才挂上的部分随过程一起收进“已处理”）。
 *
 * 外层是 grid，前后兄弟的上下边距不再隔着它折叠：0fr 时两边的边距相加，卸载后又折叠成一个，间距会在动画结束那一刻收窄一跳
 * （回合里夹着插话、后台进程通知时每段都跳）。所以动画开始前量一次这段差值，用外层的上下边距在动画里补上，结束时与卸载后的
 * 位置一致；同一次提交里开合的几个一起量，按文档顺序逐段补，每一段前后的可见内容都对齐，不把差值堆在第一段上。`flow` 时展开静止的外层与内层是 `display: contents`，内容的边距照常与前后折叠，
 * 和没包这一层时一模一样（回合进行中就包着，结束时只换 `open`，内容不重新挂载），动画期间同样用边距补上 grid 带来的差值；`flow` 不接 `className`。
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
        'grid grid-rows-[1fr] transition-[grid-template-rows,opacity,margin-top,margin-bottom] duration-200 ease-expand',
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

const px = (value: number) => (value === 0 ? '' : `${value}px`);

/** 动画中的一端：grid 行高、透明度、内容的位移与上下边距补偿。 */
function paint({ outer, inner }: Box, visual: Visual, margins: Margins) {
  const edge = visual === 'open' ? margins.open : margins.closed;
  setStyle(outer, {
    display: 'grid',
    'grid-template-rows': visual === 'open' ? '1fr' : '0fr',
    opacity: visual === 'open' ? '1' : '0',
    'margin-top': px(edge.top),
    'margin-bottom': px(edge.bottom),
  });
  setStyle(inner, { display: '', translate: visual === 'open' ? '' : '0 -0.25rem' });
}

/** 展开后静止：回到类名的样子，`flow` 时两层都是 `display: contents`。 */
function settle({ outer, inner, flow }: Box) {
  const display = flow ? 'contents' : '';
  setStyle(outer, {
    display,
    'grid-template-rows': '',
    opacity: '',
    'margin-top': '',
    'margin-bottom': '',
  });
  setStyle(inner, { display, translate: '' });
}

let queue: Job[] = [];

function enqueue(job: Job) {
  if (queue.length === 0) queueMicrotask(flush);
  queue.push(job);
}

/**
 * 量完同一次提交里所有要开合的 Collapse 再一起开始（微任务在绘制之前）。补偿按两种参照摆法各量一次：收起一端对照卸载后
 * （`gone`），展开一端对照静止的样子（`flow` 时是 `display: contents`，`plain`）。每段取它后面最近的可见元素（`flow` 展开
 * 时另取它内容里的第一个），按文档顺序把“参照摆法下的位置 − 动画摆法下的位置 − 前面各段已经补上的”记成这段的下边距（内容
 * 的第一个记成上边距）。补偿都是负的，负边距与正边距折叠时按相加算，逐段累加与一次排版的结果一致；只需四次强制排版。
 * 嵌在这一批另一段里的不单独补（外层那段的参照里已经算上）。
 */
function flush() {
  const jobs = queue.filter((job) => job.live() && job.outer.isConnected);
  queue = [];
  if (jobs.length === 0) return;
  jobs.sort((a, b) =>
    a.outer.compareDocumentPosition(b.outer) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  const nested = jobs.map((job) =>
    jobs.some((other) => other !== job && other.outer.contains(job.outer)),
  );
  const freeze = { transition: 'none', 'margin-top': '', 'margin-bottom': '' };
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
  };
  const tops = (probes: readonly (Element | undefined)[]) =>
    probes.map((probe) => probe?.getBoundingClientRect().top);
  // 收起一端：卸载后 vs 0fr。参照在卸载后的摆法下找，自然跳过这一批（display: none）。
  arrange('gone');
  const afterGone = jobs.map((job) => following(job.outer));
  const gone = tops(afterGone);
  arrange('closed');
  const closed = tops(afterGone);
  const closedEdges = edges(
    jobs.map((_, index) => ({
      skip: nested[index] ?? false,
      defer: reaches(afterGone[index], jobs, index, nested),
      after: [gone[index], closed[index]] as const,
    })),
  );
  let openEdges: Edge[] = jobs.map(() => NO_EDGE);
  if (jobs.some((job) => job.flow)) {
    // 展开一端：静止的样子 vs 1fr。参照在静止的摆法下找，会进到这一批的内容里。
    arrange('plain');
    const afterPlain = jobs.map((job) => following(job.outer));
    const firstPlain = jobs.map((job) => firstVisible(job.inner.children));
    const defer = jobs.map((_, index) => reaches(afterPlain[index], jobs, index, nested));
    const plainAfter = tops(afterPlain);
    const plainFirst = tops(firstPlain);
    arrange('open');
    const openAfter = tops(afterPlain);
    const openFirst = tops(firstPlain);
    openEdges = edges(
      jobs.map((job, index) => ({
        skip: (nested[index] ?? false) || !job.flow,
        defer: defer[index] ?? false,
        first: [plainFirst[index], openFirst[index]] as const,
        after: [plainAfter[index], openAfter[index]] as const,
      })),
    );
  }
  const margins = jobs.map(
    (_, index): Margins => ({
      open: openEdges[index] ?? NO_EDGE,
      closed: closedEdges[index] ?? NO_EDGE,
    }),
  );
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

type Pair = readonly [reference: number | undefined, actual: number | undefined];

/**
 * 按文档顺序逐段算补偿：`first` 是这段内容里第一个可见元素、`after` 是这段后面最近的可见元素在参照摆法与动画摆法下的
 * 位置。前面各段的补偿让后面的一切一起移动，所以每段只补还差的那部分。`defer` 时这段的下边距会隔着外面的边距与下一段的
 * 上边距相接（两个负边距折叠时取小的，不相加），留给下一段一起补。
 */
function edges(
  spans: readonly { skip: boolean; defer: boolean; first?: Pair; after: Pair }[],
): Edge[] {
  let shifted = 0;
  const gap = ([reference, actual]: Pair) => {
    if (reference === undefined || actual === undefined) return 0;
    const value = Math.round((reference - actual - shifted) * 100) / 100;
    // 折叠时正的补偿不按相加算；量出来的差值本该是负的，正的或很小的都当作没有。
    return value > -0.5 ? 0 : value;
  };
  return spans.map(({ skip, defer, first, after }) => {
    if (skip) return NO_EDGE;
    const top = first ? gap(first) : 0;
    shifted += top;
    const bottom = defer ? 0 : gap(after);
    shifted += bottom;
    return { top, bottom };
  });
}

/**
 * 第 index 段后面最近的可见元素 `after` 是不是一路（每层的第一个可见子元素）通到下一段：中间没有可见的内容，两段的补偿边距
 * 会相接。
 */
function reaches(
  after: Element | undefined,
  jobs: readonly Job[],
  index: number,
  nested: readonly boolean[],
): boolean {
  let next = index + 1;
  while (nested[next]) next += 1;
  const target = jobs[next]?.outer;
  if (!after || !target || !after.contains(target)) return false;
  let node: Element = after;
  while (node !== target) {
    let step: Element | undefined;
    for (const child of node.children) {
      if (child === target || child.contains(target)) {
        step = child;
        break;
      }
      if (visibleIn(child)) return false;
    }
    if (!step) return false;
    node = step;
  }
  return true;
}

/** 元素自己或它里面第一个随文档流排的可见元素；`display: contents` 的往里找。 */
function visibleIn(element: Element): Element | undefined {
  if (element.getClientRects().length > 0) {
    const position = getComputedStyle(element).position;
    return position === 'absolute' || position === 'fixed' ? undefined : element;
  }
  if (getComputedStyle(element).display !== 'contents') return undefined;
  return firstVisible(element.children);
}

function firstVisible(elements: HTMLCollection): Element | undefined {
  for (const element of elements) {
    const found = visibleIn(element);
    if (found) return found;
  }
  return undefined;
}

/** 文档顺序里在 element 之后最近的可见元素（不含它自己里面的）。 */
function following(element: Element): Element | undefined {
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      const found = visibleIn(sibling);
      if (found) return found;
    }
  }
  return undefined;
}
