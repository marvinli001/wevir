import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  DESKTOP_RENDERER_ORIGINS,
  ErrorCode,
  ErrorDataSchemas,
  METHOD_NAMES,
  MethodSchemas,
  NOTIFICATION_NAMES,
  WEVIR_EVENT_TYPES,
} from './index.js';
import * as limits from './limits.js';

// docs/architecture/host-api.md 里以 `<!-- registry:<名字> -->` 标记的表格必须与代码一致。
// 这份文档只在维护者本机（不在公开仓库里），克隆下来没有它时整组测试跳过。
const docPath = new URL('../../../docs/architecture/host-api.md', import.meta.url);
const hostApiDoc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';

function registryTable(name: string): string[][] {
  const lines = hostApiDoc.split('\n');
  const start = lines.indexOf(`<!-- registry:${name} -->`);
  expect(start, `host-api.md 缺少 registry:${name} 表`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('|')) {
      if (rows.length > 0) break;
      continue;
    }
    rows.push(
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
  }
  // 去掉表头和分隔行
  return rows.slice(2);
}

function code(cell: string | undefined): string {
  const match = cell?.match(/^`([^`]+)`/);
  return match?.[1] ?? cell ?? '';
}

describe.skipIf(hostApiDoc === '')('host-api.md 与代码一致', () => {
  it('方法表：名字、顺序与权限', () => {
    const rows = registryTable('methods');
    expect(rows.map((row) => code(row[0]))).toEqual(METHOD_NAMES);
    for (const row of rows) {
      const method = code(row[0]) as keyof typeof MethodSchemas;
      expect(code(row[1]), method).toBe(String(MethodSchemas[method].permission));
    }
  });

  it('通知表', () => {
    expect(registryTable('notifications').map((row) => code(row[0]))).toEqual(NOTIFICATION_NAMES);
  });

  it('事件类型表', () => {
    expect(registryTable('events').map((row) => code(row[0]))).toEqual(WEVIR_EVENT_TYPES);
  });

  it('错误码表：名字、数值与有无 data', () => {
    const rows = registryTable('errors');
    expect(rows.map((row) => [code(row[0]), Number(row[1])])).toEqual(Object.entries(ErrorCode));
    for (const row of rows) {
      const name = code(row[0]);
      expect(row[3] !== '', `${name} 的 data 列`).toBe(name in ErrorDataSchemas);
    }
  });

  it('关闭码表', () => {
    const rows = registryTable('close-codes');
    expect(rows.map((row) => [code(row[0]), Number(row[1])])).toEqual(Object.entries(CloseCode));
  });

  it('Origin 白名单', () => {
    expect(registryTable('origins').map((row) => code(row[0]))).toEqual(DESKTOP_RENDERER_ORIGINS);
  });

  it('连接健康与截断上限的常量都写进了文档', () => {
    for (const name of Object.keys(limits)) expect(hostApiDoc, name).toContain(name);
  });
});
