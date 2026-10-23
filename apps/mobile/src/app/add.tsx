// 添加电脑：扫二维码（expo-camera）、粘贴配对链接（模拟器没有相机）或手输短码（局域网 mDNS）。握手之后等电脑上点“允许”，
// 允许了就记下这台电脑并打开它的详情。

import { DEVICE_NAME_MAX_LENGTH } from '@wevir/protocol';
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Button, Card } from '../components/ui';
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
import { RADIUS, TEXT, useTheme } from '../theme';

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

  const inputStyle = [
    styles.input,
    { backgroundColor: theme.card, borderColor: theme.borderStrong, color: theme.foreground },
  ];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.segments, { backgroundColor: theme.muted }]}>
          {(['scan', 'link', 'code'] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityState={{ selected: method === m }}
              disabled={busy}
              onPress={() => {
                setMethod(m);
                setError(undefined);
              }}
              style={[
                styles.segment,
                method === m && { backgroundColor: theme.dark ? theme.borderStrong : theme.card },
              ]}
            >
              <Text
                style={[
                  styles.segmentText,
                  { color: method === m ? theme.foreground : theme.mutedForeground },
                ]}
              >
                {t(`add.method.${m}`)}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.label, { color: theme.mutedForeground }]}>{t('add.deviceName')}</Text>
        <TextInput
          value={deviceName}
          onChangeText={setDeviceName}
          maxLength={DEVICE_NAME_MAX_LENGTH}
          editable={!busy}
          autoCorrect={false}
          style={inputStyle}
        />

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
              style={[inputStyle, styles.linkInput]}
            />
            <View style={styles.buttons}>
              <View style={styles.flex}>
                <Button
                  kind="secondary"
                  title={t('add.paste')}
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
          <Text style={[styles.error, { color: theme.destructive }]}>{error}</Text>
        )}

        {stage !== undefined && (
          <Card style={styles.progress}>
            <ActivityIndicator color={theme.mutedForeground} />
            <Text style={[styles.progressText, { color: theme.foreground }]}>
              {stageText(stage, name)}
            </Text>
            <Button kind="secondary" title={t('add.cancel')} onPress={cancel} />
          </Card>
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

/** 扫二维码：只认 QR，扫到一次就交出去，配对期间不再触发。 */
function Scanner({ active, onScan }: { active: boolean; onScan: (text: string) => void }) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<string | undefined>(undefined);
  if (permission === null)
    return <View style={[styles.camera, { backgroundColor: theme.muted }]} />;
  if (!permission.granted) {
    return (
      <View
        style={[
          styles.camera,
          styles.cameraBlocked,
          { backgroundColor: theme.card, borderColor: theme.border },
        ]}
      >
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
    <View style={[styles.camera, { backgroundColor: theme.muted }]}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  segments: { flexDirection: 'row', borderRadius: RADIUS.control + 2, padding: 2 },
  segment: {
    flex: 1,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.control,
  },
  segmentText: { fontSize: TEXT.small, fontWeight: '600' },
  label: {
    fontSize: TEXT.caption,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 6,
    marginHorizontal: 2,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.control,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: TEXT.body,
  },
  linkInput: {
    minHeight: 96,
    textAlignVertical: 'top',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: TEXT.small,
  },
  codeInput: {
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 14 },
  flex: { flex: 1 },
  camera: {
    marginTop: 20,
    width: '100%',
    aspectRatio: 1,
    borderRadius: RADIUS.card,
    overflow: 'hidden',
  },
  cameraBlocked: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 24,
    borderWidth: StyleSheet.hairlineWidth,
  },
  error: { marginTop: 16, fontSize: TEXT.small, lineHeight: 19 },
  progress: { marginTop: 20, padding: 20, gap: 14, alignItems: 'stretch' },
  progressText: { fontSize: TEXT.body, textAlign: 'center', lineHeight: 21 },
});
