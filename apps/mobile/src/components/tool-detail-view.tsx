// 工具一行点开后的内容（同桌面端 tool-details.tsx 与 file-preview.tsx）：修改与写文件按文件显示改动（行号、增删底色），别的是参数与
// 结果（退出码、截断说明）。每块最高约 240pt，里面竖向滚动，长行横向滚动不换行。数据来自 lib/tool-detail.ts。

import type { ChatPartOf } from '@wevir/client-sdk';
import { Fragment, type ReactNode, useMemo } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { displayLine } from '../lib/diff';
import { type FilePreview, toolDetail } from '../lib/tool-detail';
import { TEXT, type Theme } from '../theme';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
/** 一个文件的预览最多画多少行。 */
const MAX_LINES = 200;
const BLOCK_HEIGHT = 240;

export function ToolDetailView({ part, theme }: { part: ChatPartOf<'tool'>; theme: Theme }) {
  const detail = useMemo(() => toolDetail(part), [part]);
  if (detail.kind === 'previews') {
    return (
      <View style={styles.detail} testID="tool-detail">
        {detail.previews.map((preview, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 同一次改动里的文件列表不变。
          <PreviewBlock key={index} preview={preview} theme={theme} />
        ))}
        {detail.output !== undefined && <Pre text={detail.output} theme={theme} />}
      </View>
    );
  }
  return (
    <View style={styles.detail} testID="tool-detail">
      <Section label={t('tool.input')} theme={theme}>
        <Pre text={detail.input.text} theme={theme} />
        {detail.input.truncatedFrom !== undefined && (
          <Note theme={theme}>
            {t('tool.inputTruncated', { length: detail.input.truncatedFrom })}
          </Note>
        )}
      </Section>
      {detail.showOutput && (
        <Section label={t('tool.output')} theme={theme}>
          {detail.exitCode !== undefined && (
            <Text
              style={[
                styles.note,
                { color: detail.exitCode !== 0 ? theme.destructive : theme.mutedForeground },
              ]}
            >
              {t('tool.exitCode', { code: detail.exitCode })}
            </Text>
          )}
          {detail.output !== undefined && detail.output.text !== '' ? (
            <Pre text={detail.output.text} theme={theme} />
          ) : (
            <Note theme={theme}>{t('tool.noOutput')}</Note>
          )}
          {detail.output?.truncatedFrom !== undefined && (
            <Note theme={theme}>
              {t('tool.outputTruncated', { length: detail.output.truncatedFrom })}
            </Note>
          )}
        </Section>
      )}
    </View>
  );
}

function Section({ label, theme, children }: { label: string; theme: Theme; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: theme.mutedForeground }]}>{label}</Text>
      {children}
    </View>
  );
}

function Note({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <Text style={[styles.note, { color: theme.mutedForeground }]}>{children}</Text>;
}

/** 一段原文：等宽、可选中，过高时里面滚动。 */
function Pre({ text, theme }: { text: string; theme: Theme }) {
  return (
    <ScrollView
      style={[styles.block, { borderColor: theme.border, backgroundColor: theme.muted }]}
      contentContainerStyle={styles.pre}
      nestedScrollEnabled
    >
      <Text style={[styles.code, { color: theme.foreground }]} selectable>
        {text}
      </Text>
    </ScrollView>
  );
}

/** 一个文件的改动：标题行是路径，下面带行号的行，新增与删除有底色；超出的行写“另有 N 行”。 */
function PreviewBlock({ preview, theme }: { preview: FilePreview; theme: Theme }) {
  const lines = preview.lines.slice(0, MAX_LINES);
  const rest = preview.lines.length - lines.length;
  const numbered = lines.some((line) => line.number !== undefined);
  const digits = String(Math.max(0, ...lines.map((line) => line.number ?? 0))).length;
  const gutter = { width: numbered ? digits * 7.5 + 10 : 4, color: theme.mutedForeground };
  return (
    <View
      style={[styles.block, { borderColor: theme.border, backgroundColor: theme.card }]}
      testID="tool-preview"
    >
      {preview.path !== '' && (
        <Text
          style={[styles.path, { color: theme.mutedForeground, borderBottomColor: theme.border }]}
          numberOfLines={1}
          ellipsizeMode="head"
        >
          {preview.path}
        </Text>
      )}
      <ScrollView nestedScrollEnabled style={styles.previewScroll}>
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
          <View style={styles.previewLines}>
            {lines.map((line, index) => {
              const tint =
                line.kind === 'add'
                  ? theme.success
                  : line.kind === 'remove'
                    ? theme.destructive
                    : undefined;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: 行只按位置区分，内容变了整段重画。
                <Fragment key={index}>
                  {line.gap === true && (
                    <View style={styles.line}>
                      <Text style={[styles.code, styles.number, gutter]} />
                      <Text style={[styles.code, { color: theme.mutedForeground }]}>{'  ⋯'}</Text>
                    </View>
                  )}
                  <View
                    style={[styles.line, tint !== undefined && { backgroundColor: `${tint}1c` }]}
                  >
                    <Text style={[styles.code, styles.number, gutter]}>{line.number ?? ''}</Text>
                    <Text
                      style={[styles.code, styles.sign, { color: tint ?? theme.mutedForeground }]}
                    >
                      {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                    </Text>
                    <Text style={[styles.code, styles.text, { color: theme.foreground }]}>
                      {displayLine(line.text) || ' '}
                    </Text>
                  </View>
                </Fragment>
              );
            })}
            {rest > 0 && (
              <View style={styles.line}>
                <Text style={[styles.code, styles.number, gutter]} />
                <Text style={[styles.code, styles.text, { color: theme.mutedForeground }]}>
                  {t('tool.previewMore', { count: rest })}
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  detail: { gap: 10, marginTop: 6, marginLeft: 22, marginRight: 4 },
  section: { gap: 4 },
  label: { fontSize: TEXT.caption, fontWeight: '600' },
  note: { fontSize: TEXT.caption },
  block: {
    maxHeight: BLOCK_HEIGHT,
    borderRadius: 10,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pre: { paddingHorizontal: 10, paddingVertical: 8 },
  code: { fontFamily: MONO, fontSize: 12, lineHeight: 18 },
  path: {
    fontFamily: MONO,
    fontSize: TEXT.caption,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  previewScroll: { flexGrow: 0 },
  previewLines: { paddingVertical: 4, minWidth: '100%' },
  line: { flexDirection: 'row' },
  number: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  sign: { width: 18, textAlign: 'center' },
  text: { paddingRight: 12 },
});
