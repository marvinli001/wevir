// Metro 配置：Expo 的默认配置已处理 pnpm 工作区（watchFolders 含仓库根目录，按包的 exports 解析）。这里只加两件事：
// - 认 `@wevir/source` 条件，直接打包工作区包的 src/*.ts，开发时不用先 pnpm build（与 typecheck、Vitest 一致，ADR-0004 补记 1）；
// - 工作区包的源码按 NodeNext 写相对导入（`./client.js` 指 `client.ts`），Metro 不会把 `.js` 换成 `.ts`，找不到时改试 `.ts`。
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_conditionNames = [
  '@wevir/source',
  ...(config.resolver.unstable_conditionNames ?? []),
];

const resolveDefault = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveDefault ?? context.resolveRequest;
  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    isWorkspaceSource(context.originModulePath)
  ) {
    try {
      return resolve(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // 真的是 .js 文件。
    }
  }
  return resolve(context, moduleName, platform);
};

function isWorkspaceSource(path) {
  return /[\\/]packages[\\/][^\\/]+[\\/]src[\\/]/.test(path) && !path.includes('node_modules');
}

module.exports = config;
