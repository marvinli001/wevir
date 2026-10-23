// 添加电脑：扫二维码（expo-camera）、粘贴配对链接（模拟器没有相机）或手输短码（局域网 mDNS）。握手之后等电脑上点“允许”，
// 允许了就记下这台电脑并打开它的详情。页面是系统的模态卡片，iOS 左上角一枚玻璃关闭按钮。

import { DEVICE_NAME_MAX_LENGTH } from '@wevir/protocol';
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button, Group, Icon, Segmented } from '../components/ui';
import { t } from '../i18n';
import {
  classifyPairingFailure,
  type PairingInput,
  type PairingStage,
  pairComputer,
  parsePairingInput,
} from '../lib/pairing';
import { pairingFailureText } from '../lib/status-text';
import { defaultDeviceName, pairingEnvironment, useRegistry } from '../state/registry';
import { RADIUS, SPACE, TEXT, useTheme } from '../theme';

type Method = 'scan' | 'link' | 'code';

export default function AddComputerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const params = useLocalSearchParams<{ link?: string }>();
  const [method, setMethod] = useState<Method>(params.link ? 'link' : 'scan');
  const [link, setLink] = useState(params.link ?? '');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [stage, setStage] = useState<PairingStage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (params.link) {
      setMethod('link');
      setLink(params.link);
    }
  }, [params.link]);
  useEffect(() => () => abort.current?.abort(), []);

  const busy = stage !== undefined;
  const name = deviceName.trim();

  const start = async (text: string) => {
    if (busy) return;
    const input = parsePairingInput(text);
    if (input.kind === 'invalid') {
      setError(t(input.reason === 'link' ? 'pair.error.invalidLink' : 'pair.error.invalidInput'));
      return;
    }
    if (name === '') return;
    setError(undefined);
    const controller = new AbortController();
    abort.current = controller;
    setStage({ kind: input.kind === 'code' ? 'searching' : 'connecting' });
    try {
      const result = await pairComputer(pairingEnvironment(name), {
        input: input as Exclude<PairingInput, { kind: 'invalid' }>,
        existing: registry.snapshots.map((s) => s.record),
        onStage: (next) => {
          if (!controller.signal.aborted) setStage(next);
        },
        signal: controller.signal,
      });
      await registry.add(result);
      router.dismissTo({ pathname: '/computer/[name]', params: { name: result.record.name } });
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(pairingFailureText(classifyPairingFailure(failure)));
    } finally {
      if (abort.current === controller) abort.current = undefined;
      setStage(undefined);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = undefined;
    setStage(undefined);
  };

  const inputStyle = [styles.input, { backgroundColor: theme.card, color: theme.foreground }];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {Platform.OS === 'ios' && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            accessibilityLabel={t('add.cancel')}
            onPress={() => router.back()}
          />
        </Stack.Toolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Segmented
          options={(['scan', 'link', 'code'] as const).map((m) => ({
            value: m,
            label: t(`add.method.${m}`),
          }))}
          value={method}
          disabled={busy}
          onChange={(m) => {
            setMethod(m);
            setError(undefined);
          }}
        />

        <Group style={styles.nameGroup}>
          <View style={styles.nameRow}>
            <Text style={[styles.nameLabel, { color: theme.foreground }]}>
              {t('add.deviceName')}
            </Text>
            <TextInput
              value={deviceName}
              onChangeText={setDeviceName}
              maxLength={DEVICE_NAME_MAX_LENGTH}
              editable={!busy}
              autoCorrect={false}
              selectionColor={theme.foreground}
              style={[styles.nameInput, { color: theme.mutedForeground }]}
            />
          </View>
        </Group>

        {method === 'scan' && <Scanner active={!busy} onScan={(text) => void start(text)} />}

        {method === 'link' && (
          <>
            <Text style={[styles.label, { color: theme.mutedForeground }]}>{t('add.link')}</Text>
            <TextInput
              value={link}
              onChangeText={setLink}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              selectionColor={theme.foreground}
              style={[inputStyle, styles.linkInput]}
            />
            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button
                  kind="secondary"
                  title={t('add.paste')}
                  icon={{ ios: 'doc.on.clipboard', android: 'content_paste' }}
                  disabled={busy}
                  onPress={async () => setLink((await Clipboard.getStringAsync()).trim())}
                />
              </View>
              <View style={styles.flex}>
                <Button
                  title={t('add.pair')}
                  disabled={busy || link.trim() === '' || name === ''}
                  onPress={() => void start(link)}
                />
              </View>
            </View>
          </>
        )}

        {method === 'code' && (
          <>
            <Text style={[styles.label, { color: theme.mutedForeground }]}>{t('add.code')}</Text>
            <TextInput
              value={code}
              onChangeText={(text) => setCode(text.toUpperCase())}
              editable={!busy}
              autoCapitalize="characters"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              // 短码只有字母与数字：用 ASCII 键盘，中文、日文输入法不会先出候选。
              keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'visible-password'}
              maxLength={9}
              selectionColor={theme.foreground}
              style={[inputStyle, styles.codeInput]}
            />
            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button
                  title={t('add.pair')}
                  disabled={busy || code.trim() === '' || name === ''}
                  onPress={() => void start(code)}
                />
              </View>
            </View>
          </>
        )}

        {error !== undefined && (
          <View style={[styles.error, { backgroundColor: `${theme.destructive}14` }]}>
            <Icon
              name={{ ios: 'exclamationmark.circle.fill', android: 'error' }}
              size={17}
              color={theme.destructive}
            />
            <Text style={[styles.errorText, { color: theme.destructive }]}>{error}</Text>
          </View>
        )}

        {stage !== undefined && (
          <Group style={styles.progress}>
            <ActivityIndicator color={theme.mutedForeground} />
            <Text style={[styles.progressText, { color: theme.foreground }]}>
              {stageText(stage, name)}
            </Text>
            <Button kind="secondary" title={t('add.cancel')} onPress={cancel} />
          </Group>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function stageText(stage: PairingStage, device: string): string {
  switch (stage.kind) {
    case 'searching':
      return t('pair.searching');
    case 'connecting':
      return t('pair.connecting');
    case 'awaiting_approval':
      return t('pair.awaiting', { host: stage.hostName ?? t('pair.thatComputer'), device });
  }
}

/** 扫二维码：只认 QR，扫到一次就交出去，配对期间不再触发。取景框四角画细线框。 */
function Scanner({ active, onScan }: { active: boolean; onScan: (text: string) => void }) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<string | undefined>(undefined);
  if (permission === null)
    return <View style={[styles.camera, { backgroundColor: theme.muted }]} />;
  if (!permission.granted) {
    return (
      <View style={[styles.camera, styles.cameraBlocked, { backgroundColor: theme.card }]}>
        <Icon
          name={{ ios: 'camera.viewfinder', android: 'photo_camera' }}
          size={40}
          color={theme.mutedForeground}
          weight="light"
        />
        <Text style={[styles.progressText, { color: theme.mutedForeground }]}>
          {t('add.camera.permission')}
        </Text>
        <Button
          kind="secondary"
          title={permission.canAskAgain ? t('add.camera.allow') : t('add.camera.settings')}
          onPress={() =>
            permission.canAskAgain ? void requestPermission() : void Linking.openSettings()
          }
        />
      </View>
    );
  }
  return (
    <View style={[styles.camera, { backgroundColor: '#000' }]}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={
          active
            ? (result: BarcodeScanningResult) => {
                if (result.data === last.current) return;
                last.current = result.data;
                onScan(result.data);
              }
            : undefined
        }
      />
      <View style={styles.reticle} pointerEvents="none">
        {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
          <View key={corner} style={[styles.corner, styles[corner]]} />
        ))}
      </View>
    </View>
  );
}

const CORNER = 28;

const styles = StyleSheet.create({
  content: { padding: SPACE.page, paddingBottom: 48 },
  nameGroup: { marginTop: 20 },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    paddingHorizontal: SPACE.page,
    gap: 12,
  },
  nameLabel: { fontSize: TEXT.body, fontWeight: '500' },
  nameInput: { flex: 1, fontSize: TEXT.body, textAlign: 'right', paddingVertical: 12 },
  label: {
    fontSize: TEXT.small,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 8,
    marginHorizontal: 6,
  },
  input: {
    borderRadius: RADIUS.control + 4,
    borderCurve: 'continuous',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: TEXT.body,
  },
  linkInput: {
    minHeight: 112,
    textAlignVertical: 'top',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: TEXT.small,
    lineHeight: 20,
  },
  codeInput: {
    fontSize: 28,
    fontWeight: '600',
    letterSpacing: 6,
    textAlign: 'center',
    paddingVertical: 18,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 16 },
  flex: { flex: 1 },
  camera: {
    marginTop: 20,
    width: '100%',
    aspectRatio: 1,
    borderRadius: RADIUS.card + 6,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  cameraBlocked: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28 },
  reticle: { position: 'absolute', top: '18%', bottom: '18%', left: '18%', right: '18%' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: '#ffffff' },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 12 },
  br: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 12,
  },
  error: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
    padding: 14,
    borderRadius: RADIUS.control + 4,
    borderCurve: 'continuous',
  },
  errorText: { flex: 1, fontSize: TEXT.small, lineHeight: 20 },
  progress: { marginTop: 20, padding: 22, gap: 16, alignItems: 'stretch' },
  progressText: { fontSize: TEXT.body, textAlign: 'center', lineHeight: 22 },
});
