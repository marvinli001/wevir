import type { GatewayPrivacySource } from '@wevir/runtime-adapter';
import type { SecretStore, Storage } from '@wevir/storage';
import { readVariables } from './environment-variables.js';
import type { Logger } from './logger.js';
import type { PluginRegistry } from './plugins.js';
import type { HostSettingsStore } from './settings.js';

export function gatewayPrivacySource(options: {
  settings: HostSettingsStore;
  logger: Logger;
  plugins: PluginRegistry;
  storage: Storage;
  secrets: SecretStore;
}): GatewayPrivacySource {
  return {
    settings: () => options.settings.gatewayPrivacy(),
    secrets: async () => {
      const environments = await Promise.all(
        options.storage.environments
          .list()
          .map((environment) => readVariables(options.secrets, environment.id, true)),
      );
      return [
        ...options.logger.secretValues(),
        ...Object.values(process.env).filter(
          (value): value is string => value !== undefined && value.length >= 8,
        ),
        ...options.plugins.appToolSecrets(),
        ...environments.flatMap((entries) => entries.map(([, value]) => value)),
      ];
    },
  };
}
