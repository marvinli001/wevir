// 打进 Worker 的依赖的许可证文本放到 dist/licenses/（与 apps/relay 的 dist/licenses/ 相同）。wrangler 把 @wevir/protocol 与它依赖的
// zod 打进 dist/index.js；别的 npm 包都没有打进去（Workers 自带 WebSocket 与 WebCrypto）。

import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = dirname(import.meta.dirname);
const require = createRequire(join(root, 'package.json'));
const protocolRequire = createRequire(require.resolve('@wevir/protocol/package.json'));
const out = join(root, 'dist', 'licenses');
mkdirSync(out, { recursive: true });
copyFileSync(
  join(dirname(protocolRequire.resolve('zod/package.json')), 'LICENSE'),
  join(out, 'zod.txt'),
);
