// 共用的协议测试（@wevir/relay/conformance）对着 Miniflare 里的 Worker 跑（start.ts）。
//
// 这个目录单独一份 tsconfig：这里的代码跑在 Node 上，src/ 跑在 Workers 上，两边的全局类型不能放在一起检查。

import { describeRelayConformance } from '@wevir/relay/conformance';
import { describe } from 'vitest';
import { startWorker } from './start.js';

describe('协议测试', () => {
  describeRelayConformance(startWorker);
});
