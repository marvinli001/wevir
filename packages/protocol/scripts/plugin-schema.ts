// 从 src/plugins.ts 生成 schemas/wevir-plugin.schema.json：pnpm --filter @wevir/protocol schema。
// src/plugins.ts 只依赖 zod，Node 去掉类型后直接加载；plugin-schema.test.ts 检查生成物与源一致。
import { writeFileSync } from 'node:fs';
import { wevirPluginJsonSchema } from '../src/plugins.ts';

writeFileSync(
  new URL('../schemas/wevir-plugin.schema.json', import.meta.url),
  `${JSON.stringify(wevirPluginJsonSchema(), null, 2)}\n`,
);
