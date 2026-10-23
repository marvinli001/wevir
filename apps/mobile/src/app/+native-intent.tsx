// 系统打开的链接（系统相机扫到的二维码、点了 `wevir://pair?…`）：交给添加电脑页。

import { redirectSystemPath as redirect } from '../lib/deep-link';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    return redirect(path);
  } catch {
    return '/';
  }
}
