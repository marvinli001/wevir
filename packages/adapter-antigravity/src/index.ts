// @wevir/adapter-antigravity：Google Antigravity 的 ACP 运行体（订阅来源 `antigravity`，ADR-0005 补记 14，
// docs/architecture/antigravity-event-mapping.md），移植自 T3 Code。

export {
  AntigravityAccounts,
  type AntigravityAccountsOptions,
  LOGIN_TIMEOUT_MS,
} from './accounts.js';
export {
  ANTIGRAVITY_MODES,
  AntigravityAdapter,
  type AntigravityAdapterOptions,
} from './antigravity-adapter.js';
export {
  ANTIGRAVITY_ENGINE,
  ANTIGRAVITY_ROUTE,
  classifyAntigravityResumeError,
  classifyAntigravityTurnError,
} from './engine.js';
export {
  type AntigravityExecutable,
  AntigravityInstallation,
  AntigravityInstallationError,
  type AntigravityInstallationOptions,
  AntigravityInstallCancelled,
  type InstallProgress,
} from './installation.js';
export { antigravityModelsFromSetup } from './models.js';
export { type AntigravityPaths, antigravityPaths } from './process.js';
export { antigravityUserSkillDirectories } from './profile.js';
export {
  ANTIGRAVITY_DOWNLOAD_ORIGIN,
  ANTIGRAVITY_RELEASE_VERSION,
  type AntigravityReleaseAsset,
  antigravityDownloadUrl,
  resolveAntigravityReleaseAsset,
} from './release.js';
