export async function prepareBrowserViewport(cdp, sessionId, address) {
  await cdp.evaluate(`document.querySelector('[data-testid="launch-browser"]').click()`);
  const tabId = await cdp.evaluate(
    `window.wevir.browser.open(${JSON.stringify(sessionId)}, ${JSON.stringify(address)})`,
  );
  await cdp.evaluate(`new Promise(resolve => setTimeout(resolve, 900))`);
  if ((await cdp.evaluate('window.wevir.browser.state()')).activeTabId !== tabId)
    throw new Error('Browser viewport was not shown');
  await cdp.evaluate(`(() => {
    const original = Element.prototype.getBoundingClientRect;
    globalThis.__wevirBrowserReads = {count: 0};
    Element.prototype.getBoundingClientRect = function(...args) {
      const rect = original.apply(this, args);
      if (this.dataset?.testid === 'browser-viewport') {
        globalThis.__wevirBrowserReads.count++;
        globalThis.__wevirBrowserReads.lastX = rect.x;
      }
      return rect;
    };
  })()`);
  return tabId;
}

export async function measureBrowserViewport(cdp, desktop, tabId) {
  let requestId = 0;
  const nativeViews = async () => {
    const id = ++requestId;
    desktop.stdin.write(`${JSON.stringify({ type: 'native-views', id })}\n`);
    return cdp.evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 2000;
      const poll = () => {
        const value = globalThis.__wevirNativeViews;
        if (value?.id === ${id}) resolve(value.views);
        else if (Date.now() > deadline) reject(new Error('Native view probe timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    })`);
  };
  const streamingReads = await cdp.evaluate('globalThis.__wevirBrowserReads.count');
  const idleReads = await cdp.evaluate(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    await wait(700);
    const beforeIdle = globalThis.__wevirBrowserReads.count;
    await wait(1000);
    return globalThis.__wevirBrowserReads.count - beforeIdle;
  })()`);
  await cdp.evaluate(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const viewport = document.querySelector('[data-testid="browser-viewport"]');
    const rect = viewport.getBoundingClientRect();
    const portal = globalThis.__wevirPerfPortal = document.createElement('div');
    portal.setAttribute('data-base-ui-portal', '');
    document.body.append(portal);
    await wait(20);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    Object.assign(menu.style, {position: 'fixed', left: (rect.x + 5) + 'px', top: (rect.y + 5) + 'px', width: '100px', height: '100px'});
    portal.append(menu);
    await wait(150);
  })()`);
  const covered = await nativeViews();
  await cdp.evaluate(`(async () => {
    globalThis.__wevirPerfPortal.firstElementChild.hidden = true;
    await new Promise(resolve => setTimeout(resolve, 650));
  })()`);
  const uncovered = await nativeViews();
  const movedBy = await cdp.evaluate(`(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    globalThis.__wevirPerfPortal.remove();
    await wait(650);
    const viewport = document.querySelector('[data-testid="browser-viewport"]');
    const parent = viewport.parentElement;
    const beforeX = globalThis.__wevirBrowserReads.lastX;
    parent.style.transform = 'translateX(8px)';
    await wait(120);
    const movedBy = globalThis.__wevirBrowserReads.lastX - beforeX;
    parent.style.transform = '';
    return movedBy;
  })()`);
  const overlays = { idleReads, covered, uncovered, movedBy };
  if (
    covered.some((view) => view.visible) ||
    !uncovered.some((view) => view.visible) ||
    (await cdp.evaluate('window.wevir.browser.state()')).activeTabId !== tabId ||
    Math.abs(overlays.movedBy - 8) > 1
  )
    throw new Error(`Browser overlay or ancestor geometry failed: ${JSON.stringify(overlays)}`);
  desktop.stdin.write('{"type":"background"}\n');
  await cdp.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
  const hiddenBefore = await cdp.evaluate('globalThis.__wevirBrowserReads.count');
  await cdp.evaluate('new Promise(resolve => setTimeout(resolve, 1100))');
  const hiddenReads = (await cdp.evaluate('globalThis.__wevirBrowserReads.count')) - hiddenBefore;
  const hidden = await cdp.evaluate('document.visibilityState');
  desktop.stdin.write('{"type":"foreground"}\n');
  await cdp.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
  if (hidden !== 'hidden') throw new Error('Browser hidden-window measurement was not hidden');
  return { streamingReads, hiddenReads, ...overlays };
}
