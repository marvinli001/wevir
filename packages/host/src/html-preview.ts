// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/shared/src/htmlRender.ts（blankNonMarkup、injectHtmlRenderBootstrap、BOOTSTRAP_SCRIPT 里点链接的部分）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只留“点了链接请父页面打开”这一段（T3 的主题变量、内容高度与快捷键转发是给 agent 的 html_render 用的，文件预览不要）；
// 同一个 Host 文件地址下的链接（站内的其他页面）照常在框里打开。
//
// 文件窗格里的网页（0.32.0，file-urls.ts）：页面在沙箱框架里，主进程不让子框架跳到 Host 的文件地址之外（apps/desktop 的
// main/index.ts）。页面里点外部链接时，这段脚本拦下点击，经 postMessage（MCP Apps 的 `ui/open-link`，同 T3）请桌面端打开；
// 桌面端只在框架有焦点、用户刚操作过时才交给系统浏览器（layout/panes/file-viewers.tsx）。

const OPEN_LINK_METHOD = 'ui/open-link';

// 捕获阶段拦下可信的点击：http(s) 链接、不是本页的锚点、不在同一个文件地址下时，请父页面打开；没有父页面时改成新窗口。
const BOOTSTRAP_SCRIPT = `(function(){var n=0;document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(u.host===location.host&&u.pathname.indexOf("/files/")===0)return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"wevir-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);})();`;

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html: string) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => ' '.repeat(match.length),
  );
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), ' '.repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), ' '.repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join('');
};

/**
 * Inserts the bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export function injectHtmlPreviewBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = `<script>${BOOTSTRAP_SCRIPT}</script>`;
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
