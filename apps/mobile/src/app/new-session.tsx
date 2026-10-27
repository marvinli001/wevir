// 新建会话：多台电脑时先选电脑；项目（或不在项目里的对话）、同目录或新工作树、来源与模型、思考力度、权限模式，最后写第一条消息，
// “开始”后建会话并发出，打开会话页。这台手机没有“查看模型服务”或“发消息”的权限时只说明要在电脑上新建。页面是系统的表单卡片。

import { getRandomBytes } from 'expo-crypto';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useActionSheet } from '../components/sheets';
import { Button, Group, Icon, Row, Segmented } from '../components/ui';
import { type MessageKey, t } from '../i18n';
import {
  createErrorKey,
  effortsOf,
  loadOptions,
  type ModelChoice,
  modelName,
  modelsOf,
  type NewSessionOptions,
  PHONE_PERMISSION_MODES,
  type PhonePermissionMode,
  providerTitle,
  resolveChoice,
  startSession,
} from '../lib/new-session';
import { displayName } from '../lib/records';
import { clientMessageId } from '../lib/session-actions';
import { useComputers, useRegistry } from '../state/registry';
import { SPACE, TEXT, useTheme } from '../theme';

const EFFORT_KEYS: Record<string, MessageKey> = {
  off: 'effort.off',
  minimal: 'effort.minimal',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
};

function effortLabel(effort: string | undefined): string {
  if (effort === undefined) return t('effort.default');
  const key = EFFORT_KEYS[effort];
  return key !== undefined ? t(key) : effort;
}

export default function NewSessionScreen() {
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const params = useLocalSearchParams<{ computer?: string }>();
  const { computers } = useComputers();
  const online = computers.filter((c) => c.status.kind === 'online');
  const [computer, setComputer] = useState(
    params.computer ?? online[0]?.record.name ?? computers[0]?.record.name,
  );
  const snapshot = computers.find((c) => c.record.name === computer);
  const client = snapshot !== undefined ? registry.link(snapshot.record.name)?.sessions : undefined;
  const [options, setOptions] = useState<NewSessionOptions>();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [newWorktree, setNewWorktree] = useState(false);
  const [choice, setChoice] = useState<ModelChoice>();
  const [permissionMode, setPermissionMode] = useState<PhonePermissionMode>('on_request');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const [sheet, showSheet] = useActionSheet();

  useEffect(() => {
    setOptions(undefined);
    if (client === undefined) return;
    let stopped = false;
    void loadOptions(client).then((result) => {
      if (stopped) return;
      setOptions(result);
      if (result.kind === 'ready') {
        setChoice((previous) => resolveChoice(result.providers, previous));
        setWorkspaceId((previous) =>
          previous !== undefined && result.workspaces.some((w) => w.id === previous)
            ? previous
            : result.features.chats
              ? undefined
              : result.workspaces[0]?.id,
        );
      }
    });
    return () => {
      stopped = true;
    };
  }, [client]);

  const ready = options?.kind === 'ready' ? options : undefined;
  const provider = ready?.providers.find((p) => p.id === choice?.providerId);
  const model =
    provider !== undefined ? modelsOf(provider).find((m) => m.id === choice?.modelId) : undefined;
  const efforts = useMemo(
    () => (ready !== undefined ? effortsOf(ready.providers, choice) : []),
    [ready, choice],
  );
  const workspace = ready?.workspaces.find((w) => w.id === workspaceId);
  const canStart =
    ready !== undefined &&
    choice !== undefined &&
    text.trim() !== '' &&
    !busy &&
    (workspaceId !== undefined || ready.features.chats);

  const start = async () => {
    if (!canStart || client === undefined || ready === undefined || choice === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const { session } = await startSession(
        client,
        {
          ...(workspaceId !== undefined && { workspaceId: workspaceId as never }),
          newWorktree,
          choice,
          permissionMode,
        },
        ready.features,
        text.trim(),
        clientMessageId(getRandomBytes),
      );
      router.dismissTo({
        pathname: '/session/[key]',
        params: { key: `${snapshot?.record.name}/${session.id}` },
      });
    } catch (e) {
      console.warn('[wevir] could not create session', e);
      setError(createErrorKey(e));
      setBusy(false);
    }
  };

  const pickProject = () => {
    if (ready === undefined) return;
    showSheet(
      [
        ...(ready.features.chats
          ? [{ label: t('newSession.chat'), onPress: () => setWorkspaceId(undefined) }]
          : []),
        ...ready.workspaces.map((w) => ({
          label: w.displayName || w.rootPath,
          onPress: () => setWorkspaceId(w.id),
        })),
      ],
      t('newSession.project'),
    );
  };

  const pickProvider = () => {
    if (ready === undefined) return;
    showSheet(
      ready.providers.map((p) => ({
        label: providerTitle(p, ready.accounts),
        onPress: () => setChoice(resolveChoice([p], undefined)),
      })),
      t('newSession.source'),
    );
  };

  const pickModel = () => {
    if (provider === undefined) return;
    showSheet(
      modelsOf(provider).map((m) => ({
        label: modelName(m),
        onPress: () => setChoice({ providerId: provider.id, modelId: m.id }),
      })),
      t('newSession.model'),
    );
  };

  const pickEffort = () => {
    if (choice === undefined) return;
    showSheet(
      [undefined, ...efforts].map((effort) => ({
        label: effortLabel(effort),
        onPress: () =>
          setChoice({
            providerId: choice.providerId,
            modelId: choice.modelId,
            ...(effort !== undefined && { reasoningEffort: effort }),
          }),
      })),
      t('newSession.effort'),
    );
  };

  const value = (label: string) => (
    <Text style={[styles.value, { color: theme.mutedForeground }]} numberOfLines={1}>
      {label}
    </Text>
  );

  return (
    <>
      {Platform.OS === 'ios' && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            accessibilityLabel={t('newBot.cancel')}
            onPress={() => router.back()}
          />
        </Stack.Toolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {computers.length > 1 && computer !== undefined && (
          <View style={styles.section}>
            <Text style={[styles.label, { color: theme.mutedForeground }]}>
              {t('newBot.computer')}
            </Text>
            <Segmented
              options={computers.map((c) => ({
                value: c.record.name,
                label: displayName(c.record),
              }))}
              value={computer}
              disabled={busy}
              onChange={setComputer}
            />
          </View>
        )}

        {client === undefined ? (
          <Notice icon="offline" text={t('newSession.offline')} />
        ) : options === undefined ? (
          <ActivityIndicator style={styles.loading} color={theme.mutedForeground} />
        ) : options.kind === 'forbidden' ? (
          <Notice icon="lock" text={t('newSession.computerOnly')} />
        ) : options.kind === 'failed' ? (
          <Notice icon="offline" text={t('newSession.loadFailed')} />
        ) : options.providers.length === 0 ? (
          <Notice icon="lock" text={t('newSession.noSources')} />
        ) : (
          <>
            <Group style={styles.group}>
              <Row
                icon={{ ios: 'folder', android: 'folder' }}
                title={t('newSession.project')}
                trailing={value(
                  workspace !== undefined
                    ? workspace.displayName || workspace.rootPath
                    : t('newSession.chat'),
                )}
                onPress={pickProject}
              />
              <Row
                icon={{ ios: 'square.stack.3d.up', android: 'stacks' }}
                title={t('newSession.source')}
                trailing={value(
                  provider !== undefined ? providerTitle(provider, options.accounts) : '',
                )}
                onPress={pickProvider}
              />
              <Row
                icon={{ ios: 'cpu', android: 'memory' }}
                title={t('newSession.model')}
                trailing={value(model !== undefined ? modelName(model) : (choice?.modelId ?? ''))}
                onPress={pickModel}
              />
              <Row
                last
                icon={{ ios: 'gauge.with.dots.needle.50percent', android: 'speed' }}
                title={t('newSession.effort')}
                trailing={value(effortLabel(choice?.reasoningEffort))}
                onPress={efforts.length > 0 ? pickEffort : undefined}
              />
            </Group>

            {workspace !== undefined && options.features.worktree && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.mutedForeground }]}>
                  {t('newSession.location')}
                </Text>
                <Segmented
                  options={[
                    { value: 'same', label: t('newSession.sameFolder') },
                    { value: 'worktree', label: t('newSession.newWorktree') },
                  ]}
                  value={newWorktree ? 'worktree' : 'same'}
                  disabled={busy}
                  onChange={(v) => setNewWorktree(v === 'worktree')}
                />
              </View>
            )}

            {options.features.permissionModes && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: theme.mutedForeground }]}>
                  {t('newSession.permission')}
                </Text>
                <Segmented
                  options={PHONE_PERMISSION_MODES.map((mode) => ({
                    value: mode,
                    label: t(`permission.${mode}`),
                  }))}
                  value={permissionMode}
                  disabled={busy}
                  onChange={setPermissionMode}
                />
              </View>
            )}

            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={t('newSession.message')}
              placeholderTextColor={theme.mutedForeground}
              multiline
              editable={!busy}
              selectionColor={theme.foreground}
              style={[styles.message, { color: theme.foreground, backgroundColor: theme.card }]}
              testID="new-session-message"
            />

            {error !== undefined && (
              <Text style={[styles.error, { color: theme.destructive }]}>{t(error)}</Text>
            )}

            <View style={styles.start}>
              <Button
                title={t('newSession.start')}
                disabled={!canStart}
                onPress={() => void start()}
              />
            </View>
          </>
        )}
      </ScrollView>
      {sheet}
    </>
  );
}

function Notice({ icon, text }: { icon: 'lock' | 'offline'; text: string }) {
  const theme = useTheme();
  return (
    <View style={styles.notice}>
      <Icon
        name={
          icon === 'lock'
            ? { ios: 'lock.laptopcomputer', android: 'lock' }
            : { ios: 'wifi.slash', android: 'wifi_off' }
        }
        size={28}
        color={theme.mutedForeground}
      />
      <Text style={[styles.noticeText, { color: theme.softForeground }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE.page, paddingBottom: 48, gap: 20 },
  section: { gap: 8 },
  group: { marginTop: 4 },
  label: { fontSize: TEXT.small, fontWeight: '600', marginHorizontal: 6 },
  value: { fontSize: TEXT.small, maxWidth: 180 },
  loading: { marginTop: 48 },
  message: {
    minHeight: 120,
    fontSize: TEXT.body,
    lineHeight: 22,
    borderRadius: 20,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
    textAlignVertical: 'top',
  },
  error: { fontSize: TEXT.small, marginHorizontal: 6 },
  start: { marginTop: 4 },
  notice: { alignItems: 'center', gap: 12, paddingTop: 48, paddingHorizontal: 24 },
  noticeText: { fontSize: TEXT.body, lineHeight: 22, textAlign: 'center' },
});
