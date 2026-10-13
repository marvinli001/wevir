import { describe, expect, it } from 'vitest';
import { buildDshEnv, STREAM_FD } from './env.js';

const paths = { dshHome: '/data/engines/dsh', agentsHome: '/data/engines/dsh-agents' };

/** 一个典型开发者 shell 的环境：有各家模型 Key、自己的 dsh 配置和 NODE_OPTIONS。 */
const userShell: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/dev',
  USER: 'dev',
  SHELL: '/bin/zsh',
  LANG: 'zh_CN.UTF-8',
  TMPDIR: '/var/folders/xy/T/',
  HTTPS_PROXY: 'http://127.0.0.1:7890',
  no_proxy: 'localhost',
  DEEPSEEK_API_KEY: 'sk-deepseek-from-shell',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  ANTHROPIC_API_KEY: 'sk-ant-from-shell',
  ANTHROPIC_AUTH_TOKEN: 'token-from-shell',
  OPENAI_API_KEY: 'sk-openai-from-shell',
  GEMINI_API_KEY: 'gemini-from-shell',
  WEVIR_PROVIDER_DEEPSEEK_KEY: 'sk-shell-not-host',
  DSH_HOME: '/Users/dev/.dsh',
  DSH_AGENTS_HOME: '/Users/dev/.agents',
  DSH_PROFILE: 'tui',
  DSH_PERMISSION_MODE: 'danger-full-access',
  DSH_TELEMETRY_DISABLED: '',
  NODE_OPTIONS: '--require ./hook.js --conditions @wevir/source',
  GITHUB_TOKEN: 'ghp-from-shell',
  AWS_SECRET_ACCESS_KEY: 'aws-from-shell',
};

describe('buildDshEnv', () => {
  it('只继承白名单：用户 shell 里的模型 Key、其他凭据、DSH_* 与 NODE_OPTIONS 都不传入', () => {
    const env = buildDshEnv({ paths, parent: userShell, platform: 'darwin' });
    for (const name of [
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'WEVIR_PROVIDER_DEEPSEEK_KEY',
      'DSH_PROFILE',
      'NODE_OPTIONS',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    const values = Object.values(env).join('\n');
    expect(values).not.toMatch(/from-shell|not-host/);
    expect(env).toMatchObject({
      PATH: userShell.PATH,
      HOME: userShell.HOME,
      USER: 'dev',
      SHELL: '/bin/zsh',
      LANG: 'zh_CN.UTF-8',
      TMPDIR: userShell.TMPDIR,
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      no_proxy: 'localhost',
    });
  });

  it('注入 DSH_HOME、DSH_AGENTS_HOME、关闭遥测、workspace-write，覆盖用户自己的同名变量', () => {
    const env = buildDshEnv({ paths, parent: userShell, platform: 'darwin' });
    expect(env).toMatchObject({
      DSH_HOME: paths.dshHome,
      DSH_AGENTS_HOME: paths.agentsHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      NO_COLOR: '1',
    });
    expect(env).not.toHaveProperty('WEVIR_STREAM_FD');
  });

  it('打开 fd 3 时设 WEVIR_STREAM_FD=3', () => {
    const env = buildDshEnv({ paths, parent: {}, streamFd: true });
    expect(env.WEVIR_STREAM_FD).toBe(String(STREAM_FD));
    expect(STREAM_FD).toBe(3);
  });

  it('extra 是模型 Key 的唯一入口，但不能覆盖固定注入的变量', () => {
    const env = buildDshEnv({
      paths,
      parent: userShell,
      extra: { WEVIR_PROVIDER_DEEPSEEK_KEY: 'sk-from-host-secret-store' },
    });
    expect(env.WEVIR_PROVIDER_DEEPSEEK_KEY).toBe('sk-from-host-secret-store');
    for (const name of ['DSH_HOME', 'DSH_PERMISSION_MODE', 'NO_COLOR', 'WEVIR_STREAM_FD']) {
      expect(() => buildDshEnv({ paths, parent: {}, extra: { [name]: 'x' } })).toThrow(name);
    }
  });

  it('Windows 上变量名不分大小写：继承 Path / SYSTEMROOT，丢掉 deepseek_api_key，拒绝 dsh_home', () => {
    const env = buildDshEnv({
      paths,
      platform: 'win32',
      parent: {
        Path: 'C:\\Windows\\system32',
        SYSTEMROOT: 'C:\\Windows',
        ComSpec: 'C:\\Windows\\system32\\cmd.exe',
        USERPROFILE: 'C:\\Users\\dev',
        APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
        deepseek_api_key: 'sk-from-shell',
        Dsh_Home: 'C:\\Users\\dev\\.dsh',
      },
    });
    expect(env).toMatchObject({
      Path: 'C:\\Windows\\system32',
      SYSTEMROOT: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\dev',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      DSH_HOME: paths.dshHome,
    });
    expect(env).not.toHaveProperty('deepseek_api_key');
    expect(env).not.toHaveProperty('Dsh_Home');
    expect(() =>
      buildDshEnv({ paths, platform: 'win32', parent: {}, extra: { dsh_home: 'x' } }),
    ).toThrow('dsh_home');
  });
});
