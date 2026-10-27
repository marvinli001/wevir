// 只读的代码视图：diff（两列行号、增删底色、`@@` 段头）与完整文件（一列行号）共用。竖向是虚拟化的 FlatList（行高固定），
// 外面套一层横向的 ScrollView，宽度按最长的一行算，长行横向滚动而不换行。

import { type ReactElement, useMemo } from 'react';
import {
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { type DiffRow, displayLine, widestLine } from '../lib/diff';
import { TEXT, type Theme } from '../theme';

const FONT = Platform.select({ ios: 'Menlo', default: 'monospace' });
const FONT_SIZE = 12;
/** 等宽字体一格的宽度（Menlo / Roboto Mono 约 0.6 em），略放宽一点免得最后几个字被裁。 */
const CHAR_WIDTH = FONT_SIZE * 0.62;
const LINE_HEIGHT = 18;
const PADDING = 12;

export interface CodeViewProps {
  rows: readonly DiffRow[];
  /** `diff` 两列行号与增删标记；`file` 一列行号（`newLine`）。 */
  mode: 'diff' | 'file';
  theme: Theme;
  header?: ReactElement | null;
  footer?: ReactElement | null;
  onEndReached?: () => void;
  /** 底部浮着的工具栏占的高度。 */
  bottomInset: number;
}

export function CodeView({
  rows,
  mode,
  theme,
  header,
  footer,
  onEndReached,
  bottomInset,
}: CodeViewProps) {
  const { width: screen } = useWindowDimensions();
  const lines = useMemo(() => rows.map((row) => displayLine(row.text)), [rows]);
  const digits = useMemo(() => {
    let max = 0;
    for (const row of rows) {
      if (row.kind === 'hunk' || row.kind === 'note') continue;
      max = Math.max(max, row.oldLine ?? 0, row.newLine ?? 0);
    }
    return Math.max(2, String(max).length);
  }, [rows]);
  const numberWidth = digits * CHAR_WIDTH + 10;
  const gutter = mode === 'diff' ? numberWidth * 2 + CHAR_WIDTH * 2 : numberWidth + 6;
  const width = Math.max(screen, gutter + widestLine(lines) * CHAR_WIDTH + PADDING * 2);

  return (
    <ScrollView
      horizontal
      contentInsetAdjustmentBehavior="never"
      showsHorizontalScrollIndicator={false}
      bounces={false}
    >
      <FlatList
        style={{ width }}
        data={rows}
        keyExtractor={(_, index) => String(index)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: bottomInset + 16 }}
        scrollIndicatorInsets={{ bottom: bottomInset }}
        getItemLayout={(_, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index, index })}
        initialNumToRender={60}
        maxToRenderPerBatch={80}
        windowSize={11}
        onEndReached={onEndReached}
        onEndReachedThreshold={2}
        ListHeaderComponent={
          header !== undefined && header !== null ? (
            <View style={{ width: screen }}>{header}</View>
          ) : undefined
        }
        ListFooterComponent={
          footer !== undefined && footer !== null ? (
            <View style={{ width: screen }}>{footer}</View>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <Line
            row={item}
            text={lines[index] ?? ''}
            mode={mode}
            numberWidth={numberWidth}
            theme={theme}
          />
        )}
      />
    </ScrollView>
  );
}

function Line({
  row,
  text,
  mode,
  numberWidth,
  theme,
}: {
  row: DiffRow;
  text: string;
  mode: 'diff' | 'file';
  numberWidth: number;
  theme: Theme;
}) {
  if (row.kind === 'hunk') {
    return (
      <View style={[styles.line, { backgroundColor: theme.muted }]}>
        <Text
          style={[styles.code, styles.hunk, { color: theme.mutedForeground }]}
          numberOfLines={1}
        >
          {text}
        </Text>
      </View>
    );
  }
  if (row.kind === 'note') {
    return (
      <View style={styles.line}>
        <Text
          style={[styles.code, styles.hunk, { color: theme.mutedForeground }]}
          numberOfLines={1}
        >
          {text}
        </Text>
      </View>
    );
  }
  const tint =
    row.kind === 'add' ? theme.success : row.kind === 'remove' ? theme.destructive : undefined;
  const number = { width: numberWidth, color: theme.mutedForeground };
  return (
    <View style={[styles.line, tint !== undefined && { backgroundColor: `${tint}1c` }]}>
      {mode === 'diff' && (
        <Text style={[styles.code, styles.number, number]}>{row.oldLine ?? ''}</Text>
      )}
      <Text style={[styles.code, styles.number, number]}>{row.newLine ?? ''}</Text>
      {mode === 'diff' && (
        <Text style={[styles.code, styles.sign, { color: tint ?? theme.mutedForeground }]}>
          {row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}
        </Text>
      )}
      <Text style={[styles.code, styles.text, { color: theme.foreground }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** 增删行数：绿色的 +N、红色的 −N。 */
export function Counts({
  added,
  removed,
  theme,
}: {
  added: number | undefined;
  removed: number | undefined;
  theme: Theme;
}) {
  return (
    <>
      {added !== undefined && <Text style={{ color: theme.success }}>+{added}</Text>}
      {added !== undefined && removed !== undefined && ' '}
      {removed !== undefined && <Text style={{ color: theme.destructive }}>−{removed}</Text>}
    </>
  );
}

/** 文件状态字母的颜色：新增绿、删除红、其余（修改、重命名）琥珀。 */
export function statusColor(theme: Theme, status: string): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return theme.success;
    case 'deleted':
      return theme.destructive;
    default:
      return theme.warning;
  }
}

const styles = StyleSheet.create({
  line: { height: LINE_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingLeft: 6 },
  code: { fontFamily: FONT, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT },
  number: { textAlign: 'right', paddingRight: 6, fontVariant: ['tabular-nums'] },
  sign: { width: CHAR_WIDTH * 2, textAlign: 'center' },
  text: { paddingRight: PADDING },
  hunk: { paddingHorizontal: PADDING, fontSize: TEXT.caption - 1 },
});
