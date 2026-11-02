// 回答的 Markdown（解析在 lib/markdown.ts）：段落与列表用正文字号，标题加粗放大，行内代码与代码块用等宽字，表格可横向滚动，
// 链接点开系统浏览器（只开 http、https 与 mailto）。整段可选中复制。
//
// 还在写的回答（`streaming`）逐字放出（lib/reveal.ts，同桌面端的节奏），末尾没写完的语法先不露出来；每一帧只重画变了的块
// （按块的内容比较），长回答不卡。

import { Fragment, memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Block, type Inline, parseMarkdown, tableColumnWidths } from '../lib/markdown';
import { REVEAL_FRAME_MS, revealStep, streamSafe } from '../lib/reveal';
import { useReducedMotion } from '../state/reduced-motion';
import { RADIUS, TEXT, type Theme, useTheme } from '../theme';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const HEADING_SIZES = [22, 19, 17, 16, 16, 16];
// 表格格子：14 号字一个半角字约 7.6 点（表头加粗按这个也够），左右留白共 20；列宽夹在 56 与 240 之间，超出的换行。
const CELL_METRICS = { charWidth: 7.6, padding: 20, min: 56, max: 240 };

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const theme = useTheme();
  const shown = useStreamingReveal(text, streaming);
  const blocks = useMemo(
    () => parseMarkdown(shown === text && !streaming ? text : streamSafe(shown)),
    [shown, text, streaming],
  );
  // 块的内容作身份：前面写完的块每一帧都一样，不重画。
  const keys = useMemo(() => blocks.map((block) => JSON.stringify(block)), [blocks]);
  return (
    <View style={styles.blocks}>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 块没有别的标识，顺序就是身份
        <StableBlock key={index} block={block} signature={keys[index] ?? ''} theme={theme} />
      ))}
    </View>
  );
}

/**
 * 显示到哪里：挂上时整段显示（打开会话时已有的字不重放）；还在写或写完了还没放完时按帧放字，追上并写完以后就是全文。
 * 减弱动态效果时不放字。
 */
function useStreamingReveal(text: string, streaming: boolean): string {
  const reduced = useReducedMotion();
  // 没流出过的文字（卡片、发来的消息）变了也整段换，不放字。
  const [streamed, setStreamed] = useState(streaming);
  if (streaming && !streamed) setStreamed(true);
  const [length, setLength] = useState(text.length);
  const textRef = useRef(text);
  textRef.current = text;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const shownLength = Math.min(length, text.length);
  const running = !reduced && streamed && (streaming || shownLength < text.length);
  useEffect(() => {
    if (!running) return;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - last;
      last = now;
      const target = textRef.current;
      setLength((shown) =>
        revealStep(Math.min(shown, target.length), target, elapsed, !streamingRef.current),
      );
    }, REVEAL_FRAME_MS);
    return () => clearInterval(timer);
  }, [running]);
  if (reduced || !streamed) return text;
  return shownLength >= text.length ? text : text.slice(0, shownLength);
}

const StableBlock = memo(
  function StableBlock({ block, theme }: { block: Block; signature: string; theme: Theme }) {
    return <BlockView block={block} theme={theme} />;
  },
  (before, after) => before.signature === after.signature && before.theme === after.theme,
);

function BlockList({ blocks, theme }: { blocks: readonly Block[]; theme: Theme }) {
  return (
    <View style={styles.blocks}>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 块没有别的标识，顺序就是身份
        <BlockView key={index} block={block} theme={theme} />
      ))}
    </View>
  );
}

function BlockView({ block, theme }: { block: Block; theme: Theme }): ReactNode {
  switch (block.kind) {
    case 'heading':
      return (
        <Text
          style={[
            styles.heading,
            { color: theme.foreground, fontSize: HEADING_SIZES[block.level - 1] ?? TEXT.body },
          ]}
          selectable
          accessibilityRole="header"
        >
          <Spans inline={block.inline} theme={theme} />
        </Text>
      );
    case 'paragraph':
      return (
        <Text style={[styles.body, { color: theme.foreground }]} selectable>
          <Spans inline={block.inline} theme={theme} />
        </Text>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列表项没有别的标识
            <View key={index} style={styles.item}>
              <Text style={[styles.body, styles.marker, { color: theme.mutedForeground }]}>
                {item.checked !== undefined
                  ? item.checked
                    ? '☑'
                    : '☐'
                  : block.ordered
                    ? `${block.start + index}.`
                    : '•'}
              </Text>
              <View style={styles.itemBody}>
                <Text style={[styles.body, { color: theme.foreground }]} selectable>
                  <Spans inline={item.inline} theme={theme} />
                </Text>
                {item.children.length > 0 && <BlockList blocks={item.children} theme={theme} />}
              </View>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: theme.borderStrong }]}>
          <BlockList blocks={block.blocks} theme={theme} />
        </View>
      );
    case 'code':
      return (
        <ScrollView
          horizontal
          style={[styles.codeBlock, { backgroundColor: theme.muted }]}
          contentContainerStyle={styles.codeContent}
        >
          <Text style={[styles.codeText, { color: theme.foreground }]} selectable>
            {block.text}
          </Text>
        </ScrollView>
      );
    case 'table': {
      const widths = tableColumnWidths(block, CELL_METRICS);
      return (
        <ScrollView
          horizontal
          style={[styles.table, { borderColor: theme.border }]}
          showsHorizontalScrollIndicator={false}
        >
          <View>
            {[block.header, ...block.rows].map((row, rowIndex) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: 表格行没有别的标识
                key={rowIndex}
                style={[
                  styles.row,
                  rowIndex > 0 && { borderTopColor: theme.border, borderTopWidth: 1 },
                  rowIndex === 0 && { backgroundColor: theme.muted },
                ]}
              >
                {row.map((cell, cellIndex) => (
                  <Text
                    // biome-ignore lint/suspicious/noArrayIndexKey: 格子没有别的标识
                    key={cellIndex}
                    style={[
                      styles.cell,
                      {
                        color: theme.foreground,
                        width: widths[cellIndex],
                        textAlign: block.align[cellIndex] ?? 'left',
                      },
                      rowIndex === 0 && styles.headerCell,
                    ]}
                    selectable
                  >
                    <Spans inline={cell} theme={theme} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    case 'rule':
      return <View style={[styles.rule, { backgroundColor: theme.border }]} />;
  }
}

function Spans({ inline, theme }: { inline: readonly Inline[]; theme: Theme }) {
  return (
    <>
      {inline.map((span, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 行内片段没有别的标识
        <Fragment key={index}>{spanView(span, theme)}</Fragment>
      ))}
    </>
  );
}

function spanView(span: Inline, theme: Theme): ReactNode {
  switch (span.kind) {
    case 'text':
      return span.text;
    case 'code':
      return <Text style={[styles.code, { backgroundColor: theme.muted }]}>{span.text}</Text>;
    case 'strong':
      return (
        <Text style={styles.strong}>
          <Spans inline={span.children} theme={theme} />
        </Text>
      );
    case 'em':
      return (
        <Text style={styles.em}>
          <Spans inline={span.children} theme={theme} />
        </Text>
      );
    case 'del':
      return (
        <Text style={styles.del}>
          <Spans inline={span.children} theme={theme} />
        </Text>
      );
    case 'link':
      return (
        <Text
          style={[styles.link, { color: theme.running }]}
          onPress={
            /^(https?:|mailto:)/i.test(span.url) ? () => void Linking.openURL(span.url) : undefined
          }
          accessibilityRole="link"
        >
          <Spans inline={span.children} theme={theme} />
        </Text>
      );
  }
}

const styles = StyleSheet.create({
  blocks: { gap: 10 },
  body: { fontSize: TEXT.body, lineHeight: 23 },
  heading: { fontWeight: '600', lineHeight: 28 },
  list: { gap: 4 },
  item: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 16, textAlign: 'right', fontVariant: ['tabular-nums'] },
  itemBody: { flex: 1, gap: 4 },
  quote: { borderLeftWidth: 3, paddingLeft: 12 },
  codeBlock: { borderRadius: RADIUS.tile },
  codeContent: { padding: 12 },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  // 表格框贴着内容的宽度，宽过屏幕时横向滚动。
  table: {
    borderWidth: 1,
    borderRadius: RADIUS.tile,
    flexGrow: 0,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  row: { flexDirection: 'row' },
  cell: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: TEXT.small,
  },
  headerCell: { fontWeight: '600' },
  code: { fontFamily: MONO, fontSize: 14 },
  strong: { fontWeight: '600' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
  rule: { height: StyleSheet.hairlineWidth },
});
