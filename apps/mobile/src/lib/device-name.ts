import { DEVICE_NAME_MAX_LENGTH } from '@wevir/protocol';

// iOS 16 起 UIDevice.name 默认只给机型类别（“iPhone”“iPad”），用户在“设置 > 通用 > 关于本机”里起的名字要有
// user-assigned-device-name 授权才读得到（app.config.ts）。没有授权时用具体机型（“iPhone 15 Pro”），比“iPhone”好认。
const GENERIC_NAMES = new Set(['iphone', 'ipad', 'ipod touch']);

const FALLBACK = 'Wevir Mobile';

/** 设备名称的初值：系统里的设备名（Android 的“设备名称”、iOS 的本机名称）；只是机型类别或没有时用机型。 */
export function pickDeviceName(deviceName: string | null, modelName: string | null): string {
  const system = deviceName?.trim() ?? '';
  const model = modelName?.trim() ?? '';
  const generic = system === '' || GENERIC_NAMES.has(system.toLowerCase());
  const name = generic && model !== '' ? model : system || FALLBACK;
  return name.slice(0, DEVICE_NAME_MAX_LENGTH);
}
