// 两种小弹层：Android 的操作列表（底部的 Material 列表，Android 的 Alert 至多三个按钮）与改名框（两边都是同一个 Modal，Android 没有
// `Alert.prompt`）。按钮上的菜单用 menu.tsx 的 MenuTrigger 与 header-button.tsx 的 HeaderMenu：iOS 是贴着按钮的系统菜单，Android 是
// 这里的列表。

import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../i18n';
import { RADIUS, SPACE, TEXT, useTheme } from '../theme';
import { Button, Icon } from './ui';

export interface SheetAction {
  label: string;
  /** 名称可能重复时给。 */
  id?: string;
  destructive?: boolean;
  /** 单选列表里选中的一项（Android 的列表在行尾打勾）。 */
  checked?: boolean;
  onPress: () => void;
}

/** 弹出一组操作（Android）；返回要放进页面里的元素与打开它的函数。 */
export function useActionSheet(): [
  element: React.ReactNode,
  show: (actions: readonly SheetAction[], title?: string) => void,
] {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<{ actions: readonly SheetAction[]; title?: string }>();
  const show = useCallback((actions: readonly SheetAction[], title?: string) => {
    setOpen({ actions, ...(title !== undefined && { title }) });
  }, []);
  const element =
    Platform.OS === 'ios' ? null : (
      <Modal
        visible={open !== undefined}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(undefined)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(undefined)}>
          <View
            style={[
              styles.sheet,
              { backgroundColor: theme.card, paddingBottom: Math.max(insets.bottom, 12) },
            ]}
          >
            {open?.title !== undefined && (
              <Text style={[styles.sheetTitle, { color: theme.mutedForeground }]}>
                {open.title}
              </Text>
            )}
            {open?.actions.map((action) => (
              <Pressable
                key={action.id ?? action.label}
                accessibilityRole="button"
                android_ripple={{ color: theme.muted }}
                onPress={() => {
                  setOpen(undefined);
                  action.onPress();
                }}
                style={styles.sheetRow}
              >
                <Text
                  style={[
                    styles.sheetText,
                    { color: action.destructive ? theme.destructive : theme.foreground },
                  ]}
                >
                  {action.label}
                </Text>
                {action.checked === true && (
                  <Icon name={{ android: 'check' }} size={22} color={theme.foreground} />
                )}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    );
  return [element, show];
}

/** 改名框：一行输入、取消与保存。 */
export function RenameDialog({
  visible,
  initial,
  maxLength,
  onCancel,
  onSave,
}: {
  visible: boolean;
  initial: string;
  maxLength: number;
  onCancel: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const theme = useTheme();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = value.trim() !== '' && !busy;
  const save = () => {
    if (!ready) return;
    setBusy(true);
    setFailed(false);
    onSave(value.trim())
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onShow={() => {
        setValue(initial);
        setFailed(false);
      }}
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        style={styles.center}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={[styles.dialog, { backgroundColor: theme.card }]}>
          <Text style={[styles.dialogTitle, { color: theme.foreground }]}>
            {t('session.rename')}
          </Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            maxLength={maxLength}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={save}
            selectionColor={theme.foreground}
            style={[styles.input, { color: theme.foreground, backgroundColor: theme.muted }]}
            testID="rename-input"
          />
          {failed && (
            <Text style={[styles.error, { color: theme.destructive }]}>
              {t('session.renameFailed')}
            </Text>
          )}
          <View style={styles.buttons}>
            <View style={styles.button}>
              <Button kind="secondary" title={t('add.cancel')} onPress={onCancel} />
            </View>
            <View style={styles.button}>
              <Button title={t('session.save')} disabled={!ready} onPress={save} />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0, 0, 0, 0.32)' },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
  },
  sheetTitle: { fontSize: TEXT.small, paddingHorizontal: 24, paddingVertical: 8 },
  sheetRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
  },
  sheetText: { flex: 1, fontSize: TEXT.body },
  center: {
    flex: 1,
    justifyContent: 'center',
    padding: SPACE.page * 2,
    backgroundColor: 'rgba(0, 0, 0, 0.32)',
  },
  dialog: { borderRadius: RADIUS.card, borderCurve: 'continuous', padding: 20, gap: 14 },
  dialogTitle: { fontSize: TEXT.title, fontWeight: '600' },
  input: {
    fontSize: TEXT.body,
    borderRadius: RADIUS.control,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  error: { fontSize: TEXT.small },
  buttons: { flexDirection: 'row', gap: 10 },
  button: { flex: 1 },
});
