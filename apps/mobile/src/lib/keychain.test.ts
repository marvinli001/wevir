import { describe, expect, it } from 'vitest';
import appConfig, { IOS_APP_GROUP as CONFIG_APP_GROUP } from '../../app.config';
import { IOS_APP_GROUP } from './keychain';

describe('keychain access group', () => {
  it('is the App Group the app config grants', () => {
    expect(CONFIG_APP_GROUP).toBe(IOS_APP_GROUP);
    const config = appConfig({ config: {} } as Parameters<typeof appConfig>[0]);
    expect(config.ios?.entitlements?.['com.apple.security.application-groups']).toEqual([
      IOS_APP_GROUP,
    ]);
  });
});
