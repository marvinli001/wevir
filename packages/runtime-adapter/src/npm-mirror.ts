// SPDX-License-Identifier: MIT
// npm 包的镜像线路（npm-closure.ts 的 `mirrors`）：不 import 任何东西，发布脚本（apps/desktop/scripts/release.ts）不装依赖也能
// 直接引用，传上去的文件名与 Host 下载时拼的一致。

/** 一条镜像线路：每个包的 tgz 原样放在 `<url>/<npmMirrorAssetName(包)>`。 */
export interface NpmClosureMirror {
  id: string;
  /** 根地址，不带末尾的 `/`。 */
  url: string;
  /** 后备线路：不参加竞速，前面的线路都下不了一个包时才试。 */
  fallback?: true;
}

/**
 * 包在镜像线路上的文件名：去掉作用域的 `@`、`/` 换成 `-`，加版本，如 `deepseek-ai-libreoffice-kit-wasm-0.2.0.tgz`。
 * 平铺是因为 GitHub Release 的附件名不能有目录；不同的包可能撞名（`@a/b` 与 `a-b`），发布脚本传之前核对。
 */
export function npmMirrorAssetName(entry: { name: string; version: string }): string {
  return `${entry.name.replace(/^@/u, '').replace('/', '-')}-${entry.version}.tgz`;
}
