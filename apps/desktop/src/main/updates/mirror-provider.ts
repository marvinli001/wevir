// electron-updater 的自定义 provider（ADR-0007 补记 4）：取清单、验签与选线路都在 feed.ts，这里只把结果交给 electron-updater，
// 下载、blockmap 差分、sha512 校验与安装仍由它做。清单里的文件地址相对于发布目录，下载走的就是选中的那条线路。

import { Provider, type ResolvedUpdateFileInfo, type UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider.js';
import type { MirrorManifest } from './feed.js';

/** provider 向更新控制器要这一次检查的结果。 */
export interface FeedSource {
  latest(): Promise<MirrorManifest>;
}

/** `setFeedURL({ provider: 'custom', updateProvider: MirrorProvider, feed })` 交进来的配置。 */
interface MirrorProviderOptions {
  feed: FeedSource;
}

export class MirrorProvider extends Provider<UpdateInfo> {
  readonly #feed: FeedSource;
  #baseUrl: URL | undefined;

  constructor(
    options: MirrorProviderOptions,
    _updater: unknown,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    // R2 与 Caddy 不一定支持一次请求多个 Range，差分下载按单个 Range 逐段取。
    super({ ...runtimeOptions, isUseMultipleRangeRequest: false });
    this.#feed = options.feed;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const result = await this.#feed.latest();
    this.#baseUrl = new URL(result.baseUrl);
    return result.info as unknown as UpdateInfo;
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    const base = this.#baseUrl;
    if (base === undefined) throw new Error('resolveFiles called before getLatestVersion');
    return updateInfo.files.map((info) => ({ url: new URL(info.url, base), info }));
  }
}
