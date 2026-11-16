import { THEMABLE_TOKENS } from '@wevir/protocol';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { platformApi } from '@/platform/platform';
import { useProjectBackdrop } from '@/projects/backdrop';
import { isThemeSceneUrl } from '../../../shared/theme-assets.js';
import { setThemeBackdropPresentation, subscribeAppearance } from './appearance';
import { customThemeStore, reportThemeBackdrop } from './custom-theme';
import type { CachedCustomTheme } from './custom-theme-model';
import { resolvedTheme } from './theme';

const MOTION = '(prefers-reduced-motion: reduce)';
const TRANSPARENCY = '(prefers-reduced-transparency: reduce)';

function subscribePolicy(listener: () => void): () => void {
  const queries = [window.matchMedia(MOTION), window.matchMedia(TRANSPARENCY)];
  for (const query of queries) query.addEventListener('change', listener);
  document.addEventListener('visibilitychange', listener);
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-low-gpu'],
  });
  return () => {
    for (const query of queries) query.removeEventListener('change', listener);
    document.removeEventListener('visibilitychange', listener);
    observer.disconnect();
  };
}

function policySnapshot(): number {
  const reduced =
    window.matchMedia(MOTION).matches ||
    window.matchMedia(TRANSPARENCY).matches ||
    document.documentElement.hasAttribute('data-low-gpu');
  return (reduced ? 1 : 0) | (document.visibilityState === 'visible' ? 2 : 0);
}

export function themeSceneMessage(visible: boolean) {
  const style = getComputedStyle(document.documentElement);
  return {
    type: 'wevir-theme',
    mode: resolvedTheme(),
    tokens: Object.fromEntries(
      THEMABLE_TOKENS.flatMap((token) => {
        const value = style.getPropertyValue(`--${token}`).trim();
        return value && CSS.supports('color', value) ? [[token, value]] : [];
      }),
    ),
    reducedMotion: window.matchMedia(MOTION).matches,
    visible,
  };
}

export function ThemeBackdropLayer({
  scope,
  workspaceId,
  suspended = false,
}: {
  scope: 'conversation' | 'window';
  workspaceId: string | undefined;
  suspended?: boolean;
}) {
  const state = customThemeStore.use();
  const project = useProjectBackdrop(workspaceId);
  const policy = useSyncExternalStore(subscribePolicy, policySnapshot);
  const reduced = (policy & 1) !== 0;
  const visible = (policy & 2) !== 0 && !suspended;
  const theme = state.theme;
  const backdrop = theme?.backdrop;
  const selected =
    backdrop && !project && !suspended && (backdrop.scope ?? 'conversation') === scope;
  const asset = reduced && backdrop?.kind !== 'image' ? 'poster' : 'file';
  const url = selected ? theme?.assets[asset] : undefined;
  const src = state.failedAssets?.[asset] === url ? undefined : url;

  useLayoutEffect(() => {
    if (!selected) return;
    setThemeBackdropPresentation(
      Boolean(src) && scope === 'window',
      Boolean(src) && backdrop.glass === true,
      reduced,
    );
    return () => setThemeBackdropPresentation(false, false);
  }, [selected, src, scope, backdrop?.glass, reduced]);

  if (!theme || !backdrop || !src) return null;
  return (
    <BackdropMedia
      key={`${theme.hostId}:${theme.id}:${theme.revision}:${src}`}
      theme={theme}
      asset={asset}
      src={src}
      kind={asset === 'poster' ? 'image' : backdrop.kind}
      scope={scope}
      visible={visible}
      reduced={reduced}
    />
  );
}

function BackdropMedia({
  theme,
  asset,
  src,
  kind,
  scope,
  visible,
  reduced,
}: {
  theme: CachedCustomTheme;
  asset: 'file' | 'poster';
  src: string;
  kind: 'image' | 'video' | 'scene';
  scope: 'conversation' | 'window';
  visible: boolean;
  reduced: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState<{ id: string; url: string }>();
  const failed = useRef(false);
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const fit = theme.backdrop?.fit ?? 'cover';
  const fail = useCallback(() => {
    failed.current = true;
    reportThemeBackdrop(theme, asset, src, 'failed');
  }, [theme, asset, src]);
  const ready = () => {
    if (failed.current) return;
    setLoaded(true);
    reportThemeBackdrop(theme, asset, src, 'loaded');
  };

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (visible) void element.play().catch(() => undefined);
    else element.pause();
    return () => element.pause();
  }, [visible]);

  useEffect(() => {
    if (kind !== 'scene' || !visible) return;
    const controller = new AbortController();
    const api = platformApi();
    const sceneId = `wevir-theme-${crypto.randomUUID()}`;
    const sceneUrl = new URL(src);
    sceneUrl.searchParams.set('theme-mount', sceneId);
    const mountedSrc = sceneUrl.href;
    // 订阅并登记独立挂载身份后才给 iframe src，捕获首段内联脚本中的导航。
    const offFailure = api.onThemeSceneFailure((failure) => {
      if (
        !controller.signal.aborted &&
        failure.id === sceneId &&
        failure.url === mountedSrc &&
        (!frame.current || frame.current.src === mountedSrc)
      )
        fail();
    });
    const timeout = setTimeout(() => {
      fail();
      controller.abort();
    }, 15_000);
    // iframe 的 load 对 HTTP 失败也会触发；只预检 Host 的可信文件地址。
    void api
      .setThemeScene({ id: sceneId, url: mountedSrc })
      .then(() => {
        if (controller.signal.aborted) return undefined;
        return fetch(src, {
          method: 'HEAD',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          signal: controller.signal,
        });
      })
      .then((response) => {
        if (!response || controller.signal.aborted || failed.current) return;
        if (!response.ok) throw new Error('Background unavailable');
        setAttempt({ id: sceneId, url: mountedSrc });
      })
      .catch(() => {
        if (!controller.signal.aborted) fail();
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      clearTimeout(timeout);
      controller.abort();
      offFailure();
      void api.setThemeScene({ id: sceneId }).catch(() => undefined);
      setAttempt(undefined);
      setLoaded(false);
    };
  }, [kind, visible, src, fail]);

  useEffect(() => {
    const element = frame.current;
    if (kind !== 'scene' || !loaded || !attempt || element?.src !== attempt.url) return;
    const send = () => element.contentWindow?.postMessage(themeSceneMessage(visible), '*');
    send();
    const stop = subscribeAppearance(send);
    return () => {
      stop();
      element.contentWindow?.postMessage(themeSceneMessage(false), '*');
    };
  }, [kind, loaded, visible, attempt]);

  return (
    <div
      aria-hidden
      inert
      className="theme-backdrop"
      data-theme-backdrop={scope}
      data-backdrop-kind={kind}
      data-fit={fit}
      data-loaded={loaded || undefined}
      data-reduced={reduced || undefined}
    >
      <div className="theme-backdrop-media">
        {kind === 'image' && (
          <>
            <img src={src} alt="" draggable={false} onLoad={ready} onError={fail} />
            {fit === 'tile' && (
              <div
                className="theme-backdrop-tiles"
                style={{ backgroundImage: `url(${JSON.stringify(src)})` }}
              />
            )}
          </>
        )}
        {kind === 'video' && (
          <video
            ref={video}
            src={src}
            muted
            loop
            playsInline
            autoPlay={visible}
            disablePictureInPicture
            disableRemotePlayback
            preload="auto"
            onLoadedData={ready}
            onError={fail}
          />
        )}
        {kind === 'scene' && visible && attempt && isThemeSceneUrl(src) && (
          <iframe
            key={attempt.id}
            ref={frame}
            src={attempt.url}
            name={attempt.id}
            title={theme.name}
            sandbox="allow-scripts"
            aria-hidden
            tabIndex={-1}
            inert
            referrerPolicy="no-referrer"
            onLoad={() => {
              if (frame.current?.src === attempt.url) ready();
            }}
          />
        )}
      </div>
      <div className="theme-backdrop-scrim" />
    </div>
  );
}
