import { config } from 'zod/v4/core';

// 创建协议 schema 之前关闭 JIT，避免严格 CSP 上的 Function 能力探测。
config({ jitless: true });
