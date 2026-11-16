/** 只接受 Host 主题快照的单文件地址，不将缓存扩展成任意网页入口。 */
export function isThemeAssetUrl(value: string, file?: string, revision?: string): boolean {
  try {
    const url = new URL(value);
    const path = /^\/files\/[A-Za-z0-9_-]+\/([a-z0-9._-]+)$/.exec(url.pathname);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port !== '' &&
      url.username === '' &&
      url.password === '' &&
      path !== null &&
      (file === undefined || path[1] === file) &&
      (revision === undefined || url.searchParams.get('v') === revision) &&
      [...url.searchParams.keys()].every(
        (key) =>
          key === 'v' ||
          key === 'theme-scene' ||
          (key === 'theme-mount' && isThemeSceneId(url.searchParams.get(key))),
      )
    );
  } catch {
    return false;
  }
}

export function isThemeSceneId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^wevir-theme-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
  );
}

export function isThemeSceneUrl(value: string): boolean {
  return (
    isThemeAssetUrl(value, 'backdrop.html') &&
    new URL(value).searchParams.get('theme-scene') === '1'
  );
}
