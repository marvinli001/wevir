import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import frozen010 from './compat/0.1.0.json' with { type: 'json' };
import frozen020 from './compat/0.2.0.json' with { type: 'json' };
import frozen030 from './compat/0.3.0.json' with { type: 'json' };
import frozen040 from './compat/0.4.0.json' with { type: 'json' };
import frozen050 from './compat/0.5.0.json' with { type: 'json' };
import frozen060 from './compat/0.6.0.json' with { type: 'json' };
import frozen070 from './compat/0.7.0.json' with { type: 'json' };
import frozen080 from './compat/0.8.0.json' with { type: 'json' };
import frozen090 from './compat/0.9.0.json' with { type: 'json' };
import frozen0100 from './compat/0.10.0.json' with { type: 'json' };
import frozen0110 from './compat/0.11.0.json' with { type: 'json' };
import frozen0120 from './compat/0.12.0.json' with { type: 'json' };
import frozen0130 from './compat/0.13.0.json' with { type: 'json' };
import frozen0140 from './compat/0.14.0.json' with { type: 'json' };
import frozen0150 from './compat/0.15.0.json' with { type: 'json' };
import frozen0160 from './compat/0.16.0.json' with { type: 'json' };
import frozen0170 from './compat/0.17.0.json' with { type: 'json' };
import frozen0180 from './compat/0.18.0.json' with { type: 'json' };
import frozen0190 from './compat/0.19.0.json' with { type: 'json' };
import frozen0200 from './compat/0.20.0.json' with { type: 'json' };
import frozen0210 from './compat/0.21.0.json' with { type: 'json' };
import frozen0220 from './compat/0.22.0.json' with { type: 'json' };
import frozen0230 from './compat/0.23.0.json' with { type: 'json' };
import frozen0240 from './compat/0.24.0.json' with { type: 'json' };
import frozen0250 from './compat/0.25.0.json' with { type: 'json' };
import frozen0260 from './compat/0.26.0.json' with { type: 'json' };
import frozen0270 from './compat/0.27.0.json' with { type: 'json' };
import frozen0280 from './compat/0.28.0.json' with { type: 'json' };
import frozen0290 from './compat/0.29.0.json' with { type: 'json' };
import frozen0300 from './compat/0.30.0.json' with { type: 'json' };
import frozen0310 from './compat/0.31.0.json' with { type: 'json' };
import frozen0320 from './compat/0.32.0.json' with { type: 'json' };
import frozen0330 from './compat/0.33.0.json' with { type: 'json' };
import frozen0340 from './compat/0.34.0.json' with { type: 'json' };
import frozen0350 from './compat/0.35.0.json' with { type: 'json' };
import frozen0360 from './compat/0.36.0.json' with { type: 'json' };
import frozen0370 from './compat/0.37.0.json' with { type: 'json' };
import frozen0380 from './compat/0.38.0.json' with { type: 'json' };
import frozen0390 from './compat/0.39.0.json' with { type: 'json' };
import frozen0400 from './compat/0.40.0.json' with { type: 'json' };
import frozen0410 from './compat/0.41.0.json' with { type: 'json' };
import frozen0420 from './compat/0.42.0.json' with { type: 'json' };
import frozen0430 from './compat/0.43.0.json' with { type: 'json' };
import frozen0440 from './compat/0.44.0.json' with { type: 'json' };
import frozen0450 from './compat/0.45.0.json' with { type: 'json' };
import frozen0460 from './compat/0.46.0.json' with { type: 'json' };
import frozen0470 from './compat/0.47.0.json' with { type: 'json' };
import frozen0480 from './compat/0.48.0.json' with { type: 'json' };
import frozen0490 from './compat/0.49.0.json' with { type: 'json' };
import frozen0500 from './compat/0.50.0.json' with { type: 'json' };
import frozen0510 from './compat/0.51.0.json' with { type: 'json' };
import frozen0520 from './compat/0.52.0.json' with { type: 'json' };
import frozen0530 from './compat/0.53.0.json' with { type: 'json' };
import frozen0540 from './compat/0.54.0.json' with { type: 'json' };
import frozen0550 from './compat/0.55.0.json' with { type: 'json' };
import frozen0560 from './compat/0.56.0.json' with { type: 'json' };
import frozen0570 from './compat/0.57.0.json' with { type: 'json' };
import frozen0580 from './compat/0.58.0.json' with { type: 'json' };
import frozen0590 from './compat/0.59.0.json' with { type: 'json' };
import frozen0600 from './compat/0.60.0.json' with { type: 'json' };
import frozen0610 from './compat/0.61.0.json' with { type: 'json' };
import frozen0620 from './compat/0.62.0.json' with { type: 'json' };
import frozen0630 from './compat/0.63.0.json' with { type: 'json' };
import frozen0640 from './compat/0.64.0.json' with { type: 'json' };
import frozen0650 from './compat/0.65.0.json' with { type: 'json' };
import frozen0660 from './compat/0.66.0.json' with { type: 'json' };
import frozen0670 from './compat/0.67.0.json' with { type: 'json' };
import frozen0680 from './compat/0.68.0.json' with { type: 'json' };
import frozen0690 from './compat/0.69.0.json' with { type: 'json' };
import frozen0700 from './compat/0.70.0.json' with { type: 'json' };
import {
  ErrorCode,
  type ErrorCodeName,
  ErrorDataSchemas,
  EventPayloadSchemas,
  isKnownEventType,
  isMethodName,
  JsonRpcErrorResponseSchema,
  MethodSchemas,
  NotificationSchemas,
  WevirEventSchema,
} from './index.js';

// compat/<版本>.json 是该协议版本发布时冻结的报文样本，之后只加新文件、不改旧文件。
// 当前 schema 必须仍能解析所有旧样本（host-api.md「兼容规则」）。

interface FrozenSamples {
  protocolVersion: string;
  methods: Record<string, { params: unknown[]; result: unknown[] }>;
  notifications: Record<string, unknown[]>;
  events: unknown[];
  errors: { name: string; response: { error: { code: number; data?: unknown } } }[];
}

const frozenVersions: FrozenSamples[] = [
  frozen010,
  frozen020,
  frozen030,
  frozen040,
  frozen050,
  frozen060,
  frozen070,
  frozen080,
  frozen090,
  frozen0100,
  frozen0110,
  frozen0120,
  frozen0130,
  frozen0140,
  frozen0150,
  frozen0160,
  frozen0170,
  frozen0180,
  frozen0190,
  frozen0200,
  frozen0210,
  frozen0220,
  frozen0230,
  frozen0240,
  frozen0250,
  frozen0260,
  frozen0270,
  frozen0280,
  frozen0290,
  frozen0300,
  frozen0310,
  frozen0320,
  frozen0330,
  frozen0340,
  frozen0350,
  frozen0360,
  frozen0370,
  frozen0380,
  frozen0390,
  frozen0400,
  frozen0410,
  frozen0420,
  frozen0430,
  frozen0440,
  frozen0450,
  frozen0460,
  frozen0470,
  frozen0480,
  frozen0490,
  frozen0500,
  frozen0510,
  frozen0520,
  frozen0530,
  frozen0540,
  frozen0550,
  frozen0560,
  frozen0570,
  frozen0580,
  frozen0590,
  frozen0600,
  frozen0610,
  frozen0620,
  frozen0630,
  frozen0640,
  frozen0650,
  frozen0660,
  frozen0670,
  frozen0680,
  frozen0690,
  frozen0700,
];

function issuesOf(schema: z.ZodType, value: unknown) {
  return schema.safeParse(value).error?.issues;
}

describe.each(frozenVersions)('旧报文仍能解析：$protocolVersion', (frozen) => {
  it('方法：名字都还在，params 与 result 都能解析', () => {
    for (const [method, samples] of Object.entries(frozen.methods)) {
      expect(isMethodName(method), `方法被删除：${method}`).toBe(true);
      if (!isMethodName(method)) continue;
      for (const params of samples.params) {
        expect(issuesOf(MethodSchemas[method].params, params), method).toBeUndefined();
      }
      for (const result of samples.result) {
        expect(issuesOf(MethodSchemas[method].result, result), method).toBeUndefined();
      }
    }
  });

  it('通知', () => {
    for (const [name, samples] of Object.entries(frozen.notifications)) {
      expect(name in NotificationSchemas, `通知被删除：${name}`).toBe(true);
      const schema = NotificationSchemas[name as keyof typeof NotificationSchemas].params;
      for (const params of samples) expect(issuesOf(schema, params), name).toBeUndefined();
    }
  });

  it('事件：类型都还在，整条事件能解析', () => {
    for (const event of frozen.events) {
      const type = (event as { type: string }).type;
      expect(isKnownEventType(type), `事件类型被删除：${type}`).toBe(true);
      expect(issuesOf(WevirEventSchema, event), type).toBeUndefined();
    }
  });

  it('错误：数值没变，data 能解析', () => {
    for (const { name, response } of frozen.errors) {
      expect(ErrorCode[name as ErrorCodeName], `错误码被删除或改值：${name}`).toBe(
        response.error.code,
      );
      expect(issuesOf(JsonRpcErrorResponseSchema, response), name).toBeUndefined();
      const dataSchema = ErrorDataSchemas[name as keyof typeof ErrorDataSchemas];
      expect(issuesOf(dataSchema, response.error.data), name).toBeUndefined();
    }
  });
});

describe('兼容纪律的演示', () => {
  const objectSchemas: [string, z.ZodObject][] = [
    ...Object.entries(MethodSchemas).flatMap(([m, s]) =>
      [
        [`${m} params`, s.params],
        [`${m} result`, s.result],
      ].filter((entry): entry is [string, z.ZodObject] => entry[1] instanceof z.ZodObject),
    ),
    ...Object.entries(EventPayloadSchemas),
  ];

  /** 最早冻结了这个形状的版本里的样本（后来新增的事件类型只出现在新版本的样本里）。 */
  function frozenSamplesFor(name: string): unknown[] {
    const [key, part] = name.split(' ');
    for (const frozen of frozenVersions) {
      const method = frozen.methods[key as string];
      if (method && (part === 'params' || part === 'result')) return method[part];
      const payloads = frozen.events
        .filter((event) => (event as { type: string }).type === name)
        .map((event) => (event as { payload: unknown }).payload);
      if (payloads.length > 0) return payloads;
    }
    return [];
  }

  it('给 schema 加一个 optional 字段后，旧样本照样通过（新 Host 读旧客户端）', () => {
    for (const [name, schema] of objectSchemas) {
      const evolved = schema.extend({ addedInFuture: z.string().optional() });
      const samples = frozenSamplesFor(name);
      expect(samples.length, `没有冻结样本：${name}`).toBeGreaterThan(0);
      for (const sample of samples) expect(issuesOf(evolved, sample), name).toBeUndefined();
    }
  });

  it('新报文多出的字段，旧 schema 忽略它（旧客户端读新 Host）', () => {
    for (const [name, schema] of objectSchemas) {
      for (const sample of frozenSamplesFor(name)) {
        const newer = { ...(sample as object), addedInFuture: 'x' };
        const parsed = schema.safeParse(newer);
        expect(parsed.error?.issues, name).toBeUndefined();
        expect(parsed.data).not.toHaveProperty('addedInFuture');
      }
    }
  });
});
