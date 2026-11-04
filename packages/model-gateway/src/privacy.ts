import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  type GatewayPrivacySettings,
  type GatewayPrivacySource,
  PRIVATE_KEY_BLOCK,
  SECRET_PATTERNS,
} from '@wevir/runtime-adapter';
import type { ResponsesRequest } from './types.js';

const KINDS = ['PRIVATE_KEY', 'API_KEY', 'GITHUB', 'AWS', 'BEARER', 'GOOGLE', 'SLACK'];
const PATTERNS = [PRIVATE_KEY_BLOCK, ...SECRET_PATTERNS.slice(1)];

export class PrivacyMaskingError extends Error {}

export interface MaskedRequest {
  body: ResponsesRequest;
  values: ReadonlyMap<string, string>;
}

/** 保留到 Host 退出；Codex 重启重建网关时继续使用同一实例。 */
export class GatewayPrivacyMasker {
  readonly #source: GatewayPrivacySource;
  readonly #salt = randomBytes(32);

  constructor(source: GatewayPrivacySource) {
    this.#source = source;
  }

  async prepare(
    body: ResponsesRequest,
    credentials: readonly string[],
  ): Promise<MaskedRequest | undefined> {
    let settings: GatewayPrivacySettings | undefined;
    try {
      settings = this.#source.settings();
    } catch {
      throw new PrivacyMaskingError('隐私遮蔽失败：无法读取设置');
    }
    if (settings?.enabled !== true) return undefined;
    let known: readonly string[];
    try {
      known = [...credentials, ...(await this.#source.secrets())];
    } catch {
      throw new PrivacyMaskingError('隐私遮蔽失败：无法读取密钥清单');
    }
    let exclusions: RegExp[];
    try {
      exclusions = (settings.excludedPatterns ?? []).map((pattern) => new RegExp(pattern, 'u'));
    } catch {
      throw new PrivacyMaskingError('隐私遮蔽失败：无效的豁免正则表达式');
    }
    try {
      const values = new Map<string, string>();
      const excluded = new Set(settings.excludedValueHashes ?? []);
      const allowed = (value: string) =>
        excluded.has(createHash('sha256').update(value).digest('hex')) ||
        exclusions.some((pattern) => pattern.test(value));
      const placeholder = (value: string) => {
        const kind = KINDS[SECRET_PATTERNS.findIndex((pattern) => pattern.test(value))] ?? 'KNOWN';
        const digest = createHmac('sha256', this.#salt).update(value).digest('hex').slice(0, 20);
        const token = `{{SECRET_${kind}_${digest}}}`;
        if (values.has(token) && values.get(token) !== value)
          throw new PrivacyMaskingError('隐私遮蔽失败：占位符冲突');
        values.set(token, value);
        return token;
      };
      const literals = [
        ...new Set(
          known.flatMap((value) => {
            const credential = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(value)?.[1];
            return credential === undefined ? [value] : [value, credential];
          }),
        ),
      ]
        .filter((value) => value !== '')
        .sort((a, b) => b.length - a.length);
      const knownPattern =
        literals.length === 0 ? [] : [new RegExp(literals.map(escapeRegex).join('|'), 'g')];
      const patterns = [...knownPattern, ...PATTERNS];
      const maskText = (text: string): string => {
        let segments: Array<{ text: string; protected: boolean }> = [{ text, protected: false }];
        for (const pattern of patterns) {
          const global = new RegExp(
            pattern.source,
            pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
          );
          segments = segments.flatMap((segment) => {
            if (segment.protected) return [segment];
            const next: typeof segments = [];
            let offset = 0;
            for (const match of segment.text.matchAll(global)) {
              next.push({ text: segment.text.slice(offset, match.index), protected: false });
              const value = match[0];
              next.push({ text: allowed(value) ? value : placeholder(value), protected: true });
              offset = match.index + value.length;
            }
            next.push({ text: segment.text.slice(offset), protected: false });
            return next;
          });
        }
        return segments.map((segment) => segment.text).join('');
      };
      const maskString = (text: string): string => {
        // 工具结果与参数经常是包在字符串里的 JSON，先解开其中的转义。
        if (/^\s*[[{]/.test(text)) {
          let nested: unknown;
          try {
            nested = JSON.parse(text);
          } catch {
            return maskText(text);
          }
          const masked = mapJsonStrings(nested, maskString);
          if (masked !== nested) return JSON.stringify(masked);
        }
        return maskText(text);
      };
      return { body: mapJsonStrings(body, maskString) as ResponsesRequest, values };
    } catch (error) {
      if (error instanceof PrivacyMaskingError) throw error;
      throw new PrivacyMaskingError('隐私遮蔽失败：无法处理请求正文');
    }
  }
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 未变化时保留原值，以便字符串内的 JSON 不被无谓地重新排版。 */
export function mapJsonStrings(
  value: unknown,
  transform: (text: string, key?: string) => string,
  key?: string,
): unknown {
  if (typeof value === 'string') return transform(value, key);
  if (Array.isArray(value)) {
    const mapped = value.map((item) => mapJsonStrings(item, transform));
    return mapped.some((item, index) => item !== value[index]) ? mapped : value;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const entries = Object.entries(value).map(([name, item]) => {
      const nextName = transform(name);
      const next = mapJsonStrings(item, transform, name);
      changed ||= nextName !== name || next !== item;
      return [nextName, next];
    });
    return changed ? Object.fromEntries(entries) : value;
  }
  return value;
}
