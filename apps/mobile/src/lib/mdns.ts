// 局域网里找 Wevir（`_wevir._tcp`，host-api.md §1.1）：react-native-zeroconf（iOS 用 Bonjour 的 NSNetServiceBrowser；Android 用它自带的
// mDNSResponder（DNSSD 实现），浏览期间拿着 Wi-Fi 组播锁，否则很多机型收不到组播回答）。发现的结果只是候选地址，身份靠 Noise 握手。
// iOS 要 `NSLocalNetworkUsageDescription` 与 `NSBonjourServices`（app.config.ts）；用户拒绝本地网络权限时什么都找不到，不报错。

import { REMOTE_MDNS_SERVICE_TYPE } from '@wevir/protocol';
import { Platform } from 'react-native';
import Zeroconf, { ImplType } from 'react-native-zeroconf';
import { mergeDiscovered, toDiscoveredHost } from './mdns-service';
import type { BrowseOptions, DiscoveredHost } from './pairing';

export function browseWevirHosts(options: BrowseOptions): Promise<DiscoveredHost[]> {
  const found = new Map<string, DiscoveredHost>();
  return new Promise((resolve) => {
    const zeroconf = new Zeroconf();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal.removeEventListener('abort', finish);
      try {
        zeroconf.stop();
      } catch {
        // 已经停了。
      }
      zeroconf.removeDeviceListeners();
      resolve([...found.values()]);
    };
    zeroconf.on('resolved', (service) => {
      if (done) return;
      const host = toDiscoveredHost(service);
      if (host === undefined) return;
      const merged = mergeDiscovered(found.get(host.routeId), host);
      if (merged === undefined) return;
      found.set(host.routeId, merged);
      options.onFound?.(merged);
    });
    // 本地网络权限被拒、网卡不可用：当没找到。
    zeroconf.on('error', () => {});
    if (options.signal.aborted) {
      finish();
      return;
    }
    options.signal.addEventListener('abort', finish);
    timer = setTimeout(finish, options.timeoutMs);
    zeroconf.scan({
      type: REMOTE_MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      domain: 'local.',
      resolveTimeout: 3,
      ...(Platform.OS === 'android' && { implType: ImplType.DNSSD }),
    });
  });
}
