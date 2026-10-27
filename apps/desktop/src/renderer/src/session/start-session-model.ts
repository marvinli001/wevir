// 新建会话的流程里不依赖界面的部分（start-session.ts）。

/** 先开始 `side`（不会失败的，如重读列表）再做 `main`；`main` 成功后等 `side` 做完，失败时直接抛出、不等。 */
export async function alongside(
  main: () => Promise<void>,
  side: (() => Promise<void>) | undefined,
): Promise<void> {
  const done = side?.();
  await main();
  await done;
}
