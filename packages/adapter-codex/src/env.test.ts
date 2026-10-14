import { describe, expect, it } from 'vitest';
import { buildCodexEnv } from './env.js';

describe('buildCodexEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/Users/u',
    LANG: 'zh_CN.UTF-8',
    HTTPS_PROXY: 'http://proxy:8080',
    SSL_CERT_FILE: '/etc/ca.pem',
    OPENAI_API_KEY: 'sk-openai',
    CODEX_API_KEY: 'sk-codex',
    CODEX_HOME: '/Users/u/.codex',
    CODEX_SQLITE_HOME: '/x',
    DEEPSEEK_API_KEY: 'sk-ds',
    NODE_OPTIONS: '--inspect',
    WEVIR_GATEWAY_TOKEN: 'from-parent',
  };

  it('只继承白名单，固定注入 CODEX_HOME、令牌与日志级别', () => {
    expect(
      buildCodexEnv({
        codexHome: '/data/engines/codex',
        gatewayToken: 'tok',
        parent,
        platform: 'darwin',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/u',
      LANG: 'zh_CN.UTF-8',
      HTTPS_PROXY: 'http://proxy:8080',
      SSL_CERT_FILE: '/etc/ca.pem',
      CODEX_HOME: '/data/engines/codex',
      WEVIR_GATEWAY_TOKEN: 'tok',
      RUST_LOG: 'warn',
      NO_COLOR: '1',
    });
  });

  it('没有令牌时不带 WEVIR_GATEWAY_TOKEN（父进程里的也不继承）', () => {
    const env = buildCodexEnv({ codexHome: '/c', parent, platform: 'linux', rustLog: 'info' });
    expect(env).not.toHaveProperty('WEVIR_GATEWAY_TOKEN');
    expect(env.RUST_LOG).toBe('info');
  });

  it('Windows 上变量名不分大小写', () => {
    const env = buildCodexEnv({
      codexHome: 'C:\\c',
      parent: {
        Path: 'C:\\Windows',
        SYSTEMROOT: 'C:\\Windows',
        userprofile: 'C:\\Users\\u',
        OpenAI_Api_Key: 'x',
      },
      platform: 'win32',
    });
    expect(env).toMatchObject({
      Path: 'C:\\Windows',
      SYSTEMROOT: 'C:\\Windows',
      userprofile: 'C:\\Users\\u',
    });
    expect(env).not.toHaveProperty('OpenAI_Api_Key');
  });
});
