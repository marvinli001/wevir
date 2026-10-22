// 在局域网里找 Wevir Host 的 mDNS 广播（`_wevir._tcp`，host-api.md §1.1）：发一次 PTR 查询，收集回答里的实例。实例名与 TXT 的 `rid`
// 是路由 ID，`pk` 是 Host 的 Noise 静态公钥（只拿到短码时用来派生 PSK），SRV 给端口，A 记录给地址。
//
// 用“传统单播”查询（RFC 6762 §6.7）：从随机端口发往 224.0.0.251:5353，响应方（Host 用 ciao）把回答单播回这个端口，不用占 5353、
// 不用加组播组。只查 IPv4，每块非内部网卡各发一次。发现的结果只是候选：伪造的广播完不成握手（短码 PSK 与 IK 都绑着 Host 公钥）。

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { REMOTE_MDNS_SERVICE_TYPE, REMOTE_MDNS_TXT_VERSION } from '@wevir/protocol';

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = `_${REMOTE_MDNS_SERVICE_TYPE}._tcp.local`;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
/** 等回答期间重发查询的间隔。 */
const RESEND_MS = 1_000;

/** 局域网里发现的一个 Host。 */
export interface DiscoveredHost {
  readonly routeId: string;
  readonly hostPublicKey: string;
  readonly port: number;
  readonly addresses: readonly string[];
}

export interface BrowseOptions {
  /** 等回答多久。 */
  timeoutMs: number;
  signal?: AbortSignal;
  /** 每发现一个（或给已发现的补了地址）调用一次。 */
  onFound?: (host: DiscoveredHost) => void;
  /** 测试换掉：从哪些本机地址发查询。默认全部非内部的 IPv4 地址。 */
  sourceAddresses?: readonly string[];
  /** 测试换掉：查询发往哪里。 */
  target?: { address: string; port: number };
}

/** 查一次 `_wevir._tcp`，`timeoutMs` 后（或中止时）返回找到的全部。不抛错：网卡发不出去就当没找到。 */
export async function browseWevirHosts(options: BrowseOptions): Promise<DiscoveredHost[]> {
  const found = new Map<string, DiscoveredHost>();
  const records = new RecordSet();
  const sources = options.sourceAddresses ?? localIPv4Addresses();
  const target = options.target ?? { address: MDNS_GROUP, port: MDNS_PORT };
  const query = encodeQuery(SERVICE);
  const sockets: Socket[] = [];
  const onMessage = (message: Buffer, from: string) => {
    if (!records.add(message)) return;
    for (const host of records.hosts(from)) {
      const before = found.get(host.routeId);
      if (before !== undefined && sameHost(before, host)) continue;
      found.set(host.routeId, host);
      options.onFound?.(host);
    }
  };
  await Promise.all(
    sources.map(
      (address) =>
        new Promise<void>((resolve) => {
          const socket = createSocket({ type: 'udp4', reuseAddr: true });
          sockets.push(socket);
          socket.on('error', () => resolve());
          socket.on('message', (message, rinfo) => onMessage(message, rinfo.address));
          socket.bind(0, address, () => {
            try {
              if (target.address === MDNS_GROUP) {
                socket.setMulticastInterface(address);
                socket.setMulticastTTL(255);
              }
              socket.send(query, target.port, target.address, () => resolve());
            } catch {
              resolve();
            }
          });
        }),
    ),
  );
  // 响应方刚开始广播时（还在探测）收不到第一次查询：等待期间每秒再问一次。
  const resend = setInterval(() => {
    for (const socket of sockets) {
      try {
        socket.send(query, target.port, target.address);
      } catch {
        // 这块网卡发不出去。
      }
    }
  }, RESEND_MS);
  await new Promise<void>((resolve) => {
    if (options.signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, options.timeoutMs);
    options.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  clearInterval(resend);
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // 已经关了。
    }
  }
  return [...found.values()];
}

function sameHost(a: DiscoveredHost, b: DiscoveredHost): boolean {
  return (
    a.hostPublicKey === b.hostPublicKey &&
    a.port === b.port &&
    a.addresses.join(',') === b.addresses.join(',')
  );
}

function localIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

// ── DNS 报文 ────────────────────────────────────────────────────────

/** 一个 PTR 查询（id 0，单个问题，IN 类）。 */
export function encodeQuery(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_PTR, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, encodeName(name), question]);
}

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter((label) => label !== '');
  return Buffer.concat([
    ...parts.map((label) => {
      const bytes = Buffer.from(label, 'utf8');
      return Buffer.concat([Buffer.of(bytes.length), bytes]);
    }),
    Buffer.of(0),
  ]);
}

interface ResourceRecord {
  name: string;
  type: number;
  data: Buffer;
  /** 记录数据在报文里的偏移（PTR / SRV 里的名字可能压缩指向报文别处）。 */
  offset: number;
  message: Buffer;
}

/** 读一个（可能压缩的）名字，返回名字与读完之后的偏移。 */
function readName(message: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let offset = start;
  let end: number | undefined;
  for (let jumps = 0; jumps < 64; jumps += 1) {
    const length = message.readUInt8(offset);
    if (length === 0) {
      return [labels.join('.'), end ?? offset + 1];
    }
    if ((length & 0xc0) === 0xc0) {
      end ??= offset + 2;
      offset = message.readUInt16BE(offset) & 0x3fff;
      continue;
    }
    labels.push(message.toString('utf8', offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  throw new Error('DNS name has too many compression pointers');
}

/** 解出报文里的回答、权威与附加记录；不是响应或解析失败时返回 undefined。 */
export function decodeRecords(message: Buffer): ResourceRecord[] | undefined {
  try {
    if (message.length < 12 || (message.readUInt16BE(2) & 0x8000) === 0) return undefined;
    const questions = message.readUInt16BE(4);
    const count = message.readUInt16BE(6) + message.readUInt16BE(8) + message.readUInt16BE(10);
    let offset = 12;
    for (let i = 0; i < questions; i += 1) offset = readName(message, offset)[1] + 4;
    const records: ResourceRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      const [name, next] = readName(message, offset);
      const type = message.readUInt16BE(next);
      const length = message.readUInt16BE(next + 8);
      const dataOffset = next + 10;
      if (dataOffset + length > message.length) return undefined;
      records.push({
        name: name.toLowerCase(),
        type,
        data: message.subarray(dataOffset, dataOffset + length),
        offset: dataOffset,
        message,
      });
      offset = dataOffset + length;
    }
    return records;
  } catch {
    return undefined;
  }
}

/** 收到的全部记录，按名字归拢，算出发现的 Host。 */
class RecordSet {
  readonly #ptr = new Set<string>();
  readonly #srv = new Map<string, { target: string; port: number }>();
  readonly #txt = new Map<string, Map<string, string>>();
  readonly #a = new Map<string, Set<string>>();
  /** 实例 → 回答它的来源地址（没有 A 记录时用）。 */
  readonly #from = new Map<string, string>();

  /** 加进一条报文；不是 DNS 响应时返回 false。 */
  add(message: Buffer): boolean {
    const records = decodeRecords(message);
    if (records === undefined) return false;
    for (const record of records) {
      try {
        if (record.type === TYPE_PTR && record.name === SERVICE) {
          this.#ptr.add(readName(record.message, record.offset)[0].toLowerCase());
        } else if (record.type === TYPE_SRV && record.data.length >= 7) {
          this.#srv.set(record.name, {
            port: record.data.readUInt16BE(4),
            target: readName(record.message, record.offset + 6)[0].toLowerCase(),
          });
        } else if (record.type === TYPE_TXT) {
          this.#txt.set(record.name, decodeTxt(record.data));
        } else if (record.type === TYPE_A && record.data.length === 4) {
          const addresses = this.#a.get(record.name) ?? new Set<string>();
          addresses.add([...record.data].join('.'));
          this.#a.set(record.name, addresses);
        }
      } catch {
        // 跳过坏的记录。
      }
    }
    return true;
  }

  hosts(from: string): DiscoveredHost[] {
    const hosts: DiscoveredHost[] = [];
    for (const instance of this.#ptr) {
      this.#from.set(instance, this.#from.get(instance) ?? from);
      const srv = this.#srv.get(instance);
      const txt = this.#txt.get(instance);
      if (srv === undefined || txt === undefined) continue;
      if (txt.get('v') !== REMOTE_MDNS_TXT_VERSION) continue;
      const routeId = txt.get('rid');
      const hostPublicKey = txt.get('pk');
      if (routeId === undefined || hostPublicKey === undefined) continue;
      const addresses = [...(this.#a.get(srv.target) ?? [])];
      if (addresses.length === 0) addresses.push(this.#from.get(instance) ?? from);
      hosts.push({ routeId, hostPublicKey, port: srv.port, addresses: addresses.sort() });
    }
    return hosts;
  }
}

function decodeTxt(data: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const length = data.readUInt8(offset);
    const text = data.toString('utf8', offset + 1, offset + 1 + length);
    offset += 1 + length;
    const equals = text.indexOf('=');
    if (equals > 0) entries.set(text.slice(0, equals).toLowerCase(), text.slice(equals + 1));
  }
  return entries;
}
