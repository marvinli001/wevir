// 推送的原生一侧（expo-notifications）：系统令牌、通知权限、Android 的通知渠道，以及收静默推送的后台任务。
//
// 网关推来的两种数据（push.ts 的 `parsePushData`）都进同一个后台任务（`registerTaskAsync`；App 在前台、后台、没开时都跑，没开时
// Android 由 expo-task-manager 起一个无界面的 JS 运行时）：
// - `verify`：验证码，交给正在登记的 `PushRegistrar`（只在 App 开着、正在登记时有用）；
// - `push`：加密载荷。iOS 上它是带 `mutable-content` 的提醒，由通知服务扩展解密改写，不进这里；Android 上它是高优先级的 FCM 数据
//   消息，在这里解密、生成本地通知。Expo 58 的 FirebaseMessagingService 已把数据消息交给这个任务，所以不自己写原生的
//   FirebaseMessagingService。
//
// 本文件要在入口最先 import（`TaskManager.defineTask` 必须在模块顶层，无界面启动时也要跑到）。

import Constants from 'expo-constants';
import { getLocales } from 'expo-localization';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { pickLocale, setLocale, t } from '../i18n';
import {
  type DeviceToken,
  openPush,
  PUSH_TARGET_KEY,
  type PushTarget,
  parsePushData,
  pushContent,
  pushTarget,
  readPushTarget,
  replayGuards,
  type TokenUnavailable,
} from './push';
import { loadPushKeys, readReplayStates, readSharedState, writeReplayStates } from './push-store';

/** 后台任务名。 */
export const PUSH_TASK = 'wevir-push';
/** iOS 通知扩展改写后的类别：锁屏隐藏预览时显示“需要处理”（`previewPlaceholder`）。 */
export const PUSH_CATEGORY = 'wevir.push';
/** Android 的两个渠道：锁屏显示内容 / 锁屏隐藏内容（渠道建好后可见性改不了，所以分两个）。 */
export const PUSH_CHANNEL = 'wevir.push';
export const PUSH_CHANNEL_PRIVATE = 'wevir.push.private';

/** 构建时定下的推送配置（app.config.ts 的 `extra.push`）。 */
export interface PushBuildConfig {
  /** 打包了 google-services.json：Android 才有 FCM 令牌。 */
  fcm: boolean;
  /** iOS 的 `aps-environment`：开发构建的令牌只在 APNs 沙盒有效。 */
  apnsEnvironment: 'development' | 'production';
}

export function pushBuildConfig(): PushBuildConfig {
  const extra = Constants.expoConfig?.extra?.push as Partial<PushBuildConfig> | undefined;
  return {
    fcm: extra?.fcm === true,
    apnsEnvironment: extra?.apnsEnvironment === 'production' ? 'production' : 'development',
  };
}

/**
 * 系统的推送令牌：没问过通知权限时先问。Android 没打包 FCM 配置时直接 `unavailable`（国内安卓同样没有 FCM，首版只在 App 前台时
 * 提醒）。开发时模拟器拿不到令牌可设 `EXPO_PUBLIC_WEVIR_PUSH_TOKEN`（只在开发构建里认）。
 */
export async function deviceToken(): Promise<DeviceToken | TokenUnavailable> {
  const config = pushBuildConfig();
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'unavailable';
  if (Platform.OS === 'android' && !config.fcm) return 'unavailable';
  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
  }
  if (!permission.granted) return 'denied';
  const platform =
    Platform.OS === 'android'
      ? 'fcm'
      : config.apnsEnvironment === 'production'
        ? 'apns'
        : 'apns_sandbox';
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data === 'string' && token.data !== '') return { platform, token: token.data };
  } catch (error) {
    console.warn('[wevir] no push token', error);
  }
  const override = __DEV__ ? process.env.EXPO_PUBLIC_WEVIR_PUSH_TOKEN : undefined;
  if (override !== undefined && override !== '') return { platform, token: override };
  return 'unavailable';
}

/** Android 的通知渠道（重复调用无妨，名称跟着语言更新）。 */
export async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL, {
    name: t('push.channel'),
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync(PUSH_CHANNEL_PRIVATE, {
    name: t('push.channelPrivate'),
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}

/** iOS 的通知类别：用户把“显示预览”设成“解锁时”后，锁屏上显示“需要处理”。 */
export async function ensureIosCategory(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  await Notifications.setNotificationCategoryAsync(PUSH_CATEGORY, [], {
    previewPlaceholder: t('push.generic'),
  });
}

let verifyCodeSink: ((code: string) => void) | undefined;
let suppressWhileOpen: ((computer: string) => boolean) | undefined;

/** 正在登记时收验证码。 */
export function setVerifyCodeSink(sink: ((code: string) => void) | undefined): void {
  verifyCodeSink = sink;
}

/** App 在前台、连着那台电脑时不另弹系统通知（应用内的提醒条已经弹了）。 */
export function setForegroundSuppression(check: ((computer: string) => boolean) | undefined): void {
  suppressWhileOpen = check;
}

/** Android：解开一条推送并生成本地通知。解不开时显示通用的“需要处理”，重放的丢掉。 */
async function presentAndroidPush(payload: string): Promise<void> {
  setLocale(pickLocale(getLocales().map((l) => l.languageTag)));
  const shared = await readSharedState();
  const replay = replayGuards(await readReplayStates());
  const opened = openPush(payload, await loadPushKeys(shared), replay.guard);
  if (opened.kind === 'ok' || opened.kind === 'replayed') await writeReplayStates(replay.save());
  if (opened.kind === 'replayed') return;
  if (opened.kind === 'ok' && suppressWhileOpen?.(opened.computer.name)) return;
  await ensureAndroidChannels();
  const channelId = shared.hideOnLockScreen ? PUSH_CHANNEL_PRIVATE : PUSH_CHANNEL;
  if (opened.kind !== 'ok') {
    await Notifications.scheduleNotificationAsync({
      content: { title: 'Wevir', body: t('push.generic'), sound: 'default' },
      trigger: { channelId },
    });
    return;
  }
  const { computer, message } = opened;
  const content = pushContent(message, (kind) => t(`notify.${kind}`));
  await Notifications.scheduleNotificationAsync({
    // 同一会话的提醒互相取代（同 APNs 的 collapse-id）。
    identifier: `wevir:${computer.name}:${message.sessionId ?? message.channelId ?? message.id}`,
    content: {
      title: content.title,
      ...(content.subtitle !== '' && { subtitle: content.subtitle }),
      body: content.body,
      sound: 'default',
      data: { [PUSH_TARGET_KEY]: pushTarget(computer, message) },
    },
    trigger: { channelId },
  });
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(
  PUSH_TASK,
  async ({ data, error }) => {
    if (error !== null || data === undefined || data === null || 'actionIdentifier' in data) {
      return Notifications.BackgroundNotificationTaskResult.NoData;
    }
    const parsed = parsePushData(data.data);
    if (parsed === undefined) return Notifications.BackgroundNotificationTaskResult.NoData;
    if (parsed.kind === 'verify') {
      verifyCodeSink?.(parsed.code);
      return Notifications.BackgroundNotificationTaskResult.NewData;
    }
    if (Platform.OS !== 'android') return Notifications.BackgroundNotificationTaskResult.NoData;
    try {
      await presentAndroidPush(parsed.payload);
      return Notifications.BackgroundNotificationTaskResult.NewData;
    } catch (cause) {
      console.warn('[wevir] could not show a push', cause);
      return Notifications.BackgroundNotificationTaskResult.Failed;
    }
  },
);

/** 登记后台任务（App 每次启动调一次；没装原生模块的环境里静默失败）。 */
/**
 * 一条系统通知要去的会话或助理：先看通知服务扩展写进去的 `wevirTarget`；没有时（扩展没跑成：超时、出错，或模拟器上的
 * `simctl push`，系统就显示原样的“需要处理”）用钥匙串里的推送密钥在 App 里再解一次原始载荷。只为找去处，不查也不记重放。
 */
export async function pushTargetOf(
  request: Notifications.NotificationRequest,
): Promise<PushTarget | undefined> {
  const trigger = request.trigger as { payload?: unknown } | null;
  for (const raw of [request.content.data, trigger?.payload]) {
    const target = readPushTarget(raw);
    if (target !== undefined) return target;
  }
  for (const raw of [request.content.data, trigger?.payload]) {
    const parsed = parsePushData(raw);
    if (parsed?.kind !== 'push') continue;
    const keys = await loadPushKeys(await readSharedState());
    const opened = openPush(parsed.payload, keys, replayGuards({}).guard);
    return opened.kind === 'ok' ? pushTarget(opened.computer, opened.message) : undefined;
  }
  return undefined;
}

export function registerPushTask(): void {
  Notifications.registerTaskAsync(PUSH_TASK).catch((cause: unknown) =>
    console.warn('[wevir] could not register the push task', cause),
  );
}
