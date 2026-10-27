// 生物识别（expo-local-authentication）：
// - 高风险审批的本人验证：装成 approval-gate.ts 的验证，每次批准高风险操作都要过一次 Face ID / 指纹（没有生物识别时退到设备密码）；
// - 可选的 App 锁：打开后，冷启动与从后台回来时盖一层锁屏，验证通过才露出内容。开与关都要先验证一次。开关存钥匙串
//   （`wevir.lock.enabled`，只在本机）。系统弹窗（权限、Face ID 本身）只让 App 短暂 inactive，不算进后台，不会再锁。
// 这台手机一种锁屏方式都没有时：App 锁开不了，高风险审批不能批准（只能在电脑上做）。

import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Button, Icon } from '../components/ui';
import { t } from '../i18n';
import { setApprovalGate } from '../lib/approval-gate';
import { SPACE, TEXT, useTheme } from '../theme';

const PREF_KEY = 'wevir.lock.enabled';
const PREF_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: 'wevir.settings',
};

/** 这台手机能用的验证：生物识别、只有设备密码，或都没有。 */
export type Biometry = 'face' | 'fingerprint' | 'iris' | 'passcode' | 'none';

async function biometry(): Promise<Biometry> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) return 'none';
  if (level === LocalAuthentication.SecurityLevel.SECRET) return 'passcode';
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'face';
  if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint';
  if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'iris';
  return 'passcode';
}

/** 验证一次本人；没有任何锁屏方式时直接不通过。 */
export async function authenticate(promptMessage: string): Promise<boolean> {
  if ((await biometry()) === 'none') return false;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: t('lock.cancel'),
    disableDeviceFallback: false,
  });
  return result.success;
}

interface LockContextValue {
  /** 偏好读完了。 */
  ready: boolean;
  enabled: boolean;
  available: Biometry;
  /** 开关 App 锁（先验证）；返回是否改成了。 */
  setEnabled(enabled: boolean): Promise<boolean>;
}

const LockContext = createContext<LockContextValue | undefined>(undefined);

export function LockProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [locked, setLocked] = useState(false);
  const [available, setAvailable] = useState<Biometry>('none');
  const unlocking = useRef(false);

  // 高风险审批的本人验证，全 App 一份。
  useEffect(() => setApprovalGate(() => authenticate(t('lock.approvePrompt'))), []);

  useEffect(() => {
    let disposed = false;
    Promise.all([
      SecureStore.getItemAsync(PREF_KEY, PREF_OPTIONS).catch(() => null),
      biometry().catch((): Biometry => 'none'),
    ]).then(([pref, kind]) => {
      if (disposed) return;
      const on = pref === '1';
      setEnabledState(on);
      setLocked(on);
      setAvailable(kind);
      setReady(true);
    });
    return () => {
      disposed = true;
    };
  }, []);

  const unlock = useCallback(async () => {
    if (unlocking.current) return;
    unlocking.current = true;
    try {
      if (await authenticate(t('lock.prompt'))) setLocked(false);
    } finally {
      unlocking.current = false;
    }
  }, []);

  // 进后台就锁上；锁着回到前台（或冷启动时已在前台）就自动弹一次验证。
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' && enabled) {
        lockedRef.current = true;
        setLocked(true);
      }
      if (state === 'active') {
        void biometry().then(setAvailable, () => {});
        if (lockedRef.current) void unlock();
      }
    });
    return () => subscription.remove();
  }, [enabled, unlock]);

  useEffect(() => {
    if (locked && AppState.currentState === 'active') void unlock();
  }, [locked, unlock]);

  const setEnabled = useCallback(async (next: boolean) => {
    if (!(await authenticate(t('lock.prompt')))) return false;
    await SecureStore.setItemAsync(PREF_KEY, next ? '1' : '0', PREF_OPTIONS);
    setEnabledState(next);
    return true;
  }, []);

  const value = useMemo(
    () => ({ ready, enabled, available, setEnabled }),
    [ready, enabled, available, setEnabled],
  );

  return (
    <LockContext.Provider value={value}>
      {children}
      {/* 偏好没读完时也先盖住：开了锁的不会先露出内容。 */}
      {(!ready || locked) && <LockScreen showUnlock={ready} onUnlock={unlock} />}
    </LockContext.Provider>
  );
}

export function useLock(): LockContextValue {
  const value = useContext(LockContext);
  if (value === undefined) throw new Error('useLock outside LockProvider');
  return value;
}

function LockScreen({ showUnlock, onUnlock }: { showUnlock: boolean; onUnlock: () => void }) {
  const theme = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.lock, { backgroundColor: theme.background }]}>
      {showUnlock && (
        <>
          <Icon
            name={{ ios: 'lock.fill', android: 'lock' }}
            size={34}
            color={theme.softForeground}
          />
          <Text style={[styles.title, { color: theme.foreground }]}>{t('lock.locked')}</Text>
          <Button
            title={t('lock.unlock')}
            icon={{ ios: 'faceid', android: 'fingerprint' }}
            onPress={onUnlock}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  lock: { alignItems: 'center', justifyContent: 'center', gap: 18, padding: SPACE.page },
  title: { fontSize: TEXT.title, fontWeight: '600' },
});
