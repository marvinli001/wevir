// 回答的 Markdown（解析在 lib/markdown.ts）：段落与列表用正文字号，标题加粗放大，行内代码与代码块用等宽字，表格可横向滚动，
// 链接点开系统浏览器（只开 http、https 与 mailto）。整段可选中复制。

import { Fragment, type ReactNode, useMemo } from 'react';
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Block, type Inline, parseMarkdown, tableColumnWidths } from '../lib/markdown';
import { RADIUS, TEXT, type Theme, useTheme } from '../theme';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
const HEADING_SIZES = [22, 19, 17, 16, 16, 16];
// 表格格子：14 号字一个半角字约 7.6 点（表头加粗按这个也够），左右留白共 20；列宽夹在 56 与 240 之间，超出的换行。
const CELL_METRICS = { charWidth: 7.6, padding: 20, min: 56, max: 240 };

export function Markdown({ text }: { text: string }) {
  const theme = useTheme();
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <BlockList blocks={blocks} theme={theme} />;
}

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
