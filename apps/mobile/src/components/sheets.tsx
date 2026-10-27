// 两种小弹层：操作菜单（iOS 用系统的 Action Sheet；Android 的 Alert 至多三个按钮，改用底部的 Material 列表）与改名框（两边都是
// 同一个 Modal，Android 没有 `Alert.prompt`）。

import { useCallback, useState } from 'react';
import {
  ActionSheetIOS,
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
import { Button } from './ui';

export interface SheetAction {
  label: string;
  destructive?: boolean;
  onPress: () => void;
}

/** 弹出一组操作；返回要放进页面里的元素（Android 的列表）与打开它的函数。 */
export function useActionSheet(): [
  element: React.ReactNode,
  show: (actions: readonly SheetAction[], title?: string) => void,
] {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<{ actions: readonly SheetAction[]; title?: string }>();
  const show = useCallback((actions: readonly SheetAction[], title?: string) => {
    if (Platform.OS === 'ios') {
      const destructive = actions.findIndex((a) => a.destructive === true);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((a) => a.label), t('add.cancel')],
          cancelButtonIndex: actions.length,
          ...(destructive >= 0 && { destructiveButtonIndex: destructive }),
          ...(title !== undefined && { title }),
        },
        (index) => actions[index]?.onPress(),
      );
      return;
    }
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
                key={action.label}
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
  sheetRow: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 24 },
  sheetText: { fontSize: TEXT.body },
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
