// 新建助理：名字、一句话职责、头像（随机抽，点头像或“换一个”再抽），多台电脑时选建在哪台上。建好后打开它的对话，第一条是它
// 说明自己需要什么。页面是系统的表单卡片（iOS 26 是玻璃），iOS 左上角一枚玻璃关闭按钮。

import * as Haptics from 'expo-haptics';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BotAvatar } from '../components/bot-avatar';
import { Button, Group, Icon, Segmented } from '../components/ui';
import { t } from '../i18n';
import { randomAvatar } from '../lib/bot-avatar';
import { useBotComputers, useBotStore } from '../state/bots';
import { SPACE, TEXT, useTheme } from '../theme';

const NAME_MAX = 40;
const DESCRIPTION_MAX = 120;

export default function NewBotScreen() {
  const theme = useTheme();
  const router = useRouter();
  const store = useBotStore();
  const computers = useBotComputers();
  const [avatar, setAvatar] = useState(() => randomAvatar());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [computer, setComputer] = useState(computers[0]?.computer);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = name.trim() !== '' && description.trim() !== '' && computer !== undefined && !busy;

  const reroll = () => {
    void Haptics.selectionAsync().catch(() => {});
    setAvatar((current) => randomAvatar(Math.random, current));
  };

  const create = async () => {
    if (!ready || computer === undefined) return;
    setBusy(true);
    setFailed(false);
    try {
      const bot = await store.create({
        computer,
        name: name.trim(),
        description: description.trim(),
        avatar,
      });
      router.dismissTo({ pathname: '/bot/[key]', params: { key: bot.key } });
    } catch (error) {
      console.warn('[wevir] could not create bot', error);
      setFailed(true);
      setBusy(false);
    }
  };

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
      {/* 表单卡片里不套 KeyboardAvoidingView（套了内容高度为 0）：键盘让 ScrollView 自己避开。 */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('newBot.reroll')}
            onPress={reroll}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <BotAvatar avatar={avatar} size={88} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={reroll}
            hitSlop={8}
            style={({ pressed }) => [
              styles.reroll,
              { backgroundColor: theme.muted, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Icon
              name={{ ios: 'shuffle', android: 'shuffle' }}
              size={14}
              weight="semibold"
              color={theme.foreground}
            />
            <Text style={[styles.rerollText, { color: theme.foreground }]}>
              {t('newBot.reroll')}
            </Text>
          </Pressable>
        </View>

        <Group>
          <Field
            label={t('newBot.name')}
            value={name}
            onChange={setName}
            maxLength={NAME_MAX}
            autoFocus
          />
          <View style={[styles.separator, { backgroundColor: theme.border }]} />
          <Field
            label={t('newBot.description')}
            value={description}
            onChange={setDescription}
            maxLength={DESCRIPTION_MAX}
            placeholder={t('newBot.descriptionHint')}
            onSubmit={() => void create()}
          />
        </Group>

        {computers.length > 1 && computer !== undefined && (
          <View style={styles.computers}>
            <Text style={[styles.label, { color: theme.mutedForeground }]}>
              {t('newBot.computer')}
            </Text>
            <Segmented
              options={computers.map((c) => ({ value: c.computer, label: c.name }))}
              value={computer}
              disabled={busy}
              onChange={setComputer}
            />
          </View>
        )}

        {failed && (
          <Text style={[styles.error, { color: theme.destructive }]}>{t('newBot.failed')}</Text>
        )}

        <View style={styles.create}>
          <Button title={t('newBot.create')} disabled={!ready} onPress={() => void create()} />
        </View>
      </ScrollView>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  autoFocus,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        maxLength={maxLength}
        placeholder={placeholder}
        placeholderTextColor={theme.mutedForeground}
        autoFocus={autoFocus}
        returnKeyType={onSubmit !== undefined ? 'done' : 'next'}
        onSubmitEditing={onSubmit}
        selectionColor={theme.foreground}
        style={[styles.fieldInput, { color: theme.foreground }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE.page, paddingBottom: 48 },
  hero: { alignItems: 'center', gap: 14, paddingTop: 28, paddingBottom: 24 },
  reroll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  rerollText: { fontSize: TEXT.small, fontWeight: '600' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    paddingHorizontal: SPACE.page,
    gap: 12,
  },
  fieldLabel: { width: 72, fontSize: TEXT.body, fontWeight: '500' },
  fieldInput: { flex: 1, fontSize: TEXT.body, paddingVertical: 12 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: SPACE.page },
  computers: { marginTop: 24, gap: 8 },
  label: { fontSize: TEXT.small, fontWeight: '600', marginHorizontal: 6 },
  error: { fontSize: TEXT.small, marginTop: 16, marginHorizontal: 6 },
  create: { marginTop: 28 },
});
