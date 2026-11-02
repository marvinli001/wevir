// App 的临时提示层。底部的一条提示（例如“已归档 · 撤销”）：几秒后自己收起，带一个操作按钮。浮在标签栏上面；新的一条换掉旧的。
// 顶部的连接胶囊：连电脑、读会话列表期间从安全区顶部弹出，连上后收起，没连上时短暂显示原因（何时显示见 lib/connect-banner.ts）。
// 不接触摸，不挡导航栏。

import { GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GLASS, Icon } from '../components/ui';
import { joinNames, t } from '../i18n';
import { type BannerView, ConnectBanner } from '../lib/connect-banner';
import { RADIUS, TEXT, type Theme, useTheme } from '../theme';
import { useRegistry } from './registry';

/** 提示停留多久。 */
const TOAST_MS = 5_000;
/** 标签栏的高度：提示放在它上面。 */
const TAB_BAR = 64;

export interface Toast {
  text: string;
  action?: { label: string; onPress: () => void };
}

const ToastContext = createContext<((toast: Toast) => void) | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast & { id: number }>();
  const next = useRef(0);
  const show = useCallback((value: Toast) => {
    next.current += 1;
    setToast({ ...value, id: next.current });
  }, []);
  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <ConnectStatus />
      {toast !== undefined && (
        <ToastBar
          key={toast.id}
          toast={toast}
          onAction={() => {
            setToast(undefined);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            toast.action?.onPress();
          }}
        />
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: Toast) => void {
  const show = useContext(ToastContext);
  if (show === undefined) throw new Error('useToast outside ToastProvider');
  return show;
}

function ToastBar({ toast, onAction }: { toast: Toast; onAction: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View pointerEvents="box-none" style={[styles.layer, { bottom: insets.bottom + TAB_BAR + 12 }]}>
      <View
        accessibilityLiveRegion="polite"
        style={[styles.bar, { backgroundColor: theme.primary }]}
        testID="toast"
      >
        <Text style={[styles.text, { color: theme.primaryForeground }]} numberOfLines={2}>
          {toast.text}
        </Text>
        {toast.action !== undefined && (
          <Pressable
            accessibilityRole="button"
            onPress={onAction}
            hitSlop={10}
            style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}
            testID="toast-action"
          >
            <Text style={[styles.actionText, { color: theme.primaryForeground }]}>
              {toast.action.label}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function ConnectStatus() {
  const registry = useRegistry();
  const [banner] = useState(
    () =>
      new ConnectBanner({
        now: () => Date.now(),
        setTimer: (callback, ms) => setTimeout(callback, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      }),
  );
  useEffect(() => {
    banner.update(registry.snapshots);
    const unsubscribe = registry.subscribe(() => banner.update(registry.snapshots));
    return () => {
      unsubscribe();
      banner.dispose();
    };
  }, [banner, registry]);
  const view = useSyncExternalStore(
    (listener) => banner.subscribe(listener),
    () => banner.view,
  );
  return <ConnectPill view={view} />;
}

function pillTitle(view: BannerView): string {
  switch (view.kind) {
    case 'connecting':
      return view.stage === 'loading' ? t('connect.loading') : t('status.connecting');
    case 'connected':
      return t('connect.connected');
    case 'offline':
      if (view.reason === 'remote_disabled') return t('status.remoteDisabled');
      if (view.reason === 'host_mismatch') return t('status.hostMismatch');
      return t('status.offline');
  }
}

function PillIcon({ view, theme }: { view: BannerView; theme: Theme }) {
  switch (view.kind) {
    case 'connecting':
      return <ActivityIndicator size="small" color={theme.mutedForeground} />;
    case 'connected':
      return (
        <Icon
          name={{ ios: 'checkmark.circle.fill', android: 'check_circle' }}
          size={20}
          color={theme.success}
        />
      );
    case 'offline':
      return (
        <Icon name={{ ios: 'wifi.slash', android: 'wifi_off' }} size={18} color={theme.warning} />
      );
  }
}

/** 弹簧进出：收起时动画走完才卸下，期间仍画最后一次的内容。 */
function ConnectPill({ view }: { view: BannerView | undefined }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState(view);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (view !== undefined) {
      setShown(view);
      Animated.spring(progress, {
        toValue: 1,
        useNativeDriver: true,
        damping: 17,
        stiffness: 230,
        mass: 1,
      }).start();
      return;
    }
    Animated.spring(progress, {
      toValue: 0,
      useNativeDriver: true,
      damping: 24,
      stiffness: 260,
      overshootClamping: true,
    }).start(({ finished }) => {
      if (finished) setShown(undefined);
    });
  }, [view, progress]);
  const title = shown === undefined ? undefined : pillTitle(shown);
  useEffect(() => {
    if (title !== undefined) AccessibilityInfo.announceForAccessibility(title);
  }, [title]);
  if (shown === undefined || title === undefined) return null;
  const content = (
    <>
      <View style={styles.pillIcon}>
        <PillIcon view={shown} theme={theme} />
      </View>
      <View style={styles.pillText}>
        <Text style={[styles.pillTitle, { color: theme.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.pillSubtitle, { color: theme.mutedForeground }]} numberOfLines={1}>
          {joinNames(shown.names)}
        </Text>
      </View>
    </>
  );
  return (
    <View pointerEvents="none" style={[styles.pillLayer, { top: insets.top + 6 }]}>
      <Animated.View
        accessibilityLabel={`${title}, ${joinNames(shown.names)}`}
        testID="connect-status"
        style={{
          opacity: progress.interpolate({
            inputRange: [0, 0.4, 1],
            outputRange: [0, 1, 1],
            extrapolate: 'clamp',
          }),
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-(insets.top + 64), 0],
              }),
            },
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
          ],
        }}
      >
        {GLASS ? (
          <GlassView glassEffectStyle="regular" style={styles.pill}>
            {content}
          </GlassView>
        ) : (
          <View
            style={[
              styles.pill,
              styles.pillSolid,
              { backgroundColor: theme.card, borderColor: theme.border },
              !theme.dark && styles.pillShadow,
            ]}
          >
            {content}
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  bar: {
    minHeight: 48,
    maxWidth: 480,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingLeft: 18,
    paddingRight: 8,
    borderRadius: RADIUS.capsule,
    borderCurve: 'continuous',
    boxShadow: '0 4px 18px rgba(0, 0, 0, 0.18)',
  },
  text: { flexShrink: 1, fontSize: TEXT.small, fontWeight: '500' },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 10 },
  actionText: { fontSize: TEXT.small, fontWeight: '700' },
  pillLayer: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  pill: {
    minHeight: 48,
    minWidth: 168,
    maxWidth: 320,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 14,
    paddingRight: 22,
    paddingVertical: 7,
    borderRadius: RADIUS.capsule,
    borderCurve: 'continuous',
  },
  pillSolid: { borderWidth: StyleSheet.hairlineWidth },
  pillShadow: {
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  pillIcon: { width: 22, alignItems: 'center' },
  pillText: { flexShrink: 1, alignItems: 'center', flexGrow: 1 },
  pillTitle: { fontSize: TEXT.small, fontWeight: '600' },
  pillSubtitle: { fontSize: TEXT.caption },
});
