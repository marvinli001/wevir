# wevir-push

The push gateway for the Wevir phone app. When nobody is at the computer, the desktop can send a notification ("needs your approval", "finished") to the phones paired with it. Apple and Google only accept pushes from whoever holds the app's APNs key and Firebase service account, so this is the one part of remote access that has to run on a server operated by the app's developer. Wevir runs the official instance; the desktop uses it only when push is turned on in **Settings → Devices**, and it is off by default.

The gateway forwards ciphertext. The desktop encrypts every notification with a key that only it and that phone have (X25519 between the two static keys, HKDF-SHA256 with a push-only label, ChaCha20-Poly1305 with a replay counter; `packages/noise/src/push.ts`). The phone decrypts it on the device: the iOS Notification Service Extension rewrites the alert, the Android app builds the notification from a data message. The gateway never has the key.

## What the gateway sees

- Push tokens and their platform (`apns`, `apns_sandbox`, `fcm`), because it has to address APNs and FCM.
- The desktop's route ID (an Ed25519 public key) on every request it signs.
- When pushes are sent, how large they are, and an opaque collapse key (an HMAC under the push key, so it does not reveal which session a notification is about).
- Client IP addresses, for rate limiting. They are not logged.

It does not see notification titles, session names, computer names, message contents or anything else from the desktop. It stores no tokens: a binding is kept as a SHA-256 of route ID, platform and token, and a send request carries the token, which hashes to the same key.

If the gateway is compromised, the attacker learns the tokens and the metadata above, can drop or delay pushes, and can send pushes to any token it has seen (with the stolen APNs/FCM credentials, to any token at all). The phone discards anything that does not decrypt under its key for that computer and any envelope it has already seen, so the attacker cannot read notifications or make the phone show one of its own beyond the generic fallback text, and gets no access to the desktop.

## How binding works

The gateway only sends a push for a `(route ID, platform, token)` that was bound earlier, and only when the request is signed with that route's key. Binding needs both the phone and the desktop:

1. The phone, connected to the desktop over its encrypted tunnel, learns the gateway address and route ID (`push.get`), then calls `POST /v1/verify` with `{ routeId, platform, token }`. The gateway sends a silent push (APNs background push or FCM data message) to that token carrying a random code: `{ "wevir": "verify", "code": "…" }`. Codes last 10 minutes; a new request replaces the old code; five wrong tries discard it.
2. The phone gives the code to the desktop over the tunnel (`push.register`).
3. The desktop calls `POST /v1/bind` with `{ routeId, timestamp, nonce, platform, token, code }`, signed with its route key.

Someone who only knows a token cannot get the code, and someone who only has a code cannot sign for the desktop. A desktop unbinds a token with `POST /v1/unbind` when a phone is removed, push is turned off for it, or the phone reports a new token.

Pushes are `POST /v1/send` with `{ routeId, timestamp, nonce, platform, token, payload, collapseKey?, expiresAt }`. `payload` is the base64url envelope, at most 3000 characters. On APNs it is delivered as an alert with `mutable-content` and a localised fallback (`WEVIR_PUSH_TITLE` / `WEVIR_PUSH_BODY` in the app's strings) plus `{ "wevir": "push", "p": "…" }`; on FCM as a high-priority data message with the same two keys.

### Signatures

Signed requests carry `wevir-push-signature: <base64url Ed25519 signature>` over the bytes `wevir-push/1 <path>\n` followed by the raw request body. The route ID in the body is the public key. `timestamp` (milliseconds) must be within five minutes of the gateway's clock and `nonce` (16 random bytes, base64url) must not repeat within ten minutes.

### Responses

Success is `{}` (`202` for `verify`, `200` otherwise). Errors are `{ "error": { "code", "message" } }`:

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | Not JSON, wrong shape, too large (8 KiB), or `expiresAt` in the past or more than a day ahead |
| `bad_signature` | 401 | Missing or wrong signature |
| `stale_request` | 401 | Timestamp too far off, or the nonce was used |
| `bad_code` | 403 | Verification code wrong, expired or used |
| `not_bound` | 404 | The token is not bound to this route |
| `unregistered` | 410 | APNs or FCM no longer accepts the token; the binding was removed |
| `rate_limited` | 429 | A limit below, or APNs/FCM throttling |
| `upstream_failed` | 502 | APNs or FCM failed or could not be reached |
| `platform_unavailable` | 503 | This gateway has no credentials for that platform |

The schemas are in `packages/protocol/src/push.ts`.

## Running it

### Docker

Build the image from the repository root:

```sh
docker build -f apps/push/Dockerfile -t wevir-push .
```

The image contains no credentials. `deploy/` has a Compose file that runs the gateway behind [Caddy](https://caddyserver.com/) and mounts the credentials as Docker secrets from `deploy/secrets/` (ignored by git):

```sh
cd apps/push/deploy
mkdir -p secrets
cp /path/to/AuthKey_XXXXXXXXXX.p8 secrets/AuthKey.p8
cp /path/to/service-account.json secrets/fcm-service-account.json
PUSH_DOMAIN=push.example.com APNS_KEY_ID=XXXXXXXXXX APNS_TEAM_ID=YYYYYYYYYY APNS_TOPIC=com.example.app \
  docker compose up -d
```

Point the domain's DNS at the machine first and open ports 80 and 443. Bindings are stored in the `push-data` volume.

Behind a TLS proxy you already run, such as a hosting platform that deploys Compose files from a Git repository, use `deploy/compose.proxied.yaml` instead: it builds the image from the repository, runs only the gateway on port 8080 with `WEVIR_PUSH_TRUST_PROXY=1`, and takes the credentials inline from environment variables (`WEVIR_PUSH_APNS_KEY` with the `.p8` contents, `WEVIR_PUSH_FCM_CREDENTIALS` with the service account JSON). Route the gateway's domain to port 8080 and keep that port closed to the internet.

### Without Docker

Node 24 or later:

```sh
pnpm install
pnpm --filter "@wevir/push..." build
node apps/push/dist/main.js
```

`dist/` is self-contained (dependencies are bundled).

## Configuration

All settings are environment variables. Credentials can be given inline or as a path to a mounted file (`…_FILE`), not both. Error messages name the variable, never its contents.

| Variable | Default | Meaning |
|---|---|---|
| `WEVIR_PUSH_PORT` | `8080` | Port to listen on |
| `WEVIR_PUSH_HOST` | `0.0.0.0` | Address to listen on |
| `WEVIR_PUSH_TLS_CERT`, `WEVIR_PUSH_TLS_KEY` | unset | PEM certificate chain and key; without them the gateway speaks plain HTTP and expects a TLS proxy in front |
| `WEVIR_PUSH_TRUST_PROXY` | off | Take the client address from the last `X-Forwarded-For` entry. Only behind a proxy you run |
| `WEVIR_PUSH_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `WEVIR_PUSH_DATA_DIR` | unset (`/data` in the image) | Directory for `bindings.db` (SQLite). Unset keeps bindings in memory; phones bind again the next time they connect to their computer |
| `WEVIR_PUSH_APNS_KEY` / `WEVIR_PUSH_APNS_KEY_FILE` | unset | The APNs auth key (`.p8`, token-based authentication) |
| `WEVIR_PUSH_APNS_KEY_ID` | unset | Its key ID |
| `WEVIR_PUSH_APNS_TEAM_ID` | unset | The Apple developer team ID |
| `WEVIR_PUSH_APNS_TOPIC` | unset | The app's bundle ID |
| `WEVIR_PUSH_APNS_URL`, `WEVIR_PUSH_APNS_SANDBOX_URL` | Apple's production and sandbox hosts | Override for testing |
| `WEVIR_PUSH_FCM_CREDENTIALS` / `WEVIR_PUSH_FCM_CREDENTIALS_FILE` | unset | The Firebase service account JSON (`project_id`, `client_email`, `private_key`, optional `token_uri`) |
| `WEVIR_PUSH_FCM_URL` | `https://fcm.googleapis.com` | Override for testing |
| `WEVIR_PUSH_SENDS_PER_HOUR_PER_ROUTE` | `600` | Pushes one computer can send per hour |
| `WEVIR_PUSH_SENDS_PER_HOUR_PER_TOKEN` | `120` | Pushes one token can receive per hour |
| `WEVIR_PUSH_VERIFIES_PER_HOUR_PER_TOKEN` | `6` | Verification codes per token per hour |
| `WEVIR_PUSH_VERIFIES_PER_HOUR_PER_SOURCE` | `60` | Verification codes per client address per hour |
| `WEVIR_PUSH_REQUESTS_PER_MINUTE_PER_SOURCE` | `600` | Requests of any kind per client address per minute |
| `WEVIR_PUSH_MAX_BINDINGS_PER_ROUTE` | `32` | Tokens bound to one computer |
| `WEVIR_PUSH_BINDS_PER_HOUR_PER_ROUTE` | `60` | Binds and unbinds per computer per hour |

APNs and FCM are each optional; requests for a platform without credentials get `platform_unavailable`. APNs provider tokens are renewed every 40 minutes; one key serves both the production and sandbox hosts. Bindings unused for 180 days are pruned.

## Health check

`GET /healthz` returns `200` with `{"status":"ok","bindings":…,"apns":…,"fcm":…,"uptimeSeconds":…}`. The Docker image uses it as its `HEALTHCHECK`.

Logs are one JSON object per line on stdout: the outcome of each request and the first 12 hex digits of a hash of the route ID and token, never full tokens, payloads, codes or addresses.

## Licenses

The image bundles [zod](https://github.com/colinhacks/zod) (MIT); its license text is in `LICENSES/` and copied into the image.
