export interface GatewayAuthSource {
  baseURL(providerId: string): string | undefined;
  onDenied?(request: {
    providerId: string;
    authorization: string;
    status: 401 | 403;
  }): Promise<void>;
  authorize(request: {
    providerId: string;
    url: string;
    body: Uint8Array;
    signal: AbortSignal;
  }): Promise<
    | { ok: true; headers: Record<string, string>; secrets: readonly string[] }
    | { ok: false; status: 401 | 403 | 429 | 503; code: string }
  >;
}
