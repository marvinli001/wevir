// iOS 通知扩展的解密（plugins/notification-service/PushCrypto.swift）与 `@wevir/noise` 互通：在 macOS 上用 swiftc 把它与一个小
// 驱动程序编起来，跑同一组向量（packages/noise/test-vectors/push.json）与同一串重放计数，结果要与 JS 完全相同。再把扩展的改写
// （NotificationService.swift 的 `PushRewriter.rewrite`）连同 App 写的共享文件一起跑一遍：模拟器的 `simctl push` 不经过通知服务
// 扩展，真机之外只能这样验证改写后的显示。没有 swiftc 时跳过。

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushReplayGuard, sealPushMessage } from '@wevir/noise';
import { afterAll, describe, expect, it } from 'vitest';
import vectors from '../../../../packages/noise/test-vectors/push.json' with { type: 'json' };

const SWIFT = join(__dirname, '../../plugins/notification-service/PushCrypto.swift');
const SERVICE = join(__dirname, '../../plugins/notification-service/NotificationService.swift');
const VECTORS = join(__dirname, '../../../../packages/noise/test-vectors/push.json');

const hasSwift =
  process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc']).status === 0;

const DRIVER = `
import Foundation

struct Vector: Decodable { let name: String; let envelope: String }
struct Vectors: Decodable { let push_key: String; let vectors: [Vector] }

func hexData(_ hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

let args = CommandLine.arguments
let file = try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
let key = hexData(file.push_key)
var opened: [[String: Any]] = []
for vector in file.vectors {
  guard let envelope = PushCrypto.base64URLDecode(vector.envelope),
    let result = PushCrypto.open(key: key, envelope: envelope)
  else { opened.append(["name": vector.name, "ok": false]); continue }
  opened.append([
    "name": vector.name, "ok": true, "counter": result.counter,
    "plaintext": String(data: result.plaintext, encoding: .utf8)!,
    "message": PushMessage.decode(result.plaintext)?.title as Any,
  ])
}
// 改过一个字节的信封、错的密钥都解不开。
var tampered = PushCrypto.base64URLDecode(file.vectors[0].envelope)!
tampered[tampered.count - 1] ^= 1
let rejects = [
  PushCrypto.open(key: key, envelope: tampered) == nil,
  PushCrypto.open(key: Data(repeating: 7, count: 32), envelope: PushCrypto.base64URLDecode(file.vectors[0].envelope)!) == nil,
  PushCrypto.base64URLDecode("bad!") == nil,
]
let counters = try! JSONDecoder().decode([Int64].self, from: Data(args[2].utf8))
var replay = PushReplayGuard()
let accepted = counters.map { replay.accept($0) }
let state = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(replay))
let out: [String: Any] = ["opened": opened, "rejects": rejects, "accepted": accepted, "state": state]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
`;

/** 乱序、重复、过旧、窗口外，再加超过 1024 个的一串。 */
function replayCounters(): number[] {
  const base = 1_792_368_000_000;
  const counters = [5, 5, 3, base, base - 10, base - 10, base - 600_001, base - 599_999, base + 1];
  for (let i = 0; i < 1100; i += 1) counters.push(base + 2 + ((i * 7919) % 1100));
  counters.push(base + 2, base + 3_000);
  return counters;
}

describe.skipIf(!hasSwift)('Swift 的解密与 JS 一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-push-swift-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('同一组向量、同一串重放计数，结果相同', () => {
    const main = join(dir, 'main.swift');
    const binary = join(dir, 'check');
    writeFileSync(main, DRIVER);
    execFileSync('xcrun', ['swiftc', '-O', SWIFT, main, '-o', binary], { stdio: 'pipe' });
    const counters = replayCounters();
    const output = JSON.parse(
      execFileSync(binary, [VECTORS, JSON.stringify(counters)], { encoding: 'utf8' }),
    ) as {
      opened: Array<{ name: string; ok: boolean; counter?: number; plaintext?: string }>;
      rejects: boolean[];
      accepted: boolean[];
      state: { highest: number; floor: number; seen: number[] };
    };

    expect(
      output.opened.map(({ name, ok, counter, plaintext }) => ({ name, ok, counter, plaintext })),
    ).toEqual(
      vectors.vectors.map((v) => ({
        name: v.name,
        ok: true,
        counter: v.counter,
        plaintext: v.plaintext,
      })),
    );
    expect(output.rejects).toEqual([true, true, true]);

    const guard = new PushReplayGuard();
    expect(output.accepted).toEqual(counters.map((c) => guard.accept(c)));
    expect(output.state).toEqual(guard.state());
  }, 180_000);

  it('改写：标题、电脑名、提醒种类与跳转；重放、错的密钥、锁屏隐藏；agent 的正文', () => {
    mkdirSync(join(dir, 'rewrite'));
    const main = join(dir, 'rewrite/main.swift');
    const binary = join(dir, 'rewrite/check');
    writeFileSync(main, REWRITE_DRIVER);
    execFileSync('xcrun', ['swiftc', SWIFT, SERVICE, main, '-o', binary], { stdio: 'pipe' });

    const key = Buffer.from(vectors.push_key, 'hex');
    const seal = (counter: number, message: object) =>
      sealPushMessage(key, counter, new TextEncoder().encode(JSON.stringify(message)));
    const base = { v: 1, category: 'action', createdAt: '2026-10-27T00:00:00.000Z' };
    const approval = seal(10, {
      ...base,
      id: 'approval:apr_1',
      kind: 'approval',
      title: 'Fix the build',
      host: 'Mac',
      sessionId: 'ses_1',
    });
    const computers = [
      { name: 'old', routeId: 'r-old' },
      { name: 'studio', routeId: 'r-studio' },
    ];
    const keys = { 'r-old': '07'.repeat(32), 'r-studio': vectors.push_key };
    const cases = [
      { name: 'approval', payload: approval, computers, keys },
      { name: 'replayed', payload: approval, computers, keys },
      {
        name: 'channel, empty title',
        payload: seal(11, {
          ...base,
          id: 'channel:1',
          kind: 'channel',
          title: ' ',
          host: 'Studio',
          channelId: 'chn_1',
        }),
        computers,
        keys,
      },
      {
        name: 'locked',
        payload: seal(12, {
          ...base,
          id: 'question:1',
          kind: 'question',
          title: 'Secret',
          host: 'Mac',
          sessionId: 'ses_2',
        }),
        computers,
        keys,
        hideOnLockScreen: true,
        locked: true,
      },
      {
        name: 'hide on lock screen, unlocked',
        payload: seal(13, {
          ...base,
          id: 'failed:1',
          kind: 'failed',
          title: 'Deploy',
          host: 'Mac',
          sessionId: 'ses_3',
        }),
        computers,
        keys,
        hideOnLockScreen: true,
      },
      {
        name: 'unknown key',
        payload: seal(14, { ...base, id: 'a', kind: 'approval', title: 'x', host: 'Mac' }),
        computers,
        keys: { 'r-old': '07'.repeat(32) },
      },
      {
        name: 'bad kind',
        payload: seal(15, { ...base, id: 'a', kind: 'nope', title: 'x', host: 'Mac' }),
        computers,
        keys,
      },
      { name: 'not a Wevir push', payload: approval, computers, keys, wevir: 'other' },
      {
        name: 'agent with body',
        payload: seal(16, {
          ...base,
          id: 'agent:ses_4:1',
          kind: 'agent',
          title: 'Deploy',
          host: 'Mac',
          sessionId: 'ses_4',
          body: 'Staging is down; approve the rollback.',
        }),
        computers,
        keys,
      },
    ];
    const spec = join(dir, 'cases.json');
    writeFileSync(spec, JSON.stringify(cases));
    const output = JSON.parse(execFileSync(binary, [spec, dir], { encoding: 'utf8' })) as {
      results: unknown[];
      replay: Record<string, { highest: number }>;
    };

    const generic = (target: object) => ({
      title: 'Wevir',
      subtitle: '',
      body: 'Needs attention',
      category: 'wevir.push',
      target,
      hasPayload: false,
    });
    expect(output.results).toEqual([
      {
        title: 'Fix the build',
        subtitle: 'Mac',
        body: 'Approval requested',
        category: 'wevir.push',
        thread: 'studio/ses_1',
        target: { computer: 'studio', sessionId: 'ses_1' },
        hasPayload: false,
      },
      null,
      {
        title: 'Studio',
        subtitle: 'Studio',
        body: 'Channel message',
        category: 'wevir.push',
        thread: 'studio/chn_1',
        target: { computer: 'studio', channelId: 'chn_1' },
        hasPayload: false,
      },
      { ...generic({ computer: 'studio', sessionId: 'ses_2' }), thread: 'studio/ses_2' },
      {
        title: 'Deploy',
        subtitle: 'Mac',
        body: 'Failed',
        category: 'wevir.push',
        thread: 'studio/ses_3',
        target: { computer: 'studio', sessionId: 'ses_3' },
        hasPayload: false,
      },
      null,
      null,
      null,
      {
        title: 'Deploy',
        subtitle: 'Mac',
        body: 'Staging is down; approve the rollback.',
        category: 'wevir.push',
        thread: 'studio/ses_4',
        target: { computer: 'studio', sessionId: 'ses_4' },
        hasPayload: false,
      },
    ]);
    // 重放状态写回 App Group 里的 replay.json，只记解得开的那台电脑。
    expect(Object.keys(output.replay)).toEqual(['r-studio']);
    expect(output.replay['r-studio']?.highest).toBe(16);
  }, 180_000);
});

const REWRITE_DRIVER = `
import Foundation
import UserNotifications

struct Case: Decodable {
  struct Computer: Codable { let name: String; let routeId: String }
  let payload: String
  let computers: [Computer]
  let keys: [String: String]
  let hideOnLockScreen: Bool?
  let locked: Bool?
  let wevir: String?
}

func hexData(_ hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

let args = CommandLine.arguments
let cases = try! JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
let dir = URL(fileURLWithPath: args[2]).appendingPathComponent("push", isDirectory: true)
try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let strings = PushStrings(table: [
  "WEVIR_PUSH_TITLE": "Wevir", "WEVIR_PUSH_BODY": "Needs attention",
  "WEVIR_PUSH_KIND_APPROVAL": "Approval requested", "WEVIR_PUSH_KIND_CHANNEL": "Channel message",
  "WEVIR_PUSH_KIND_FAILED": "Failed", "WEVIR_PUSH_KIND_QUESTION": "Question",
])
var results: [Any] = []
for item in cases {
  let shared: [String: Any] = [
    "version": 1, "hideOnLockScreen": item.hideOnLockScreen ?? false,
    "computers": item.computers.map { ["name": $0.name, "routeId": $0.routeId] },
  ]
  try! JSONSerialization.data(withJSONObject: shared).write(to: dir.appendingPathComponent("computers.json"))
  let original = UNMutableNotificationContent()
  original.title = "WEVIR_PUSH_TITLE"
  original.body = "WEVIR_PUSH_BODY"
  original.userInfo = ["wevir": item.wevir ?? "push", "p": item.payload, "aps": ["mutable-content": 1]]
  let content = PushRewriter.rewrite(
    original, strings: strings, dir: dir,
    pushKey: { item.keys[$0].map(hexData) }, locked: { item.locked ?? false })
  guard let content else { results.append(NSNull()); continue }
  let body = content.userInfo["body"] as? [String: Any]
  results.append([
    "title": content.title, "subtitle": content.subtitle, "body": content.body,
    "category": content.categoryIdentifier, "thread": content.threadIdentifier,
    "target": body?[PushRewriter.targetKey] ?? NSNull(), "hasPayload": content.userInfo["p"] != nil,
  ])
}
let replay = try! JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("replay.json")))
let out: [String: Any] = ["results": results, "replay": replay]
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
`;
