// 会话消息流里工具与回答之外的部件（同桌面端 message-view.tsx 等，只读）：标记行（重新连接、护栏、钩子、子智能体与任务的回报、
// 会话级提示，点开看理由，或打开那个会话）、分隔线（压缩上下文、章节）、清单、回答过的提问、交出的文件、建议的任务、第二意见、
// 审查发现。数据来自 lib/session-items.ts。

import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes, t } from '../i18n';
import type { LineIcon, SessionItem } from '../lib/session-items';
import { TEXT, type Theme } from '../theme';
import { Markdown } from './markdown';
import { Icon, type IconName } from './ui';

type ItemOf<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;

/** 点了打开另一个会话；没连着时没有。 */
export type OpenSession = ((sessionId: string) => void) | undefined;

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const LINE_ICONS: Record<LineIcon, IconName> = {
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
  guardrail: { ios: 'exclamationmark.shield', android: 'gpp_maybe' },
  hook: { ios: 'link', android: 'link' },
  agent: { ios: 'person.2', android: 'group' },
  done: { ios: 'checkmark.circle', android: 'check_circle' },
  failed: { ios: 'xmark.circle', android: 'cancel' },
  info: { ios: 'info.circle', android: 'info' },
  context: { ios: 'tray.full', android: 'inventory_2' },
};

const CHEVRON_RIGHT: IconName = { ios: 'chevron.right', android: 'chevron_right' };
const CHEVRON_DOWN: IconName = { ios: 'chevron.down', android: 'expand_more' };

/** 一行标记：图标、文字与对象；有原文时点开看，有会话时点它打开。 */
export function LineRow({
  item,
  theme,
  onOpenSession,
}: {
  item: ItemOf<'line'>;
  theme: Theme;
  onOpenSession: OpenSession;
}) {
  const [open, setOpen] = useState(false);
  const tone = item.tone !== undefined ? theme[item.tone] : theme.mutedForeground;
  const sessionId = item.sessionId;
  const opens = sessionId !== undefined && onOpenSession !== undefined;
  const expands = !opens && item.detail !== undefined;
  const onPress = opens
    ? () => onOpenSession(sessionId)
    : expands
      ? () => setOpen(!open)
      : undefined;
  return (
    <View testID="session-line">
      <Pressable
        accessibilityRole={onPress !== undefined ? 'button' : undefined}
        {...(expands && { accessibilityState: { expanded: open } })}
        disabled={onPress === undefined}
        onPress={onPress}
        hitSlop={6}
        style={({ pressed }) => [
          styles.line,
          item.center === true && styles.center,
          { opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <Icon name={LINE_ICONS[item.icon]} size={14} color={tone} />
        <Text
          style={[styles.lineText, item.center === true && styles.centerText]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          <Text style={{ color: item.tone !== undefined ? tone : theme.softForeground }}>
            {item.text}
          </Text>
          {item.target !== undefined && item.target !== '' && (
            <Text style={[styles.mono, { color: theme.mutedForeground }]}>{` ${item.target}`}</Text>
          )}
        </Text>
        {(opens || expands) && (
          <Icon
            name={open ? CHEVRON_DOWN : CHEVRON_RIGHT}
            size={11}
            weight="semibold"
            color={theme.mutedForeground}
          />
        )}
      </Pressable>
      {open && item.detail !== undefined && (
        <Text style={[styles.detail, { color: theme.mutedForeground }]} selectable>
          {item.detail}
        </Text>
      )}
    </View>
  );
}

/** 分隔线：章节标题在左、横线向右；压缩上下文文字居中、两边横线。 */
export function DividerRow({ item, theme }: { item: ItemOf<'divider'>; theme: Theme }) {
  const rule = <View style={[styles.rule, { backgroundColor: theme.border }]} />;
  if (item.chapter === true) {
    return (
      <View style={[styles.divider, styles.chapter]} testID="session-chapter">
        <Text style={[styles.chapterText, { color: theme.foreground }]} numberOfLines={1}>
          {item.text}
        </Text>
        {rule}
      </View>
    );
  }
  return (
    <View style={styles.divider} testID="session-compaction">
      {rule}
      <Text style={[styles.dividerText, { color: theme.mutedForeground }]} numberOfLines={1}>
        {item.text}
      </Text>
      {rule}
    </View>
  );
}

const TODO_MARKS: Record<string, IconName> = {
  completed: { ios: 'checkmark.square', android: 'check_box' },
  in_progress: { ios: 'circle.lefthalf.filled', android: 'contrast' },
};
const TODO_OPEN: IconName = { ios: 'square', android: 'check_box_outline_blank' };

/** Agent 的清单（同桌面端）：做完的划掉。 */
export function TodoCard({ item, theme }: { item: ItemOf<'todo'>; theme: Theme }) {
  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.card }]}>
      <Text style={[styles.cardTitle, { color: theme.mutedForeground }]}>{t('todo.title')}</Text>
      {item.items.map((entry, index) => {
        const done = entry.status === 'completed';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 清单整体替换，没有稳定 ID。
          <View key={index} style={styles.todoRow}>
            <Icon
              name={TODO_MARKS[entry.status] ?? TODO_OPEN}
              size={14}
              color={entry.status === 'in_progress' ? theme.running : theme.mutedForeground}
            />
            <Text
              style={[
                styles.todoText,
                { color: done ? theme.mutedForeground : theme.foreground },
                done && styles.struck,
              ]}
            >
              {entry.content}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** 回答过的提问（同桌面端）：每题一行“题目 → 回答”，取消时一行说明，超时按推荐回答的多一行。 */
export function AnswersRow({ item, theme }: { item: ItemOf<'answers'>; theme: Theme }) {
  if (item.cancelled === true) {
    return (
      <Text style={[styles.note, { color: theme.mutedForeground }]}>{t('question.cancelled')}</Text>
    );
  }
  return (
    <View style={[styles.answers, { borderColor: theme.border }]} testID="session-answers">
      {item.rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 题目的顺序固定。
        <Text key={index} style={styles.answerText}>
          <Text style={{ color: theme.mutedForeground }}>{`${row.question}  →  `}</Text>
          <Text
            style={{ color: row.answer !== undefined ? theme.foreground : theme.mutedForeground }}
          >
            {row.answer ?? t('question.skipped')}
          </Text>
        </Text>
      ))}
      {item.timedOut === true && (
        <Text style={[styles.caption, { color: theme.mutedForeground }]}>
          {t('question.timedOut')}
        </Text>
      )}
    </View>
  );
}

/** 文件的类型：扩展名大写。 */
function fileType(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : undefined;
}

/** Agent 交给用户的文件：每个一行，文件名，下面是大小与类型（文件在电脑上，手机上不打开）。 */
export function FilesCard({ item, theme }: { item: ItemOf<'files'>; theme: Theme }) {
  return (
    <View
      style={[styles.card, styles.list, { borderColor: theme.border, backgroundColor: theme.card }]}
      testID="session-files"
    >
      {item.files.map((file, index) => (
        <View
          key={file.path}
          style={[
            styles.fileRow,
            index > 0 && { borderTopColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth },
          ]}
        >
          <View style={[styles.fileIcon, { backgroundColor: theme.muted }]}>
            <Icon
              name={{ ios: 'doc', android: 'description' }}
              size={15}
              color={theme.mutedForeground}
            />
          </View>
          <View style={styles.fileText}>
            <Text style={[styles.body, { color: theme.foreground }]} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={[styles.caption, { color: theme.mutedForeground }]} numberOfLines={1}>
              {[formatBytes(file.size), fileType(file.name)].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const TASK_STATUS = {
  completed: 'suggest.completed',
  failed: 'suggest.failed',
  interrupted: 'suggest.failed',
  cancelled: 'suggest.cancelled',
} as const;

/** 建议的后续任务：标题与理由，开始过的写状态，点它打开那个会话（在手机上不开新任务）。 */
export function TasksCard({
  item,
  theme,
  onOpenSession,
}: {
  item: ItemOf<'tasks'>;
  theme: Theme;
  onOpenSession: OpenSession;
}) {
  return (
    <View
      style={[styles.card, styles.list, { borderColor: theme.border, backgroundColor: theme.card }]}
      testID="session-tasks"
    >
      <Text style={[styles.cardTitle, styles.listTitle, { color: theme.mutedForeground }]}>
        {t('suggest.title', { count: item.tasks.length })}
      </Text>
      {item.tasks.map((task) => {
        const sessionId = task.sessionId;
        const status =
          task.status === 'suggested'
            ? undefined
            : task.status === 'started'
              ? t('suggest.running')
              : t(TASK_STATUS[task.outcome ?? 'completed']);
        const failed = task.outcome === 'failed' || task.outcome === 'interrupted';
        const press =
          sessionId !== undefined && onOpenSession !== undefined
            ? () => onOpenSession(sessionId)
            : undefined;
        return (
          <Pressable
            key={task.id}
            disabled={press === undefined}
            onPress={press}
            accessibilityRole={press !== undefined ? 'button' : undefined}
            style={({ pressed }) => [
              styles.taskRow,
              { borderTopColor: theme.border, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <View style={styles.fileText}>
              <Text style={[styles.body, { color: theme.foreground }]} numberOfLines={2}>
                {task.title}
              </Text>
              {task.reason !== undefined && task.reason !== '' && (
                <Text style={[styles.caption, { color: theme.mutedForeground }]} numberOfLines={2}>
                  {task.reason}
                </Text>
              )}
            </View>
            {status !== undefined && (
              <Text
                style={[
                  styles.caption,
                  { color: failed ? theme.destructive : theme.mutedForeground },
                ]}
              >
                {status}
              </Text>
            )}
            {press !== undefined && (
              <Icon
                name={CHEVRON_RIGHT}
                size={11}
                weight="semibold"
                color={theme.mutedForeground}
              />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** 第二意见：标题行“第二意见 · 模型”与状态，好了之后是意见全文（可收起），下面“打开会话”。 */
export function OpinionCard({
  item,
  theme,
  onOpenSession,
}: {
  item: ItemOf<'opinion'>;
  theme: Theme;
  onOpenSession: OpenSession;
}) {
  const { opinion } = item;
  const [open, setOpen] = useState(true);
  const failed = opinion.status === 'failed';
  const status =
    opinion.status === 'running'
      ? t('opinion.running')
      : failed
        ? t(opinion.outcome === 'cancelled' ? 'opinion.cancelled' : 'opinion.failed')
        : opinion.quoted !== undefined
          ? t('opinion.quoted')
          : undefined;
  const text = opinion.text;
  return (
    <View
      style={[styles.card, styles.list, { borderColor: theme.border, backgroundColor: theme.card }]}
      testID="session-opinion"
    >
      <Pressable
        accessibilityRole="button"
        disabled={text === undefined}
        {...(text !== undefined && { accessibilityState: { expanded: open } })}
        onPress={() => setOpen(!open)}
        style={styles.cardHeader}
      >
        <Icon
          name={{ ios: 'bubble.left.and.bubble.right', android: 'forum' }}
          size={14}
          color={theme.mutedForeground}
        />
        <Text style={[styles.headerText, { color: theme.softForeground }]} numberOfLines={1}>
          {`${t('opinion.title')} · ${opinion.modelId}`}
        </Text>
        {status !== undefined && (
          <Text
            style={[styles.caption, { color: failed ? theme.destructive : theme.mutedForeground }]}
          >
            {status}
          </Text>
        )}
        {text !== undefined && (
          <Icon
            name={open ? CHEVRON_DOWN : CHEVRON_RIGHT}
            size={11}
            weight="semibold"
            color={theme.mutedForeground}
          />
        )}
      </Pressable>
      {open && text !== undefined && (
        <View style={[styles.cardBody, { borderTopColor: theme.border }]}>
          <Markdown text={text} />
        </View>
      )}
      {onOpenSession !== undefined && (
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpenSession(opinion.sessionId)}
          style={({ pressed }) => [
            styles.cardFooter,
            { borderTopColor: theme.border, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Text style={[styles.caption, { color: theme.mutedForeground }]}>
            {t('opinion.open')}
          </Text>
          <Icon name={CHEVRON_RIGHT} size={11} weight="semibold" color={theme.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

/** 一条发现的位置：`路径:起-止`，定位不到文件时是报的原文。 */
function findingLocation(finding: ItemOf<'findings'>['findings'][number]): string | undefined {
  if (finding.path === undefined) return finding.location;
  if (finding.startLine === undefined) return finding.path;
  const end =
    finding.endLine !== undefined && finding.endLine !== finding.startLine
      ? `-${finding.endLine}`
      : '';
  return `${finding.path}:${finding.startLine}${end}`;
}

/** 审查发现：标题行“审查发现 · N”，总体说明，每条一行严重度、标题与位置，点开看说明（在手机上只看，修复在电脑上做）。 */
export function FindingsCard({ item, theme }: { item: ItemOf<'findings'>; theme: Theme }) {
  const [open, setOpen] = useState<number>();
  return (
    <View
      style={[styles.card, styles.list, { borderColor: theme.border, backgroundColor: theme.card }]}
      testID="session-findings"
    >
      <View style={styles.cardHeader}>
        <Icon
          name={{ ios: 'text.magnifyingglass', android: 'manage_search' }}
          size={14}
          color={theme.mutedForeground}
        />
        <Text style={[styles.headerText, { color: theme.softForeground }]} numberOfLines={1}>
          {`${t('findings.title')} · ${item.findings.length}`}
        </Text>
      </View>
      {item.summary !== undefined && (
        <View style={[styles.cardBody, { borderTopColor: theme.border }]}>
          <Markdown text={item.summary} />
        </View>
      )}
      {item.findings.map((finding, index) => {
        const location = findingLocation(finding);
        const expanded = open === index;
        const urgent = finding.priority !== undefined && finding.priority <= 1;
        return (
          <Pressable
            // biome-ignore lint/suspicious/noArrayIndexKey: 发现的顺序固定。
            key={index}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            disabled={finding.body.trim() === ''}
            onPress={() => setOpen(expanded ? undefined : index)}
            style={[styles.findingRow, { borderTopColor: theme.border }]}
          >
            <View style={styles.findingHead}>
              {finding.priority !== undefined && (
                <Text
                  style={[
                    styles.priority,
                    {
                      color: urgent ? theme.destructive : theme.mutedForeground,
                      borderColor: urgent ? theme.destructive : theme.border,
                    },
                  ]}
                >
                  {`P${finding.priority}`}
                </Text>
              )}
              <Text style={[styles.body, styles.findingTitle, { color: theme.foreground }]}>
                {finding.title}
              </Text>
            </View>
            {location !== undefined && (
              <Text
                style={[styles.mono, styles.caption, { color: theme.mutedForeground }]}
                numberOfLines={1}
                ellipsizeMode="head"
              >
                {location}
              </Text>
            )}
            {expanded && <Markdown text={finding.body} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  center: { justifyContent: 'center' },
  lineText: { flexShrink: 1, fontSize: TEXT.small },
  centerText: { fontSize: TEXT.caption },
  mono: { fontFamily: MONO, fontSize: TEXT.caption },
  detail: {
    fontFamily: MONO,
    fontSize: TEXT.caption,
    lineHeight: 18,
    marginTop: 4,
    paddingLeft: 26,
    paddingRight: 4,
  },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  chapter: { paddingTop: 10 },
  rule: { flex: 1, minWidth: 24, height: StyleSheet.hairlineWidth },
  dividerText: { flexShrink: 1, fontSize: TEXT.small },
  chapterText: { flexShrink: 1, fontSize: TEXT.small, fontWeight: '600' },
  card: {
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  list: { paddingHorizontal: 0, paddingVertical: 0, gap: 0, overflow: 'hidden' },
  cardTitle: { fontSize: TEXT.caption, fontWeight: '600', marginBottom: 2 },
  listTitle: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6, marginBottom: 0 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: 12,
  },
  headerText: { flex: 1, fontSize: TEXT.small },
  cardBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    minHeight: 36,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  todoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 2 },
  todoText: { flex: 1, fontSize: TEXT.small, lineHeight: 20 },
  struck: { textDecorationLine: 'line-through' },
  answers: { borderLeftWidth: 2, paddingLeft: 10, marginLeft: 4, gap: 3 },
  answerText: { fontSize: TEXT.small, lineHeight: 20 },
  note: { fontSize: TEXT.small, paddingHorizontal: 4 },
  caption: { fontSize: TEXT.caption },
  body: { fontSize: TEXT.small },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 12,
  },
  fileIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileText: { flex: 1, gap: 2 },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  findingRow: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  findingHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  findingTitle: { flex: 1, lineHeight: 20 },
  priority: {
    fontSize: 11,
    fontWeight: '600',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 5,
    paddingHorizontal: 4,
    marginTop: 1,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },
});
