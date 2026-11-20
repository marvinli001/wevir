// 输入栏里的模型按钮，照 Codex App：写着“模型 力度”（快速模式时前面一道闪电），点开是贴着按钮的小卡片：上面一行是模型与力度，
// 点它进“配置”；下面是分档的力度条，拖动或点一下选档，松手生效。“配置”是底部浮起的小面板：引擎与账号（新建会话有多个来源时）、
// 模型、速度（Host 有快速模式且模型支持时），每行点开是从行上展开的菜单（menu.tsx），最后一枚“完成”。模型没有力度档位时点按钮
// 直接打开配置。打开时先收起键盘，再把卡片摆在输入栏上方、右边对齐按钮。卡片是实底：透明 Modal 里的 Liquid Glass 有时画不出来。
// 新建会话与会话页共用；改动交给调用方（建会话时带上，或 `session.configure`）。

import type { AccountState, ProviderProfile } from '@wevir/protocol';
import * as Haptics from 'expo-haptics';
import {
  createContext,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  type HostInstance,
  Keyboard,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../i18n';
import {
  effectiveEffort,
  effectiveFast,
  effortLabel,
  modelOf,
  stepAt,
  withModel,
} from '../lib/model-picker';
import {
  type ModelChoice,
  modelName,
  modelsOf,
  providerTitle,
  resolveChoice,
} from '../lib/new-session';
import { useReducedMotion } from '../state/reduced-motion';
import { TEXT, useTheme } from '../theme';
import { type MenuSection, MenuTrigger } from './menu';
import { Button, Icon } from './ui';

interface Anchor {
  /** 按钮的右边。 */
  right: number;
  /** 卡片的下边要在它上面（输入栏的上边，没有输入栏时是按钮的上边）。 */
  top: number;
}

/** 输入栏（composer.tsx）给模型按钮的位置参照：卡片摆在整个输入栏上方，不盖住正在写的字。 */
export const ModelAnchorContext = createContext<RefObject<HostInstance | null> | undefined>(
  undefined,
);

export function ModelPicker({
  choice,
  provider,
  sources,
  fastMode,
  disabled = false,
  onChange,
}: {
  /** 现在的来源、模型、力度与速度。 */
  choice: ModelChoice;
  /** `choice` 的来源。 */
  provider: ProviderProfile;
  /** 能换的来源（新建会话）；多于一个时配置里有“引擎与账号”。 */
  sources?: {
    providers: readonly ProviderProfile[];
    accounts: readonly AccountState[] | undefined;
  };
  /** Host 有快速模式（`fast_mode`）。 */
  fastMode: boolean;
  disabled?: boolean;
  onChange: (next: ModelChoice) => void;
}) {
  const theme = useTheme();
  const anchor = useRef<HostInstance>(null);
  const bar = useContext(ModelAnchorContext);
  const [open, setOpen] = useState<{ mode: 'effort' | 'config'; anchor: Anchor }>();
  const model = modelOf(provider, choice);
  const efforts = useMemo(() => [...(model?.reasoningEfforts ?? [])], [model]);
  const effort = effectiveEffort(choice, model);
  const fast = fastMode && effectiveFast(choice, model);
  const name = model !== undefined ? modelName(model) : choice.modelId;
  const effortText = efforts.length > 0 || effort !== undefined ? effortLabel(effort) : undefined;

  const show = () => {
    const mode = efforts.length > 0 ? 'effort' : 'config';
    const measure = () =>
      anchor.current?.measureInWindow((x, y, width) => {
        const place = (top: number) => setOpen({ mode, anchor: { right: x + width, top } });
        if (bar?.current) bar.current.measureInWindow((_, barY) => place(Math.min(barY, y)));
        else place(y);
      });
    if (!Keyboard.isVisible()) {
      measure();
      return;
    }
    // 键盘收起后页面才把输入栏放回底部（Android 在 keyboardDidHide 之后才重排），稍等一下再量按钮的位置。
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      subscription.remove();
      clearTimeout(timer);
      setTimeout(measure, 150);
    };
    const subscription = Keyboard.addListener('keyboardDidHide', once);
    const timer = setTimeout(once, 500);
    Keyboard.dismiss();
  };

  const close = () => setOpen(undefined);

  return (
    <>
      <Pressable
        ref={anchor}
        accessibilityRole="button"
        accessibilityLabel={`${t('newSession.model')}, ${[name, effortText].filter(Boolean).join(' ')}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => {
          void Haptics.selectionAsync().catch(() => {});
          show();
        }}
        hitSlop={6}
        style={({ pressed }) => [styles.button, { opacity: disabled ? 0.4 : pressed ? 0.5 : 1 }]}
        testID="model-picker"
      >
        {fast && (
          <Icon
            name={{ ios: 'bolt.fill', android: 'bolt' }}
            size={11}
            color={theme.softForeground}
          />
        )}
        <Text style={[styles.buttonName, { color: theme.foreground }]} numberOfLines={1}>
          {name}
        </Text>
        {effortText !== undefined && (
          <Text style={[styles.buttonEffort, { color: theme.mutedForeground }]} numberOfLines={1}>
            {effortText}
          </Text>
        )}
      </Pressable>
      <Modal
        visible={open !== undefined}
        transparent
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={close}
      >
        {open?.mode === 'effort' && (
          <EffortCard
            anchor={open.anchor}
            name={name}
            fast={fast}
            efforts={efforts}
            effort={effort}
            onClose={close}
            onConfigure={() => setOpen({ ...open, mode: 'config' })}
            onChange={(next) => {
              if (next === choice.reasoningEffort) return;
              onChange({ ...choice, reasoningEffort: next });
            }}
          />
        )}
        {open?.mode === 'config' && (
          <ConfigSheet
            choice={choice}
            provider={provider}
            {...(sources !== undefined && { sources })}
            fastMode={fastMode}
            onClose={close}
            onChange={onChange}
          />
        )}
      </Modal>
    </>
  );
}

/** 贴着按钮的小卡片：模型与力度一行（点它进配置），下面是力度条。 */
function EffortCard({
  anchor,
  name,
  fast,
  efforts,
  effort,
  onClose,
  onConfigure,
  onChange,
}: {
  anchor: Anchor;
  name: string;
  fast: boolean;
  efforts: readonly string[];
  effort: string | undefined;
  onClose: () => void;
  onConfigure: () => void;
  onChange: (effort: string) => void;
}) {
  const theme = useTheme();
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const [preview, setPreview] = useState(effort);
  const appear = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    Animated.spring(appear, {
      toValue: 1,
      useNativeDriver: true,
      damping: 22,
      stiffness: 320,
      mass: 0.8,
    }).start();
  }, [appear, reduced]);
  const width = Math.min(window.width - 24, efforts.length * STEP + CARD_PADDING * 2);
  // 右边对齐按钮的右边，放不下时贴着屏幕边。
  const right = Math.min(Math.max(12, window.width - anchor.right - 8), window.width - width - 12);
  const body = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('model.config')}
        onPress={onConfigure}
        hitSlop={8}
        style={({ pressed }) => [styles.cardHeader, { opacity: pressed ? 0.5 : 1 }]}
        testID="model-picker-configure"
      >
        {fast && (
          <Icon
            name={{ ios: 'bolt.fill', android: 'bolt' }}
            size={12}
            color={theme.softForeground}
          />
        )}
        <Text style={[styles.cardName, { color: theme.foreground }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.cardEffort, { color: theme.mutedForeground }]} numberOfLines={1}>
          {effortLabel(preview)}
        </Text>
        <Icon
          name={{ ios: 'chevron.right', android: 'chevron_right' }}
          size={Platform.OS === 'android' ? 18 : 11}
          weight="semibold"
          color={theme.mutedForeground}
        />
      </Pressable>
      <EffortSlider
        efforts={efforts}
        value={effort}
        onPreview={setPreview}
        onChange={(next) => {
          onChange(next);
        }}
      />
    </>
  );
  const animated = {
    opacity: appear,
    transform: [
      { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
      { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
    ],
  };
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t('model.done')}
        onPress={onClose}
      />
      <Animated.View
        style={[
          styles.cardWrap,
          { width, right, bottom: window.height - anchor.top + 8 },
          animated,
        ]}
      >
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.card,
              borderColor: theme.border,
              borderWidth: StyleSheet.hairlineWidth,
            },
            !theme.dark && styles.shadow,
          ]}
        >
          {body}
        </View>
      </Animated.View>
    </View>
  );
}

const STEP = 44;
const TRACK = 44;
const KNOB = 36;
const DOT = 5;
const CARD_PADDING = 10;

/**
 * 分档的力度条：墨色从左边铺到选中的那一档，白色圆钮停在那一档，每档一个小点。按下的地方就是那一档，拖动时跟着手指一档一档走
 * （每换一档轻震一下），松手才交给 `onChange`。读屏是可调节的控件，上下滑换档。
 */
function EffortSlider({
  efforts,
  value,
  onPreview,
  onChange,
}: {
  efforts: readonly string[];
  value: string | undefined;
  onPreview: (effort: string | undefined) => void;
  onChange: (effort: string) => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const count = efforts.length;
  const width = count * STEP;
  const [index, setIndex] = useState(() => efforts.indexOf(value ?? ''));
  const live = useRef(index);
  const start = useRef(0);
  const position = useRef(new Animated.Value(Math.max(0, index))).current;

  const moveTo = (next: number) => {
    if (next === live.current) return;
    live.current = next;
    setIndex(next);
    onPreview(efforts[next]);
    void Haptics.selectionAsync().catch(() => {});
    if (reduced) position.setValue(next);
    else
      Animated.spring(position, {
        toValue: next,
        useNativeDriver: false,
        damping: 24,
        stiffness: 420,
        mass: 0.7,
      }).start();
  };
  const commit = () => {
    const effort = efforts[live.current];
    if (effort !== undefined) onChange(effort);
  };
  // 回调里要用最新的 moveTo / commit（档位、onChange 会变）。
  const handlers = useRef({ moveTo, commit });
  handlers.current = { moveTo, commit };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          start.current = e.nativeEvent.locationX;
          handlers.current.moveTo(stepAt(start.current, width, count));
        },
        onPanResponderMove: (_, gesture) =>
          handlers.current.moveTo(stepAt(start.current + gesture.dx, width, count)),
        onPanResponderRelease: () => handlers.current.commit(),
        onPanResponderTerminate: () => handlers.current.commit(),
      }),
    [width, count],
  );

  const step = (delta: number) => {
    const next = Math.min(count - 1, Math.max(0, (live.current < 0 ? 0 : live.current) + delta));
    moveTo(next);
    commit();
  };

  const chosen = index >= 0;
  const fill = position.interpolate({
    inputRange: [0, Math.max(1, count - 1)],
    outputRange: [STEP, Math.max(1, count - 1) * STEP + STEP],
    extrapolate: 'clamp',
  });
  const knob = position.interpolate({
    inputRange: [0, 1],
    outputRange: [(STEP - KNOB) / 2, (STEP - KNOB) / 2 + STEP],
  });

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('newSession.effort')}
      accessibilityValue={{ text: effortLabel(efforts[index]) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
      style={[styles.track, { width, backgroundColor: theme.muted }]}
      testID="model-picker-effort"
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {chosen && (
          <Animated.View style={[styles.fill, { width: fill, backgroundColor: theme.primary }]} />
        )}
        {efforts.map((effort, i) => (
          <View
            key={effort}
            style={[
              styles.dot,
              {
                left: i * STEP + (STEP - DOT) / 2,
                backgroundColor:
                  chosen && i <= index ? theme.primaryForeground : theme.mutedForeground,
                opacity: chosen && i <= index ? 0.45 : 0.55,
              },
            ]}
          />
        ))}
        {chosen && (
          <Animated.View
            style={[
              styles.knob,
              { backgroundColor: theme.primaryForeground, transform: [{ translateX: knob }] },
            ]}
          />
        )}
      </View>
    </View>
  );
}

/** 底部浮起的“配置”面板。 */
function ConfigSheet({
  choice,
  provider,
  sources,
  fastMode,
  onClose,
  onChange,
}: {
  choice: ModelChoice;
  provider: ProviderProfile;
  sources?: {
    providers: readonly ProviderProfile[];
    accounts: readonly AccountState[] | undefined;
  };
  fastMode: boolean;
  onClose: () => void;
  onChange: (next: ModelChoice) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const appear = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) return;
    Animated.spring(appear, {
      toValue: 1,
      useNativeDriver: true,
      damping: 26,
      stiffness: 300,
      mass: 0.9,
    }).start();
  }, [appear, reduced]);
  const model = modelOf(provider, choice);
  const fast = effectiveFast(choice, model);

  const rows: { key: string; label: string; value: string; sections: MenuSection[] }[] = [];
  if (sources !== undefined && sources.providers.length > 1)
    rows.push({
      key: 'source',
      label: t('newSession.source'),
      value: providerTitle(provider, sources.accounts),
      sections: [
        {
          items: sources.providers.map((p) => ({
            id: p.id,
            label: providerTitle(p, sources.accounts),
            checked: p.id === choice.providerId,
            onPress: () => {
              if (p.id !== choice.providerId) {
                const next = resolveChoice([p], undefined);
                if (next !== undefined) onChange(next);
              }
            },
          })),
        },
      ],
    });
  rows.push({
    key: 'model',
    label: t('newSession.model'),
    value: model !== undefined ? modelName(model) : choice.modelId,
    sections: [
      {
        items: modelsOf(provider).map((m) => ({
          id: m.id,
          label: modelName(m),
          checked: m.id === choice.modelId,
          onPress: () => {
            if (m.id !== choice.modelId) onChange(withModel(provider, choice, m.id));
          },
        })),
      },
    ],
  });
  if (fastMode && model?.supportsFast === true)
    rows.push({
      key: 'speed',
      label: t('model.speed'),
      value: t(fast ? 'model.speed.fast' : 'model.speed.standard'),
      sections: [
        {
          items: [
            {
              label: t('model.speed.standard'),
              subtitle: t('model.speed.standardHint'),
              checked: !fast,
              onPress: () => {
                if (fast) onChange({ ...choice, fast: false });
              },
            },
            {
              label: t('model.speed.fast'),
              subtitle: t('model.speed.fastHint'),
              checked: fast,
              onPress: () => {
                if (!fast) onChange({ ...choice, fast: true });
              },
            },
          ],
        },
      ],
    });

  return (
    <View style={StyleSheet.absoluteFill}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.scrim, { opacity: appear }]}
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t('model.done')}
        onPress={onClose}
      />
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.card,
            bottom: Math.max(insets.bottom, 8),
            opacity: appear,
            transform: [
              { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) },
            ],
          },
          !theme.dark && styles.shadow,
        ]}
        testID="model-picker-sheet"
      >
        <View style={[styles.handle, { backgroundColor: theme.borderStrong }]} />
        <Text style={[styles.sheetTitle, { color: theme.foreground }]} accessibilityRole="header">
          {t('model.config')}
        </Text>
        <View style={[styles.group, { backgroundColor: theme.muted }]}>
          {rows.map((row, i) => (
            <View key={row.key}>
              {i > 0 && <View style={[styles.separator, { backgroundColor: theme.border }]} />}
              <MenuTrigger
                sections={row.sections}
                label={`${row.label}, ${row.value}`}
                title={row.label}
                testID={`model-picker-${row.key}`}
              >
                <View style={styles.row}>
                  <Text style={[styles.rowLabel, { color: theme.foreground }]}>{row.label}</Text>
                  <Text
                    style={[styles.rowValue, { color: theme.mutedForeground }]}
                    numberOfLines={1}
                  >
                    {row.value}
                  </Text>
                  <Icon
                    name={{ ios: 'chevron.up.chevron.down', android: 'unfold_more' }}
                    size={Platform.OS === 'android' ? 16 : 11}
                    weight="semibold"
                    color={theme.mutedForeground}
                  />
                </View>
              </MenuTrigger>
            </View>
          ))}
        </View>
        <Button title={t('model.done')} onPress={onClose} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 38,
    maxWidth: 190,
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
  },
  buttonName: { flexShrink: 1, fontSize: TEXT.small, fontWeight: '600' },
  buttonEffort: { flexShrink: 0, fontSize: TEXT.small, fontWeight: '500' },
  cardWrap: { position: 'absolute' },
  card: {
    borderRadius: 30,
    borderCurve: 'continuous',
    padding: CARD_PADDING,
    paddingTop: 12,
    gap: 10,
    alignItems: 'center',
  },
  shadow: { boxShadow: '0 8px 28px rgba(26, 26, 23, 0.14)' },
  cardHeader: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
  },
  cardName: { flexShrink: 1, fontSize: TEXT.small, fontWeight: '600' },
  cardEffort: { fontSize: TEXT.small, fontWeight: '500' },
  track: { height: TRACK, borderRadius: TRACK / 2, overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, borderRadius: TRACK / 2 },
  dot: {
    position: 'absolute',
    top: (TRACK - DOT) / 2,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
  },
  knob: {
    position: 'absolute',
    top: (TRACK - KNOB) / 2,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.18)',
  },
  scrim: { backgroundColor: 'rgba(0, 0, 0, 0.28)' },
  sheet: {
    position: 'absolute',
    left: 8,
    right: 8,
    borderRadius: 34,
    borderCurve: 'continuous',
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 18,
    gap: 16,
  },
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3 },
  sheetTitle: { alignSelf: 'center', fontSize: TEXT.title, fontWeight: '600', marginTop: -4 },
  group: { borderRadius: 22, borderCurve: 'continuous', overflow: 'hidden' },
  row: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  rowLabel: { flex: 1, fontSize: TEXT.body },
  rowValue: { flexShrink: 1, fontSize: TEXT.body },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
});
