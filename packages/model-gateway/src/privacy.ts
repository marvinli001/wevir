import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  type GatewayPrivacySettings,
  type GatewayPrivacySource,
  PRIVATE_KEY_BLOCK,
  SECRET_PATTERNS,
} from '@wevir/runtime-adapter';
import type { ResponsesRequest } from './types.js';

const KINDS = ['PRIVATE_KEY', 'API_KEY', 'GITHUB', 'AWS', 'BEARER', 'GOOGLE', 'SLACK'];
const PATTERNS = [PRIVATE_KEY_BLOCK, ...SECRET_PATTERNS.slice(1)].map(
  (pattern) =>
    new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
);

export class PrivacyMaskingError extends Error {}

export interface MaskedRequest {
  body: ResponsesRequest;
  values: ReadonlyMap<string, string>;
}

/** 保留到 Host 退出；Codex 重启重建网关时继续使用同一实例。 */
export class GatewayPrivacyMasker {
  readonly #source: GatewayPrivacySource;
  readonly #salt = randomBytes(32);
  readonly #cache = new Map<
    string,
    { text: string; values: Array<[string, string]>; bytes: number }
  >();
  #cacheBytes = 0;
  #signature = '';

  #clearCache(): void {
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

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
    if (settings?.enabled !== true) {
      this.#clearCache();
      return undefined;
    }
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
      const detection = new RegExp(
        patterns.map((pattern) => `(?:${pattern.source})`).join('|'),
        'i',
      );
      const signature = createHash('sha256')
        .update(JSON.stringify([literals, settings.excludedPatterns, settings.excludedValueHashes]))
        .digest('hex');
      if (signature !== this.#signature) {
        this.#clearCache();
        this.#signature = signature;
      }
      const maskText = (text: string): string => {
        if (!detection.test(text)) return text;
        let segments: Array<{ text: string; protected: boolean }> = [{ text, protected: false }];
        for (const pattern of patterns) {
          const global = pattern;
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
      const maskUncached = (text: string): string => {
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
      const maskString = (text: string): string => {
        const cached = this.#cache.get(text);
        if (cached !== undefined) {
          this.#cache.delete(text);
          this.#cache.set(text, cached);
          for (const [token, value] of cached.values) values.set(token, value);
          return cached.text;
        }
        const masked = maskUncached(text);
        if (text.length <= 64 * 1024) {
          const bytes = Buffer.byteLength(text) + (masked === text ? 0 : Buffer.byteLength(masked));
          this.#cache.set(text, {
            text: masked,
            bytes,
            values: masked === text ? [] : [...values].filter(([token]) => masked.includes(token)),
          });
          this.#cacheBytes += bytes;
          while (this.#cache.size > 1024 || this.#cacheBytes > 4 * 1024 * 1024) {
            const key = this.#cache.keys().next().value as string;
            this.#cacheBytes -= this.#cache.get(key)?.bytes ?? 0;
            this.#cache.delete(key);
          }
        }
        return masked;
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
