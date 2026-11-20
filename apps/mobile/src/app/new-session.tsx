// 新建会话：打开就是输入栏（键盘弹起、能听写、能加照片），写完点发送就建会话并发出，打开会话页。输入栏上面一排选项胶囊，点一下从胶囊处
// 展开菜单：电脑（多台时）、项目（或不在项目里的对话，带同目录 / 新工作树）、权限。模型在输入栏里（components/model-picker.tsx：
// 点开是力度条，再进“配置”换引擎与账号、模型、速度）。每台电脑上次的选择记在手机上，下次照用；从会话页打开时预选那个会话的项目。
// 这台手机没有“查看模型服务”或“发消息”的权限时只说明要在电脑上新建。

import { ConnectionLostError, isRpcError, sendOutcomeUnknown } from '@wevir/client-sdk';
import type { Session, UserImageMimeType } from '@wevir/protocol';
import { getRandomBytes } from 'expo-crypto';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Composer } from '../components/composer';
import { type MenuSection, MenuTrigger } from '../components/menu';
import { ModelPicker } from '../components/model-picker';
import { Icon, type IconName } from '../components/ui';
import { type MessageKey, t } from '../i18n';
import { keyboardOverlap } from '../lib/keyboard';
import {
  createErrorKey,
  initialDraft,
  loadOptions,
  type ModelChoice,
  type NewSessionMemory,
  type NewSessionOptions,
  PHONE_PERMISSION_MODES,
  type PhonePermissionMode,
  rememberDraft,
  startSession,
} from '../lib/new-session';
import { displayName } from '../lib/records';
import { messageContent } from '../lib/session-actions';
import { SessionWatch } from '../lib/session-watch';
import { loadNewSessionMemory, saveNewSessionMemory } from '../lib/storage';
import { acknowledgeDraft, bindDraftSession, loadDraft } from '../state/drafts';
import { usePhotoAttachments } from '../state/photo-attachments';
import { useComputers, useRegistry } from '../state/registry';
import { SPACE, TEXT, useTheme } from '../theme';

export default function NewSessionScreen() {
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ computer?: string; workspace?: string }>();
  const { computers } = useComputers();
  const [memory, setMemory] = useState<NewSessionMemory>();
  const [computer, setComputer] = useState(params.computer);
  const snapshot = computers.find((c) => c.record.name === computer);
  const client = snapshot !== undefined ? registry.link(snapshot.record.name)?.sessions : undefined;
  const [options, setOptions] = useState<NewSessionOptions>();
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [newWorktree, setNewWorktree] = useState(false);
  const [choice, setChoice] = useState<ModelChoice>();
  const [permissionMode, setPermissionMode] = useState<PhonePermissionMode>('on_request');
  const [error, setError] = useState<MessageKey>();
  /** 建好了、第一条消息没发出的会话：再发时发进它。换了电脑、项目、模型或权限就作废（重新建）。 */
  const created = useRef<{ computer: string; session: Session }>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 选项一变就作废
  useEffect(() => {
    created.current = undefined;
  }, [computer, workspaceId, newWorktree, choice, permissionMode]);
  const [keyboard, setKeyboard] = useState(0);
  // 从会话页带来的项目只在第一次读到这台电脑的选项时用；换了电脑就不再管它。
  const requested = useRef(params.workspace);

  useEffect(() => {
    void loadNewSessionMemory().then(setMemory);
  }, []);

  // 没指定电脑时：上次用的那台（还在、在线），否则第一台在线的，否则第一台。
  useEffect(() => {
    if (computer !== undefined || memory === undefined) return;
    const online = computers.filter((c) => c.status.kind === 'online');
    const last = online.find((c) => c.record.name === memory.computer);
    setComputer((last ?? online[0] ?? computers[0])?.record.name);
  }, [computer, memory, computers]);

  useEffect(() => {
    setOptions(undefined);
    if (client === undefined || memory === undefined || computer === undefined) return;
    let stopped = false;
    void loadOptions(client).then((result) => {
      if (stopped) return;
      setOptions(result);
      if (result.kind !== 'ready') return;
      const draft = initialDraft(result, memory.computers[computer], requested.current);
      requested.current = undefined;
      setWorkspaceId(draft.workspaceId);
      setNewWorktree(draft.newWorktree);
      setChoice(draft.choice);
      setPermissionMode(draft.permissionMode);
    });
    return () => {
      stopped = true;
    };
  }, [client, memory, computer]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKeyboard(keyboardOverlap(e)),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboard(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const ready = options?.kind === 'ready' ? options : undefined;
  const provider = ready?.providers.find((p) => p.id === choice?.providerId);
  const workspace = ready?.workspaces.find((w) => w.id === workspaceId);
  const canStart =
    ready !== undefined &&
    choice !== undefined &&
    (workspaceId !== undefined || ready.features.chats);

  const photos = usePhotoAttachments({
    upload: async (mimeType: UserImageMimeType, data: string) => {
      if (client === undefined) throw new Error('offline');
      return (await client.request('image.upload', { mimeType, data })).image;
    },
    onError: setError,
  });

  const [monitorId, setMonitorId] = useState<Session['id']>();
  const draftKey = `${snapshot?.record.routeId ?? 'unassigned'}/new-session`;
  useEffect(() => {
    let active = true;
    void loadDraft(draftKey).then((value) => {
      if (active) setMonitorId(value.sessionId as Session['id'] | undefined);
    });
    return () => {
      active = false;
    };
  }, [draftKey]);
  useEffect(() => {
    if (!client || !monitorId || !computer) return;
    let done = false;
    const watch = new SessionWatch(client, monitorId, (view) => {
      void loadDraft(draftKey)
        .then(async (draft) => {
          if (
            done ||
            !draft.clientMessageId ||
            !view.liveSession ||
            !view.transcript?.messages.some(
              (message) =>
                message.role === 'user' && message.clientMessageId === draft.clientMessageId,
            )
          )
            return;
          done = true;
          await acknowledgeDraft(draftKey, draft.clientMessageId);
          router.dismissTo({
            pathname: '/session/[key]',
            params: { key: `${computer}/${monitorId}` },
          });
        })
        .catch((reason: unknown) => console.warn('[wevir] draft reconciliation', reason));
    });
    void watch.start();
    return () => {
      done = true;
      watch.stop();
    };
  }, [client, monitorId, computer, draftKey, router]);
  const start = async (text: string, id: string) => {
    if (!canStart || client === undefined || computer === undefined)
      throw new ConnectionLostError('session.create', undefined, '', undefined, false);
    setError(undefined);
    const draft = {
      ...(workspaceId !== undefined && { workspaceId: workspaceId as never }),
      newWorktree: newWorktree && workspaceId !== undefined,
      choice,
      permissionMode,
    };
    const saved = await loadDraft(draftKey);
    let existing = created.current?.computer === computer ? created.current.session : undefined;
    if (!existing && saved.sessionId) {
      try {
        existing = (
          await client.request(
            'session.get',
            { sessionId: saved.sessionId as Session['id'] },
            { queue: false },
          )
        ).session;
      } catch (reason) {
        if (!isRpcError(reason, 'SESSION_NOT_FOUND')) throw reason;
        if (!ready.features.sessionCreationIdentity)
          throw new Error('session creation outcome is unknown');
      }
    }
    const chosenId =
      existing?.id ??
      saved.sessionId ??
      `ses_${Array.from(getRandomBytes(16), (value) => value.toString(16).padStart(2, '0')).join('')}`;
    await bindDraftSession(draftKey, chosenId);
    let sent: boolean;
    let session: Session;
    let sendError: unknown;
    try {
      ({
        session,
        sent,
        error: sendError,
      } = await startSession(
        client,
        draft,
        ready.features,
        messageContent(text, photos.images),
        id,
        existing,
        chosenId as Session['id'],
      ));
    } catch (e) {
      if (!sendOutcomeUnknown(e)) await bindDraftSession(draftKey, undefined);
      else setMonitorId(chosenId as Session['id']);
      console.warn('[wevir] could not create session', e);
      setError(createErrorKey(e));
      throw e;
    }
    await bindDraftSession(draftKey, session.id);
    if (existing === undefined) {
      const next: NewSessionMemory = {
        computer,
        computers: { ...memory?.computers, [computer]: rememberDraft(draft) },
      };
      void saveNewSessionMemory(next).catch((e: unknown) =>
        console.warn('[wevir] could not save new session choices', e),
      );
    }
    if (!sent) {
      // 会话建好了、消息没发出：留在这里（文字与照片都在），再点发送时发进这个会话。
      created.current = { computer, session };
      setMonitorId(session.id);
      setError('session.sendFailed');
      throw sendError;
    }
    created.current = undefined;
    router.dismissTo({
      pathname: '/session/[key]',
      params: { key: `${computer}/${session.id}` },
    });
  };

  const computerMenu: MenuSection[] = [
    {
      items: computers.map((c) => ({
        id: c.record.name,
        label: displayName(c.record),
        checked: c.record.name === computer,
        onPress: () => {
          if (c.record.name !== computer) setComputer(c.record.name);
        },
      })),
    },
  ];

  const projectMenu: MenuSection[] =
    ready === undefined
      ? []
      : [
          {
            items: [
              ...(ready.features.chats
                ? [
                    {
                      label: t('newSession.chat'),
                      checked: workspaceId === undefined,
                      onPress: () => setWorkspaceId(undefined),
                    },
                  ]
                : []),
              ...ready.workspaces.map((w) => ({
                label: w.displayName || w.rootPath,
                checked: w.id === workspaceId,
                onPress: () => {
                  if (w.id !== workspaceId) setNewWorktree(false);
                  setWorkspaceId(w.id);
                },
              })),
            ],
          },
          ...(workspace !== undefined && ready.features.worktree
            ? [
                {
                  title: t('newSession.location'),
                  items: [
                    {
                      label: t('newSession.sameFolder'),
                      checked: !newWorktree,
                      onPress: () => setNewWorktree(false),
                    },
                    {
                      label: t('newSession.newWorktree'),
                      checked: newWorktree,
                      onPress: () => setNewWorktree(true),
                    },
                  ],
                },
              ]
            : []),
        ];

  const permissionMenu: MenuSection[] = [
    {
      items: PHONE_PERMISSION_MODES.map((mode) => ({
        label: t(`permission.${mode}`),
        checked: mode === permissionMode,
        onPress: () => setPermissionMode(mode),
      })),
    },
  ];

  const notice =
    computer === undefined ? undefined : client === undefined ? (
      <Notice icon="offline" text={t('newSession.offline')} />
    ) : options === undefined ? (
      <ActivityIndicator color={theme.mutedForeground} />
    ) : options.kind === 'forbidden' ? (
      <Notice icon="lock" text={t('newSession.computerOnly')} />
    ) : options.kind === 'failed' ? (
      <Notice icon="offline" text={t('newSession.loadFailed')} />
    ) : options.providers.length === 0 ? (
      <Notice icon="lock" text={t('newSession.noSources')} />
    ) : undefined;
  const writable = ready !== undefined && ready.providers.length > 0;

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
      <View style={[styles.page, { backgroundColor: theme.background }]}>
        <ScrollView
          style={styles.page}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {notice}
        </ScrollView>
        <View
          style={[
            styles.footer,
            { paddingBottom: keyboard > 0 ? keyboard + 8 : Math.max(insets.bottom, 8) },
          ]}
        >
          <View style={styles.chips}>
            {computers.length > 1 && computer !== undefined && snapshot !== undefined && (
              <Chip
                icon={{ ios: 'laptopcomputer', android: 'laptop_mac' }}
                text={displayName(snapshot.record)}
                label={t('newBot.computer')}
                sections={computerMenu}
              />
            )}
            {writable && (
              <>
                <Chip
                  icon={{ ios: 'folder', android: 'folder' }}
                  text={[
                    workspace !== undefined
                      ? workspace.displayName || workspace.rootPath
                      : t('newSession.chat'),
                    newWorktree && workspace !== undefined
                      ? t('newSession.newWorktree')
                      : undefined,
                  ]
                    .filter((part) => part !== undefined)
                    .join(' · ')}
                  label={t('newSession.project')}
                  sections={projectMenu}
                  testID="new-session-project"
                />
                {ready.features.permissionModes && (
                  <Chip
                    icon={
                      permissionMode === 'auto_review'
                        ? { ios: 'checkmark.shield', android: 'verified_user' }
                        : { ios: 'hand.raised', android: 'back_hand' }
                    }
                    text={t(`permission.${permissionMode}`)}
                    label={t('newSession.permission')}
                    sections={permissionMenu}
                  />
                )}
              </>
            )}
          </View>
          {error !== undefined && (
            <Text style={[styles.error, { color: theme.destructive }]} testID="new-session-error">
              {t(error)}
            </Text>
          )}
          <Composer
            key={snapshot?.record.routeId ?? 'unassigned'}
            draftKey={draftKey}
            onSend={start}
            autoFocus
            canSend={canStart}
            disabled={false}
            placeholder={t('newSession.message')}
            {...(writable && {
              attachMenu: photos.menu,
              attachments: photos.attachments,
              onRemoveAttachment: photos.remove,
            })}
            {...(writable &&
              client?.supports('speech') === true && {
                speech: client,
                onDictationError: setError,
              })}
            {...(writable &&
              choice !== undefined &&
              provider !== undefined && {
                model: (
                  <ModelPicker
                    choice={choice}
                    provider={provider}
                    sources={{ providers: ready.providers, accounts: ready.accounts }}
                    fastMode={ready.features.fast === true}
                    onChange={setChoice}
                  />
                ),
              })}
          />
        </View>
      </View>
    </>
  );
}

/** 输入栏上面的一枚选项胶囊：图标、当前的值、下拉箭头，点开从胶囊处展开的菜单。 */
function Chip({
  icon,
  text,
  label,
  sections,
  testID,
}: {
  icon: IconName;
  text: string;
  label: string;
  sections: readonly MenuSection[];
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <MenuTrigger
      sections={sections}
      label={`${label}, ${text}`}
      title={label}
      style={styles.chipWrap}
      {...(testID !== undefined && { testID })}
    >
      <View style={[styles.chip, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Icon name={icon} size={14} color={theme.softForeground} />
        <Text style={[styles.chipText, { color: theme.foreground }]} numberOfLines={1}>
          {text}
        </Text>
        <Icon
          name={{ ios: 'chevron.up.chevron.down', android: 'unfold_more' }}
          size={11}
          weight="semibold"
          color={theme.mutedForeground}
        />
      </View>
    </MenuTrigger>
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
  page: { flex: 1 },
  body: { flexGrow: 1, justifyContent: 'center', padding: SPACE.page },
  footer: { paddingHorizontal: 12, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 4 },
  chipWrap: { maxWidth: '100%' },
  chip: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { flexShrink: 1, fontSize: TEXT.small, fontWeight: '500' },
  error: { fontSize: TEXT.small, marginHorizontal: 10 },
  notice: { alignItems: 'center', gap: 12, paddingHorizontal: 24 },
  noticeText: { fontSize: TEXT.body, lineHeight: 22, textAlign: 'center' },
});
