import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsdown';

const require = createRequire(import.meta.url);
/** 打进 dist/ 的依赖的 LICENSE（zod 是 @wevir/protocol 的依赖，从它那里解析）。 */
const licenseOf = (pkg: string, from = require) =>
  join(dirname(from.resolve(`${pkg}/package.json`)), 'LICENSE');
const protocolRequire = createRequire(require.resolve('@wevir/protocol/package.json'));

export default defineConfig({
  // main.ts 是可执行入口 wevir-relay（package.json 的 bin）；index.ts 给 Host 的端到端测试与自己嵌入的人用。
  // @wevir/protocol 与 ws 打进来：Docker 镜像里只放 dist/，不装依赖（Dockerfile）。
  entry: ['src/index.ts', 'src/main.ts'],
  platform: 'node',
  deps: { alwaysBundle: ['@wevir/protocol', 'ws', 'zod'] },
  // 打进来的 ws 与 zod（MIT）要随分发附上许可证文本：放在 dist/licenses/，Docker 镜像与直接拷 dist/ 都带着。
  copy: [
    { from: licenseOf('ws'), to: 'dist/licenses', rename: 'ws.txt' },
    { from: licenseOf('zod', protocolRequire), to: 'dist/licenses', rename: 'zod.txt' },
  ],
  // platform 为 node 时 tsdown 默认输出 .mjs；与其他包一致按 "type": "module" 输出 .js。
  fixedExtension: false,
  dts: true,
});
