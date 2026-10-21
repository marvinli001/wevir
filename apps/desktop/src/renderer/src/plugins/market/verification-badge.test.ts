import type { MarketVerification } from '@wevir/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BADGE_PATH, BadgeMark, VerificationBadge, VerificationCard } from './verification-badge';

const verified: MarketVerification = {
  level: 'verified',
  publisher: 'Notion Labs',
  since: '2026-10',
  note: { 'zh-CN': '连接官方托管的服务', en: 'Hosted by Notion' },
};
const official: MarketVerification = { level: 'official', since: '2026-09' };
const upstream = { url: 'https://github.com/makenotion/notion-mcp-server' };

// 测试跑在 Node 上（没有 DOM），用服务端渲染看结构；界面语言是默认的简体中文。
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe('认证徽章', () => {
  it('轮廓是一条闭合的路径，落在 24 × 24 里', () => {
    expect(BADGE_PATH.startsWith('M')).toBe(true);
    expect(BADGE_PATH.endsWith('Z')).toBe(true);
    const numbers = BADGE_PATH.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    expect(numbers.length).toBeGreaterThan(100);
    expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...numbers)).toBeLessThanOrEqual(24);
  });

  it('verified 用蓝色令牌、official 用金色令牌，同一个形状；列表 14px、详情 18px', () => {
    const blue = html(createElement(BadgeMark, { level: 'verified' }));
    const gold = html(createElement(BadgeMark, { level: 'official', size: 'lg' }));
    expect(blue).toContain('fill-verified');
    expect(blue).toContain('stroke-verified-foreground');
    expect(blue).toContain('size-3.5');
    expect(gold).toContain('fill-official');
    expect(gold).toContain('stroke-official-foreground');
    expect(gold).toContain('size-4.5');
    expect(blue).toContain(BADGE_PATH);
    expect(gold).toContain(BADGE_PATH);
    expect(blue).toContain('aria-hidden="true"');
  });

  it('徽章是带 aria-label 的按钮（聚焦得到），说明卡片不预先渲染', () => {
    const markup = html(createElement(VerificationBadge, { verification: verified, upstream }));
    expect(markup).toMatch(/^<button[^>]*type="button"/);
    expect(markup).toContain('aria-label="已认证"');
    expect(markup).toContain('data-verification="verified"');
    expect(markup).not.toContain('Notion Labs');
    expect(html(createElement(VerificationBadge, { verification: official }))).toContain(
      'aria-label="Wevir 官方"',
    );
  });

  it('verified 的卡片：标题、审核、发布者、认证时间、上游与备注，没有按钮', () => {
    const markup = html(createElement(VerificationCard, { verification: verified, upstream }));
    expect(markup).toContain('已认证');
    expect(markup).toContain('Wevir 已审核此插件的质量与安全');
    expect(markup).toContain('发布者：Notion Labs');
    expect(markup).toContain('自 2026年10月通过认证');
    expect(markup).toContain('基于开源项目 makenotion/notion-mcp-server');
    expect(markup).toContain('连接官方托管的服务');
    expect(markup).not.toContain('<button');
  });

  it('official 的卡片没有发布者行；没有上游与备注时不写', () => {
    const markup = html(createElement(VerificationCard, { verification: official }));
    expect(markup).toContain('Wevir 官方');
    expect(markup).not.toContain('发布者');
    expect(markup).not.toContain('基于开源项目');
    expect(markup.match(/<li/g)).toHaveLength(2);
  });
});
