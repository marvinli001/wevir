// 测试不连外网（vitest.config.ts 的 setupFiles）：读用量等默认用全局 fetch 的代码在测试里只能访问本机，别的地址直接失败。
// 要测联网的地方注入自己的假 fetch。真实 opencode 上的下载与设备码测试（accounts.real.integration.test.ts）设
// WEVIR_TEST_OPENCODE_INSTALL=1 / WEVIR_TEST_OPENCODE_NETWORK=1 明确要求联网时才放开。

const realFetch = globalThis.fetch;
const allowed =
  process.env.WEVIR_TEST_OPENCODE_INSTALL === '1' ||
  process.env.WEVIR_TEST_OPENCODE_NETWORK === '1';

if (!allowed) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
    throw new TypeError(`tests do not reach the network: ${url.origin}`);
  }) as typeof fetch;
}
