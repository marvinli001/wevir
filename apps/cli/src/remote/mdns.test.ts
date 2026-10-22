// 局域网 mDNS 发现：假的响应方在 127.0.0.1 上收查询、单播回答（像 ciao 对“传统单播”查询那样），回答里的名字用压缩指针。

import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { browseWevirHosts, type DiscoveredHost, decodeRecords, encodeQuery } from './mdns.js';

const sockets: ReturnType<typeof createSocket>[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

function name(text: string): Buffer {
  return Buffer.concat([
    ...text.split('.').map((label) => Buffer.concat([Buffer.of(label.length), Buffer.from(label)])),
    Buffer.of(0),
  ]);
}

function record(owner: Buffer, type: number, data: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(120, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([owner, fixed, data]);
}

/** 一条响应：PTR 在回答里，SRV / TXT / A 在附加里；实例名之后的记录用指向 PTR 数据的压缩指针。 */
function response(options: { rid: string; pk: string; port: number; address: string; v?: string }) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(1, 6);
  header.writeUInt16BE(3, 10);
  const service = name('_wevir._tcp.local');
  const ptrOwnerOffset = 12;
  const ptrDataOffset = ptrOwnerOffset + service.length + 10;
  // 实例名的数据：首个标签加指向服务名的指针。
  const instance = Buffer.concat([
    Buffer.of(options.rid.length),
    Buffer.from(options.rid),
    Buffer.from([0xc0, ptrOwnerOffset]),
  ]);
  const pointerToInstance = Buffer.from([0xc0 | (ptrDataOffset >> 8), ptrDataOffset & 0xff]);
  const target = name('wevir-abc.local');
  const srv = Buffer.concat([
    Buffer.from([0, 0, 0, 0, options.port >> 8, options.port & 0xff]),
    target,
  ]);
  const txt = Buffer.concat(
    [`v=${options.v ?? '1'}`, `rid=${options.rid}`, `pk=${options.pk}`].map((entry) =>
      Buffer.concat([Buffer.of(entry.length), Buffer.from(entry)]),
    ),
  );
  return Buffer.concat([
    header,
    record(service, 12, instance),
    record(pointerToInstance, 33, srv),
    record(pointerToInstance, 16, txt),
    record(name('wevir-abc.local'), 1, Buffer.from(options.address.split('.').map(Number))),
  ]);
}

async function fakeResponder(reply: Buffer): Promise<{ port: number; queries: Buffer[] }> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  const queries: Buffer[] = [];
  socket.on('message', (message, rinfo) => {
    queries.push(message);
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, queries };
}

const RID = 'r'.repeat(43);
const PK = 'k'.repeat(43);

describe('mDNS 发现', () => {
  it('发 PTR 查询，读出回答里的路由 ID、公钥、端口与地址（含压缩的名字）', async () => {
    const responder = await fakeResponder(
      response({ rid: RID, pk: PK, port: 47830, address: '192.168.1.20' }),
    );
    const found: DiscoveredHost[] = [];
    const hosts = await browseWevirHosts({
      timeoutMs: 200,
      sourceAddresses: ['127.0.0.1'],
      target: { address: '127.0.0.1', port: responder.port },
      onFound: (host) => found.push(host),
    });
    const expected = { routeId: RID, hostPublicKey: PK, port: 47830, addresses: ['192.168.1.20'] };
    expect(hosts).toEqual([expected]);
    expect(found).toEqual([expected]);
    // 查询本身：一个问题，_wevir._tcp.local 的 PTR。
    expect(responder.queries[0]).toEqual(encodeQuery('_wevir._tcp.local'));
  });

  it('TXT 版本不认识的、不是响应的报文都不算', async () => {
    const responder = await fakeResponder(
      response({ rid: RID, pk: PK, port: 47830, address: '192.168.1.20', v: '2' }),
    );
    const hosts = await browseWevirHosts({
      timeoutMs: 150,
      sourceAddresses: ['127.0.0.1'],
      target: { address: '127.0.0.1', port: responder.port },
    });
    expect(hosts).toEqual([]);
    expect(decodeRecords(encodeQuery('_wevir._tcp.local'))).toBeUndefined();
    expect(decodeRecords(Buffer.from([1, 2, 3]))).toBeUndefined();
  });

  it('中止时立即返回', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const browsing = browseWevirHosts({
      timeoutMs: 10_000,
      signal: controller.signal,
      sourceAddresses: ['127.0.0.1'],
      target: { address: '127.0.0.1', port: 9 },
    });
    setTimeout(() => controller.abort(), 20);
    await browsing;
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
