// 听写（0.92.0）要的麦克风权限。渲染进程其余的权限（摄像头、通知、剪贴板读取等）仍一律拒绝（Electron 安全清单第 5 条）；只放行
// 主窗口的主框架、来自应用自己的页面、只要音频的 `media` 请求。macOS 上系统还会按 Info.plist 的 NSMicrophoneUsageDescription 问一次，
// 签名的应用另要 `com.apple.security.device.audio-input`（build/entitlements.mac.plist）。

import { rendererOriginOf } from '../shared/renderer-origin.js';

/** `setPermissionRequestHandler` 给的那部分细节。 */
export interface MediaRequest {
  permission: string;
  /** `media` 请求要的设备种类（`audio`、`video`）。 */
  mediaTypes?: readonly string[] | undefined;
  /** 发起请求的页面地址。 */
  requestingUrl?: string | undefined;
  isMainFrame?: boolean | undefined;
}

/** 是不是应用自己的页面在主框架里只要麦克风。 */
export function allowMicrophoneRequest(
  request: MediaRequest,
  rendererOrigin: string | undefined,
): boolean {
  if (request.permission !== 'media' || rendererOrigin === undefined) return false;
  if (request.isMainFrame === false) return false;
  if (request.requestingUrl === undefined) return false;
  // 自定义协议（wevir://app）的 URL.origin 是 'null'，按 rendererOriginOf 取。
  if (rendererOriginOf(request.requestingUrl) !== rendererOrigin) return false;
  const types = request.mediaTypes ?? [];
  return types.length > 0 && types.every((type) => type === 'audio');
}

/** `setPermissionCheckHandler`：只回答应用自己的页面查询麦克风（`mediaType` 是 `audio`）。 */
export function allowMicrophoneCheck(
  permission: string,
  requestingOrigin: string,
  mediaType: string | undefined,
  rendererOrigin: string | undefined,
): boolean {
  return (
    rendererOrigin !== undefined &&
    permission === 'media' &&
    mediaType === 'audio' &&
    rendererOriginOf(requestingOrigin) === rendererOrigin
  );
}
