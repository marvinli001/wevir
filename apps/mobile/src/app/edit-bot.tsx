// 编辑助理：头像（点一下换一个）、名字、职责、模型（那台电脑上启用的模型服务）、可访问的文件夹（从那台电脑的项目文件夹里加，或移除）、
// 规矩（每类动作四档，同桌面的“规矩”：设为先问的动作走收件箱与推送审批）。
// 这台设备在那台电脑上没有“修改项目”权限时只能看，下面说明到电脑上哪里开；没有“查看模型服务”时不列模型。页面是表单卡片。

import {
  ASSISTANT_RULE_CATEGORIES,
  type AssistantRuleCategory,
  type AssistantRuleTier,
  type ProviderProfile,
} from '@wevir/protocol';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BotAvatar } from '../components/bot-avatar';
import { MenuTrigger } from '../components/menu';
import { Button, Group, Icon, Row, SectionTitle } from '../components/ui';
import { t } from '../i18n';
import { randomAvatar } from '../lib/bot-avatar';
import { type Bot, botPatch, brainLimit, folderParts, ruleTier } from '../lib/bots';
import { useBot, useBotAccess, useBotStore } from '../state/bots';
import { SPACE, TEXT, useTheme } from '../theme';

const NAME_MAX = 40;
const DESCRIPTION_MAX = 120;
/** 与 Host 的 `ASSISTANT_FOLDERS_MAX` 相同。 */
const FOLDERS_MAX = 7;
const TIERS: readonly AssistantRuleTier[] = ['do', 'tell', 'ask', 'hand_off'];

export default function EditBotScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const bot = useBot(key);
  if (bot === undefined) return null;
  return <EditBot bot={bot} />;
}

interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
}

function modelOptions(providers: readonly ProviderProfile[]): ModelOption[] {
  return providers.flatMap((provider) => {
    const models = provider.models.length > 0 ? provider.models : [{ id: provider.defaultModelId }];
    return models.map((model) => ({
      providerId: provider.id,
      modelId: model.id,
      label: `${provider.displayName || provider.id} · ${
        ('displayName' in model && model.displayName) || model.id
      }`,
    }));
  });
}

function EditBot({ bot }: { bot: Bot }) {
  const theme = useTheme();
  const router = useRouter();
  const store = useBotStore();
  const access = useBotAccess(bot.key);
  const channel = store.channel(bot.key);
  const editable = access.online && access.canEdit;
  const [avatar, setAvatar] = useState(bot.avatar);
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [folders, setFolders] = useState<readonly string[]>(channel?.assistant?.folders ?? []);
  const [model, setModel] = useState<{ providerId: string; modelId: string }>();
  const [rules, setRules] = useState<Partial<Record<AssistantRuleCategory, AssistantRuleTier>>>({});
  const [providers, setProviders] = useState<ProviderProfile[]>();
  const [choices, setChoices] = useState<string[]>();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!access.online || !access.canReadProviders) return;
    store
      .providers(bot.key)
      .then(setProviders)
      .catch((error: unknown) => console.warn('[wevir] could not list providers', error));
  }, [store, bot.key, access.online, access.canReadProviders]);

  const options = useMemo(() => (providers ? modelOptions(providers) : []), [providers]);
  const coordinator = channel?.coordinator;
  const currentProvider = providers?.find((p) => p.id === coordinator?.providerId);
  const selected = model ?? {
    providerId: coordinator?.providerId ?? '',
    modelId: coordinator?.modelId ?? currentProvider?.defaultModelId ?? '',
  };

  const patch =
    channel !== undefined
      ? botPatch(channel, { name, description, avatar, folders, rules, ...(model && { model }) })
      : undefined;
  const limit = brainLimit(
    store.engineFeatures(bot.key),
    providers?.find((p) => p.id === selected.providerId)?.kind,
  );
  const ready =
    editable &&
    !busy &&
    patch !== undefined &&
    name.trim() !== '' &&
    description.trim() !== '' &&
    // 换到不能运行助理的引擎才挡：原来的大脑照样能改别的。
    !(limit === 'tools' && model !== undefined);

  const reroll = () => {
    if (!editable) return;
    void Haptics.selectionAsync().catch(() => {});
    setAvatar((current) => randomAvatar(Math.random, current));
  };

  const openChoices = () => {
    if (adding) {
      setAdding(false);
      return;
    }
    setAdding(true);
    store
      .projectFolders(bot.key)
      .then(setChoices)
      .catch((error: unknown) => {
        console.warn('[wevir] could not list project folders', error);
        setChoices([]);
      });
  };

  const save = async () => {
    if (!ready || patch === undefined) return;
    setBusy(true);
    setFailed(false);
    try {
      await store.update(bot.key, patch);
      router.back();
    } catch (error) {
      console.warn('[wevir] could not update bot', error);
      setFailed(true);
      setBusy(false);
    }
  };

  const addable = (choices ?? []).filter((folder) => !folders.includes(folder));
  const tierOf = (category: AssistantRuleCategory) =>
    rules[category] ?? ruleTier(channel?.assistant?.rules ?? {}, category);
  const tierMenu = (category: AssistantRuleCategory) => [
    {
      items: TIERS.map((tier) => ({
        label: t(`rules.tier.${tier}`),
        checked: tier === tierOf(category),
        onPress: () => setRules((current) => ({ ...current, [category]: tier })),
      })),
    },
  ];

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
        <View style={styles.hero}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('newBot.reroll')}
            accessibilityState={{ disabled: !editable }}
            disabled={!editable}
            onPress={reroll}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <BotAvatar avatar={avatar} size={88} />
          </Pressable>
          {editable && (
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
          )}
        </View>

        <Group>
          <Field
            label={t('newBot.name')}
            value={name}
            onChange={setName}
            maxLength={NAME_MAX}
            editable={editable}
          />
          <View style={[styles.separator, { backgroundColor: theme.border }]} />
          <Field
            label={t('newBot.description')}
            value={description}
            onChange={setDescription}
            maxLength={DESCRIPTION_MAX}
            editable={editable}
          />
        </Group>

        {options.length > 0 && (
          <>
            <SectionTitle>{t('editBot.model')}</SectionTitle>
            <Group>
              {options.map((option, index) => {
                const chosen =
                  option.providerId === selected.providerId && option.modelId === selected.modelId;
                return (
                  <Row
                    key={`${option.providerId}/${option.modelId}`}
                    last={index === options.length - 1}
                    chevron={false}
                    title={option.label}
                    trailing={
                      chosen ? (
                        <Icon
                          name={{ ios: 'checkmark', android: 'check' }}
                          size={16}
                          weight="semibold"
                          color={theme.foreground}
                        />
                      ) : undefined
                    }
                    {...(editable &&
                      !chosen && {
                        onPress: () =>
                          setModel({ providerId: option.providerId, modelId: option.modelId }),
                      })}
                  />
                );
              })}
            </Group>
            {limit !== undefined && (
              <Text style={[styles.note, { color: theme.mutedForeground }]}>
                {t(limit === 'tools' ? 'editBot.engineNoTools' : 'editBot.enginePlugins')}
              </Text>
            )}
          </>
        )}

        <SectionTitle>{t('editBot.folders')}</SectionTitle>
        <Group>
          {folders.map((folder, index) => {
            const parts = folderParts(folder);
            return (
              <Row
                key={folder}
                last={index === folders.length - 1 && !(editable && folders.length < FOLDERS_MAX)}
                chevron={false}
                icon={{ ios: 'folder', android: 'folder' }}
                title={parts.name}
                subtitle={
                  parts.parent !== '' ? (
                    <Text
                      style={[styles.sub, { color: theme.mutedForeground }]}
                      numberOfLines={1}
                      ellipsizeMode="head"
                    >
                      {parts.parent}
                    </Text>
                  ) : undefined
                }
                trailing={
                  editable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('editBot.removeFolder')}
                      hitSlop={8}
                      style={styles.remove}
                      onPress={() => setFolders(folders.filter((f) => f !== folder))}
                    >
                      <Icon
                        name={{ ios: 'minus.circle.fill', android: 'remove_circle' }}
                        size={20}
                        color={theme.destructive}
                      />
                    </Pressable>
                  ) : undefined
                }
              />
            );
          })}
          {folders.length === 0 && !editable && (
            <Row last chevron={false} title={t('editBot.noFolders')} />
          )}
          {editable && folders.length < FOLDERS_MAX && (
            <Row
              last
              chevron={false}
              icon={{ ios: 'plus', android: 'add' }}
              title={t('editBot.addFolder')}
              onPress={openChoices}
            />
          )}
        </Group>
        {adding && editable && (
          <Group style={styles.choices}>
            {choices === undefined ? (
              <Row last chevron={false} title={t('editBot.loading')} />
            ) : addable.length === 0 ? (
              <Row last chevron={false} title={t('editBot.noProjects')} />
            ) : (
              addable.map((folder, index) => {
                const parts = folderParts(folder);
                return (
                  <Row
                    key={folder}
                    last={index === addable.length - 1}
                    chevron={false}
                    title={parts.name}
                    subtitle={
                      <Text
                        style={[styles.sub, { color: theme.mutedForeground }]}
                        numberOfLines={1}
                        ellipsizeMode="head"
                      >
                        {parts.parent}
                      </Text>
                    }
                    onPress={() => {
                      setFolders([...folders, folder]);
                      if (folders.length + 1 >= FOLDERS_MAX) setAdding(false);
                    }}
                  />
                );
              })
            )}
          </Group>
        )}

        <SectionTitle>{t('editBot.rules')}</SectionTitle>
        <Group>
          {ASSISTANT_RULE_CATEGORIES.map((category, index) => (
            <MenuTrigger
              key={category}
              sections={tierMenu(category)}
              label={t(`rules.${category}`)}
              title={t(`rules.${category}`)}
              disabled={!editable}
            >
              <Row
                last={index === ASSISTANT_RULE_CATEGORIES.length - 1}
                chevron={false}
                title={t(`rules.${category}`)}
                trailing={
                  <View style={styles.tierValue}>
                    <Text style={[styles.tier, { color: theme.mutedForeground }]}>
                      {t(`rules.tier.${tierOf(category)}`)}
                    </Text>
                    {editable && (
                      <Icon
                        name={{ ios: 'chevron.up.chevron.down', android: 'unfold_more' }}
                        size={12}
                        weight="semibold"
                        color={theme.mutedForeground}
                      />
                    )}
                  </View>
                }
              />
            </MenuTrigger>
          ))}
        </Group>

        {access.online && !access.canEdit && (
          <Text style={[styles.note, { color: theme.mutedForeground }]}>
            {t('editBot.forbidden')}
          </Text>
        )}
        {failed && (
          <Text style={[styles.note, { color: theme.destructive }]}>{t('editBot.failed')}</Text>
        )}

        {editable && (
          <View style={styles.save}>
            <Button title={t('editBot.save')} disabled={!ready} onPress={() => void save()} />
          </View>
        )}
      </ScrollView>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  editable,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  editable: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.foreground }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        maxLength={maxLength}
        editable={editable}
        returnKeyType="done"
        selectionColor={theme.foreground}
        style={[styles.fieldInput, { color: editable ? theme.foreground : theme.softForeground }]}
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
  sub: { fontSize: TEXT.caption },
  tier: { fontSize: TEXT.body },
  tierValue: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  /** 图标只有 20，按钮放大到 32，再加 hitSlop 到 48。 */
  remove: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  choices: { marginTop: 12 },
  note: { fontSize: TEXT.small, lineHeight: 20, marginTop: 16, marginHorizontal: 6 },
  save: { marginTop: 28 },
});
