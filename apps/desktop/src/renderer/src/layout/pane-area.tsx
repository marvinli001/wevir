import { Fragment, useRef } from 'react';
import { t } from '@/i18n';
import { fractionsAfterDrag, type LayoutNode } from './arrange';
import { Pane } from './pane';
import type { PaneContext } from './pane-registry';
import { Splitter } from './splitter';

/** 拖动窗格之间的分隔条：拖动中只改草稿（不写本机存储），松开时提交；双击回到默认比例。 */
export interface SplitResizeHandlers {
  onDraft: (key: string, fractions: number[]) => void;
  onCommit: (key: string, fractions: number[]) => void;
  onReset: (key: string) => void;
}

/** 按排布树（arrange.ts）渲染窗格区：拆分节点是横向或纵向的 flex，子节点之间是分隔条。 */
export function PaneTree({
  node,
  context,
  resize,
}: {
  node: LayoutNode;
  context: PaneContext;
  resize: SplitResizeHandlers;
}) {
  if (node.type === 'pane') return <Pane pane={node.pane} context={context} />;
  const row = node.direction === 'row';
  return (
    <div className={row ? 'flex h-full w-full min-w-0' : 'flex h-full w-full min-h-0 flex-col'}>
      {node.children.map((child, index) => (
        <Fragment key={child.type === 'pane' ? child.pane.id : child.key}>
          {index > 0 && <SplitHandle node={node} index={index - 1} resize={resize} />}
          <div className="flex min-h-0 min-w-0" style={{ flex: `0 0 ${node.sizes[index] ?? 0}px` }}>
            <PaneTree node={child} context={context} resize={resize} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function SplitHandle({
  node,
  index,
  resize,
}: {
  node: Extract<LayoutNode, { type: 'split' }>;
  index: number;
  resize: SplitResizeHandlers;
}) {
  // 按下时的尺寸：拖动中树会按草稿重算，位移要从按下时算起。
  const start = useRef<readonly number[]>(node.sizes);
  const size = node.sizes[index] ?? 0;
  const pair = size + (node.sizes[index + 1] ?? 0);
  const after = (delta: number) => fractionsAfterDrag(start.current, node.mins, index, delta);
  return (
    <Splitter
      orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
      label={t('layout.resizePane')}
      valueNow={size}
      valueMin={node.mins[index] ?? 0}
      valueMax={pair - (node.mins[index + 1] ?? 0)}
      onResizeStart={() => {
        start.current = node.sizes;
      }}
      onResize={(delta) => resize.onDraft(node.key, after(delta))}
      onResizeEnd={(delta) => resize.onCommit(node.key, after(delta))}
      onReset={() => resize.onReset(node.key)}
    />
  );
}
