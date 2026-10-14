// 给运行时建出的 <style> 盖上 CSP 的样式 nonce（U3，src/shared/csp.ts 写了为什么这样做与安全取舍）。动效库
// （border-beam、metal-fx、img-fx）都用 document.createElement('style') 建样式元素，其中 metal-fx、img-fx 在模块加载时
// 就插进 <head>，所以 main.tsx 第一个 import 本文件，先于任何库求值。由解析器建出的 <style>（innerHTML、DOMParser）
// 不经过这里，拿不到 nonce，照旧被 CSP 拦下。

interface ElementFactory {
  createElement(tagName: string, options?: ElementCreationOptions): HTMLElement;
}

/** 让 `target.createElement('style')` 建出的元素带上 `nonce`；其他元素不变。 */
export function installStyleNonce(target: ElementFactory, nonce: string): void {
  const create = target.createElement;
  target.createElement = function (this: unknown, tagName, options) {
    const element = create.call(this, tagName, options);
    if (element.localName === 'style') element.nonce = nonce;
    return element;
  };
}

// 导入即安装（测试在 Node 上导入，没有 document）。nonce 在 Vite 的 `html.cspNonce` 生成的 <meta property="csp-nonce">
// 上；CSP 生效的页面里 nonce 属性读出来是空的，要读 IDL 属性。
if (typeof document !== 'undefined') {
  const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
  if (nonce) installStyleNonce(Document.prototype as ElementFactory, nonce);
}
