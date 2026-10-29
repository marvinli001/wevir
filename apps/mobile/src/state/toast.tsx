// 底部的一条提示（例如“已归档 · 撤销”）：几秒后自己收起，带一个操作按钮。浮在标签栏上面；新的一条换掉旧的。

import * as Haptics from 'expo-haptics';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RADIUS, TEXT, useTheme } from '../theme';

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
});
