// 新建与编辑助理群（0.133.0），同桌面的群聊对话框：群名与成员（勾选同一台电脑上的助理，2 到 8 个，按勾选的先后）。带 `key` 时是编辑
// 那个群，只交变了的名字与整份成员；不带时新建，多台电脑能建群时先选建在哪台上，建好后打开群的对话。页面是表单卡片。

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BotAvatar } from '../components/bot-avatar';
import { Button, Group, Icon, Row, SectionTitle, Segmented } from '../components/ui';
import { t } from '../i18n';
import { groupPatch } from '../lib/bots';
import { useAssistants, useBot, useBotAccess, useBotStore, useGroupCreators } from '../state/bots';
import { SPACE, TEXT, useTheme } from '../theme';

/** 与 Host 的 `ASSISTANT_NAME_MAX_LENGTH`、`GROUP_MEMBERS_MAX` 相同。 */
const NAME_MAX = 40;
const MEMBERS_MAX = 8;

export default function EditGroupScreen() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  const theme = useTheme();
  const router = useRouter();
  const store = useBotStore();
  const bot = useBot(key ?? '');
  const access = useBotAccess(key ?? '');
  const creators = useGroupCreators();
  const editing = key !== undefined;
  const [computer, setComputer] = useState(bot?.computer ?? creators[0]?.computer);
  const assistants = useAssistants(computer);
  const channel = key === undefined ? undefined : store.channel(key);
  const [name, setName] = useState(bot?.name ?? '');
  const [members, setMembers] = useState<readonly string[]>(channel?.group?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (editing && bot === undefined) return null;
  const editable = !editing || (access.online && access.canEdit);
  // 被删的助理 Host 会移出群；还在列表里的才算。
  const chosen = members.filter((id) => assistants.some((a) => a.id === id));
  const patch = groupPatch(channel, name, chosen);
  const ready = editable && !busy && computer !== undefined && patch !== undefined;

  const toggle = (id: string) =>
    setMembers((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const save = async () => {
    if (!ready || patch === undefined || computer === undefined) return;
    setBusy(true);
    setFailed(false);
    try {
      if (key === undefined) {
        const group = await store.createGroup(computer, patch.name ?? name.trim(), patch.members);
        router.dismissTo({ pathname: '/bot/[key]', params: { key: group.key } });
      } else {
        await store.update(key, patch as Parameters<typeof store.update>[1]);
        router.back();
      }
    } catch (error) {
      console.warn('[wevir] could not save group', error);
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: t(editing ? 'group.edit' : 'bots.newGroup') }} />
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
        <Group>
          <View style={styles.field}>
            <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{t('newBot.name')}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              maxLength={NAME_MAX}
              editable={editable}
              autoFocus={!editing}
              returnKeyType="done"
              selectionColor={theme.foreground}
              style={[
                styles.fieldInput,
                { color: editable ? theme.foreground : theme.softForeground },
              ]}
            />
          </View>
        </Group>

        {!editing && creators.length > 1 && computer !== undefined && (
          <View style={styles.computers}>
            <Text style={[styles.label, { color: theme.mutedForeground }]}>
              {t('newBot.computer')}
            </Text>
            <Segmented
              options={creators.map((c) => ({ value: c.computer, label: c.name }))}
              value={computer}
              disabled={busy}
              onChange={(next) => {
                setComputer(next);
                setMembers([]);
              }}
            />
          </View>
        )}

        <SectionTitle>{t('group.members', { count: chosen.length })}</SectionTitle>
        <Group>
          {assistants.map((assistant, index) => {
            const on = chosen.includes(assistant.id);
            const full = !on && chosen.length >= MEMBERS_MAX;
            return (
              <Row
                key={assistant.id}
                last={index === assistants.length - 1}
                chevron={false}
                leading={<BotAvatar avatar={assistant.avatar} size={28} />}
                inset={58}
                title={assistant.name}
                trailing={
                  on ? (
                    <Icon
                      name={{ ios: 'checkmark', android: 'check' }}
                      size={16}
                      weight="semibold"
                      color={theme.foreground}
                    />
                  ) : undefined
                }
                {...(editable && !full && { onPress: () => toggle(assistant.id) })}
              />
            );
          })}
        </Group>

        {editing && access.online && !access.canEdit && (
          <Text style={[styles.note, { color: theme.mutedForeground }]}>
            {t('editBot.forbidden')}
          </Text>
        )}
        {failed && (
          <Text style={[styles.note, { color: theme.destructive }]}>
            {t(editing ? 'editBot.failed' : 'newBot.failed')}
          </Text>
        )}

        {editable && (
          <View style={styles.save}>
            <Button
              title={t(editing ? 'editBot.save' : 'newBot.create')}
              disabled={!ready}
              onPress={() => void save()}
            />
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE.page, paddingTop: 20, paddingBottom: 48 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    paddingHorizontal: SPACE.page,
    gap: 12,
  },
  fieldLabel: { width: 72, fontSize: TEXT.body, fontWeight: '500' },
  fieldInput: { flex: 1, fontSize: TEXT.body, paddingVertical: 12 },
  computers: { marginTop: 24, gap: 8 },
  label: { fontSize: TEXT.small, fontWeight: '600', marginHorizontal: 6 },
  note: { fontSize: TEXT.small, lineHeight: 20, marginTop: 16, marginHorizontal: 6 },
  save: { marginTop: 28 },
});
