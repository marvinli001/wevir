// 内置浏览器打不开页面时给 agent 的原因（Chromium 的网络错误名与一句提示）。

export interface LoadFailure {
  /** Chromium 的网络错误名，例如 `ERR_CONNECTION_REFUSED`；认不出时为空。 */
  name: string;
  errno?: number;
  message: string;
}

/**
 * loadURL 的拒绝原因：Electron 的错误带 `code`（错误名）与 `errno`，消息是 “ERR_X (-N) loading '<url>'”；
 * 没有时用 did-fail-load 记下的。
 */
export function loadFailure(
  error: unknown,
  failed: { code: number; description: string } | undefined,
): LoadFailure {
  const message = error instanceof Error ? error.message : String(error);
  const record = (error ?? {}) as { code?: unknown; errno?: unknown };
  const parsed = /\b(ERR_[A-Z0-9_]+)\s*\((-?\d+)\)/.exec(message);
  const name =
    typeof record.code === 'string' && record.code.startsWith('ERR_')
      ? record.code
      : (parsed?.[1] ?? (failed?.description.startsWith('ERR_') ? failed.description : ''));
  const errno =
    typeof record.errno === 'number' ? record.errno : parsed ? Number(parsed[2]) : failed?.code;
  return { name, ...(errno !== undefined && { errno }), message };
}

const LOAD_FAILURE_HINTS: Array<[RegExp, string]> = [
  [
    /^ERR_CONNECTION_REFUSED$/,
    'Nothing accepted the connection: check that the server is running and the port is right.',
  ],
  [/^ERR_UNSAFE_PORT$/, 'Chromium blocks this port; use another one.'],
  [/^ERR_NAME_NOT_RESOLVED$/, 'The host name did not resolve.'],
  [/^ERR_(CONNECTION_TIMED_OUT|TIMED_OUT|ADDRESS_UNREACHABLE)$/, 'The server did not answer.'],
  [
    /^ERR_SSL_PROTOCOL_ERROR$/,
    'The TLS handshake failed: the server may not speak HTTPS on this port (try http://).',
  ],
  [/^ERR_(CERT_|SSL_)/, "The site's TLS certificate or connection is not trusted."],
];

export function loadFailureMessage(url: string, failure: LoadFailure): string {
  if (failure.name === '') return `Could not load ${url}: ${failure.message}`;
  const code = failure.errno !== undefined ? ` (${failure.errno})` : '';
  const hint = LOAD_FAILURE_HINTS.find(([pattern]) => pattern.test(failure.name))?.[1];
  return `Could not load ${url}: ${failure.name}${code}.${hint ? ` ${hint}` : ''}`;
}
