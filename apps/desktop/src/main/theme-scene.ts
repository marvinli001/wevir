import { isThemeSceneUrl } from '../shared/theme-assets.js';

interface SceneFrame {
  id: string;
  url: string;
  failed: boolean;
}

/** URL 可被 history 改写；首次导航即绑定跨进程导航仍不变的 frameTreeNodeId。 */
export class ThemeSceneGuard {
  readonly #registrations = new Map<string, string>();
  readonly #frames = new Map<number, SceneFrame>();

  constructor(readonly onFailure: (failure: { id: string; url: string }) => void) {}

  set(scene: { id: string; url?: string }, liveFrames: number[]): void {
    for (const id of this.#frames.keys()) {
      if (!liveFrames.includes(id)) this.#frames.delete(id);
    }
    if (scene.url) this.#registrations.set(scene.id, scene.url);
    else this.#registrations.delete(scene.id);
  }

  begin(frameId: number, url: string, directChild: boolean): void {
    if (this.#frames.has(frameId)) {
      this.fail(frameId);
      return;
    }
    if (!directChild || !isThemeSceneUrl(url)) return;
    const id = new URL(url).searchParams.get('theme-mount');
    if (id === null || this.#registrations.get(id) !== url) return;
    this.#frames.set(frameId, { id, url, failed: false });
  }

  blocks(frameId: number | undefined, url: string): boolean {
    if (frameId === undefined) return false;
    const frame = this.#frames.get(frameId);
    if (!frame) return false;
    if (!frame.failed && frame.url === url) return false;
    this.fail(frameId);
    return true;
  }

  fail(frameId: number): void {
    const frame = this.#frames.get(frameId);
    if (!frame || frame.failed) return;
    frame.failed = true;
    if (this.#registrations.get(frame.id) === frame.url)
      this.onFailure({ id: frame.id, url: frame.url });
  }
}
