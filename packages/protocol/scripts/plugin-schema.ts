// 从 src/plugins.ts、src/market.ts 生成 schemas/wevir-plugin.schema.json 与 schemas/wevir-market.schema.json：
// pnpm --filter @wevir/protocol schema。两个源文件只依赖 zod，Node 去掉类型后直接加载；
// market.ts 按包内写法 import './plugins.js'，这里把同目录的 .js 解析到 .ts。
// plugin-manifest.test.ts、market.test.ts 检查生成物与源一致。
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.startsWith('./') &&
      specifier.endsWith('.js') &&
      context.parentURL?.includes('/src/')
    )
      return next(specifier.replace(/\.js$/, '.ts'), context);
    return next(specifier, context);
  },
});

const { wevirPluginJsonSchema } = await import('../src/plugins.ts');
const { wevirMarketJsonSchema } = await import('../src/market.ts');
for (const [file, schema] of [
  ['wevir-plugin.schema.json', wevirPluginJsonSchema()],
  ['wevir-market.schema.json', wevirMarketJsonSchema()],
] as const) {
  writeFileSync(
    new URL(`../schemas/${file}`, import.meta.url),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}
