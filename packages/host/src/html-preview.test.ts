import { describe, expect, it } from 'vitest';
import { injectHtmlPreviewBootstrap } from './html-preview.js';

const SCRIPT = /<script>\(function\(\)\{[^<]*<\/script>/;

describe('injectHtmlPreviewBootstrap（T3 的 injectHtmlRenderBootstrap）', () => {
  it('插在 <head> 开头，页面自己的脚本在它后面', () => {
    const out = injectHtmlPreviewBootstrap(
      '<!doctype html><html><head><title>a</title></head><body>x</body></html>',
    );
    expect(out.indexOf('<script>')).toBe('<!doctype html><html><head>'.length);
    expect(out).toMatch(SCRIPT);
    expect(out.endsWith('<title>a</title></head><body>x</body></html>')).toBe(true);
  });

  it('注释、脚本与模板里的 <head> 不算', () => {
    const html =
      '<!-- <head> --><script>var s = "<head>";</script><template><head></template><p>x</p>';
    const out = injectHtmlPreviewBootstrap(html);
    expect(out.startsWith('<!doctype html><head><script>')).toBe(true);
    expect(out.endsWith(html)).toBe(true);
  });

  it('只有 <html> 或 doctype 时补一个 <head>', () => {
    expect(injectHtmlPreviewBootstrap('<html lang="zh"><p>x</p></html>')).toMatch(
      /^<html lang="zh"><head><script>.*<\/script><\/head><p>x<\/p><\/html>$/,
    );
    expect(injectHtmlPreviewBootstrap('<!DOCTYPE html>\n<p>x</p>')).toMatch(
      /^<!DOCTYPE html><head><script>.*<\/script><\/head>\n<p>x<\/p>$/,
    );
  });
});
