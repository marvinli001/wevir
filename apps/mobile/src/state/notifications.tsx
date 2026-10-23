// App 开着时的提醒条：每台连着的电脑都订阅通知意图（`notification.intent`），来一条就在顶部弹一条卡片，点开去那个助理、会话或电脑，
// 几秒后自己收起。正看着要去的那一页时不弹。App 在后台时连接已断，收不到。

import type { NotificationIntent } from '@wevir/protocol';
import * as Haptics from 'expo-haptics';
import { usePathname, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../components/ui';
import { t } from '../i18n';
import { alreadyShowing, type Banner, notificationTarget } from '../lib/notifications';
import { displayName } from '../lib/records';
import { RADIUS, TEXT, useTheme } from '../theme';
import { useRegistry } from './registry';

/** 提醒条停留多久。 */
const BANNER_MS = 6_000;

export function NotificationBanners({ children }: { children: ReactNode }) {
  const registry = useRegistry();
  const router = useRouter();
  const path = usePathname();
  const pathRef = useRef(path);
  pathRef.current = path;
  const [banner, setBanner] = useState<Banner>();

  const receive = useCallback(
    (computer: string, computerName: string, intent: NotificationIntent) => {
      const target = notificationTarget(computer, intent);
      if (alreadyShowing(target, pathRef.current)) return;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setBanner({ key: `${computer}/${intent.collapseKey}`, computerName, intent, target });
    },
    [],
  );

  // 每台电脑的每条连接订阅一次；连接换了（重连、回到前台）重新订阅。
  useEffect(() => {
    const watches = new Map<string, { connection: object; stop: () => void }>();
    const sync = () => {
      const names = new Set<string>();
      for (const { record } of registry.snapshots) {
        names.add(record.name);
        const link = registry.link(record.name);
        const connection = link?.connection;
        const current = watches.get(record.name);
        if (current?.connection === connection) continue;
        current?.stop();
        watches.delete(record.name);
        if (link === undefined || connection === undefined) continue;
        const name = displayName(record);
        watches.set(record.name, {
          connection,
          stop: link.watchNotifications((intent) => receive(record.name, name, intent)),
        });
      }
      for (const [name, watch] of watches) {
        if (names.has(name)) continue;
        watch.stop();
        watches.delete(name);
      }
    };
    sync();
    const off = registry.subscribe(sync);
    return () => {
      off();
      for (const watch of watches.values()) watch.stop();
    };
  }, [registry, receive]);

  useEffect(() => {
    if (banner === undefined) return;
    const timer = setTimeout(() => setBanner(undefined), BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  // 进了提醒要去的那一页，收起。
  useEffect(() => {
    if (banner !== undefined && alreadyShowing(banner.target, path)) setBanner(undefined);
  }, [banner, path]);

  return (
    <>
      {children}
      {banner !== undefined && (
        <BannerCard
          banner={banner}
          onPress={() => {
            setBanner(undefined);
            router.push(banner.target);
          }}
          onDismiss={() => setBanner(undefined)}
        />
      )}
    </>
  );
}

function BannerCard({
  banner,
  onPress,
  onDismiss,
}: {
  banner: Banner;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { intent } = banner;
  const title = intent.title.trim() || banner.computerName;
  const body = intent.body.trim() || t(`notify.${intent.kind}`);
  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + 6 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${body}`}
        onPress={onPress}
        onLongPress={onDismiss}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: theme.card,
            borderColor: theme.border,
            opacity: pressed ? 0.85 : 1,
          },
          !theme.dark && styles.shadow,
        ]}
        testID="notification-banner"
      >
        <Icon
          name={
            intent.channelId !== undefined
              ? { ios: 'sparkles', android: 'auto_awesome' }
              : { ios: 'bell', android: 'notifications' }
          }
          size={18}
          color={intent.kind === 'failed' ? theme.destructive : theme.foreground}
        />
        <View style={styles.text}>
          <Text style={[styles.title, { color: theme.foreground }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.body, { color: theme.softForeground }]} numberOfLines={2}>
            {body}
          </Text>
          <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
            {banner.computerName}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 12, right: 12 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: RADIUS.card,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  shadow: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  text: { flex: 1, gap: 2 },
  title: { fontSize: TEXT.body, fontWeight: '600' },
  body: { fontSize: TEXT.small, lineHeight: 19 },
  meta: { fontSize: TEXT.caption },
});
