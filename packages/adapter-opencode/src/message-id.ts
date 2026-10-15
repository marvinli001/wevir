// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/adapter.ts（`makeOpenCodeMessageId`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 的 Ref 与 Random 换成模块内的计数与 node:crypto。
//
// 客户端给的用户消息 ID：opencode 的格式是 `msg_` + 12 位十六进制的时间与计数 + 28 位 base62，按时间递增排序。带着自己生成的
// ID 发 `promptAsync`，就能从事件流里认出这次输入（回合的开始，opencode-event-mapping.md §5.1）。

import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let lastMillis = -1;
let counter = 0;

export function newMessageId(now: number = Date.now()): string {
  counter = now === lastMillis ? counter + 1 : 1;
  lastMillis = now;
  const time = BigInt.asUintN(48, BigInt(now) * 0x1000n + BigInt(counter))
    .toString(16)
    .padStart(12, '0');
  let random = '';
  for (let index = 0; index < 28; index += 1) random += ALPHABET[randomInt(ALPHABET.length)];
  return `msg_${time}${random}`;
}
