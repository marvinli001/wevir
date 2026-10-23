# wevir-relay on Cloudflare Workers

The Wevir relay as a Cloudflare Worker with Durable Objects. It speaks the same wire protocol as the Node relay in [`apps/relay`](../relay/README.md), so a desktop, phone, `wevir --remote` CLI or browser that works with one works with the other unchanged. The Node relay stays the one to self-host on your own server; this one is for running a relay on Cloudflare, and it is what a browser needs, since a web page can only reach the desktop through a `wss://` relay.

Like the Node relay, it only forwards bytes. Every frame between a device and the desktop is Noise ciphertext (`Noise_XXpsk2` for pairing, `Noise_IK` after that), end to end. The relay never has the keys, never decrypts, does not store frames and does not log their contents.

## What the relay sees

- The desktop's route ID: an Ed25519 public key. The desktop proves it holds the private key by signing a fresh challenge every time it registers, so nobody else can take over its route.
- When connections open and close, and the size and timing of each message.
- Which path a device asked for: pairing or reconnecting.
- Client IP addresses, for rate limiting. They are not logged and never reach a Durable Object; the desktop only gets an opaque tag of each device's address (an HMAC that changes every UTC day) so that it can rate-limit failed handshakes without learning the address.

Cloudflare, as the operator of the platform, sees the same metadata. It does not see message contents, device names, session data, files, the pairing secret or the short pairing code.

## Behaviour

The same as the Node relay:

- No offline buffering. Each connection is its own Noise session; when either side disconnects, the other side is closed too and nothing is kept. Messages a device sends before the desktop has picked up the connection wait in a short queue (8 messages, 256 KiB, 10 s).
- Close codes from the desktop (device removed, permissions changed, remote access off) are passed through to the device unchanged. The relay's own close codes are 4100 desktop unavailable, 4101 registration failed, 4102 route registered again elsewhere, 4103 a relay limit was hit, 4104 protocol error, 4105 rejected by the desktop.
- Before the WebSocket upgrade it answers `404` for an unknown route or connection, `429` when a client address opens connections too fast, and `503` when a desktop already has as many device connections as allowed.
- Upgrades with an `Origin` header are accepted, so browser clients can connect.

Where Workers differ from a Node server:

- **Pings.** The Cloudflare runtime answers WebSocket pings itself, so the 30 s pings the desktop sends keep working, but a Worker cannot send pings. Dead connections are noticed when the platform closes them rather than by a relay ping.
- **Abrupt disconnects.** When one side drops without a close frame, the Node relay drops the other side the same way (the client sees 1006). A Worker cannot drop a connection without a close frame, so the other side gets a close frame without a status code (1005). Clients treat both the same.
- **Oversized messages** (more than one Noise message, 65535 bytes) close both sides with 4104 instead of the 1009 the Node relay's WebSocket library sends.
- **Limits that are not enforced here:** total routes and connections (Cloudflare scales), concurrent connections per client address, and per-connection bandwidth (a Worker cannot pause reading a WebSocket). What remains is the per-desktop connection limit, the per-address connection rate, the queue before the desktop picks up, and the message size limit.
- **`/healthz`** returns `{"status":"ok"}` without counts, because there is no global state to count.

## How it is built

The Worker itself only handles plain HTTP: the health check, the per-address rate limit, parameter checks and finding the right Durable Object. All WebSockets are accepted by Durable Objects with the WebSocket Hibernation API, so an idle desktop or an idle device connection costs no duration.

| Durable Object | One per | Holds |
|---|---|---|
| `Route` | route ID (`idFromName`) | which control connection currently owns the route (one row of SQLite storage) |
| `Control` | desktop control connection (`/v1/host`) | the control WebSocket, the challenge, and the IDs of its open device connections (in the WebSocket attachment, so they survive hibernation) |
| `Pipe` | device connection (`idFromName` of the 16-byte connection ID) | the device's WebSocket and the desktop's data connection for it (`/v1/accept?id=…`), forwarded to each other |

The control connection gets its own object because the desktop only says which route it is after the connection is open, and a Worker cannot move an accepted WebSocket to another Durable Object. Each device connection gets its own object because the desktop's data connection only carries the connection ID, which is too short to hold a Durable Object ID.

## Deploying

Requirements: a Cloudflare account and the domain's DNS zone on Cloudflare. Durable Objects use SQLite storage, which is available on the Workers Free plan.

From the repository root:

```sh
pnpm install
pnpm --filter "@wevir/relay-worker..." build
cd apps/relay-worker
pnpm exec wrangler login
pnpm exec wrangler secret put SOURCE_TAG_KEY   # any long random string
pnpm run deploy
```

The official instance is `wss://web.wevir.si`: [wevir-web](https://github.com/marvinli001/wevir-web) deploys this Worker's code from the wevir commit it pins, in the same Worker as the browser client. The page is served as static assets and only the relay's paths (`/v1/*`, `/healthz`) run the Worker, so a single domain serves both.

`wrangler.jsonc` serves the Worker on the custom domain `relay.example.com`; change `routes` to your own domain first. Cloudflare creates the DNS record and certificate. Then use `wss://<your domain>` as the relay address in Wevir.

`build` bundles the Worker into `dist/index.js` (a dry run of the deploy). The bundle includes `@wevir/protocol` and `zod` (MIT); the license text is copied to `dist/licenses/`.

To try it locally: `pnpm --filter @wevir/relay-worker dev` and use `ws://127.0.0.1:8787` as the relay address.

## Configuration

Variables go in `vars` in `wrangler.jsonc`; the key is a secret.

| Setting | Default | Meaning |
|---|---|---|
| `SOURCE_TAG_KEY` (secret) | unset | Key for the device address tags given to the desktop. Without it each Worker instance picks a random key, and the desktop's per-device handshake limit is less effective |
| `WEVIR_RELAY_MAX_CONNECTIONS_PER_ROUTE` | `32` | Device connections to one desktop (at most 64) |
| `WEVIR_RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `ratelimits` → `CONNECT_LIMITER` | 60 per 60 s | New WebSocket connections per client address (`CF-Connecting-IP`), counted per Cloudflare location. Remove the binding to turn the limit off |

Logs are one JSON object per line, visible with `wrangler tail` (Workers Logs is off in `wrangler.jsonc`). They contain registration events and the first 12 hex digits of a hash of the route ID, never full route IDs, addresses or message contents.

## Cost on the Workers Free plan

The free plan has daily limits (reset at 00:00 UTC). When one is used up, operations of that kind fail until the reset: new connections are refused and relayed messages stop. The ones this relay can reach:

- **Durable Object requests: 100,000 per day.** Each WebSocket a Durable Object accepts counts as one request, every call between objects counts as one, and **incoming WebSocket messages count at 20:1**. Every relayed message is incoming to a `Pipe` (in either direction), so 100,000 requests is about two million relayed messages a day, minus connection setup. A device connection costs about five requests to set up and tear down (route lookup, accept, notifying the desktop, the desktop's data connection, release). A registered desktop costs one or two per (re)connect and nothing while idle. Pings are not billed. In practice this is the limit a busy relay hits first: a session that streams agent output can relay tens of thousands of messages a day.
- **Worker requests: 100,000 per day.** Every WebSocket upgrade passes through the Worker once (a device connection is two: the device and the desktop's data connection). Messages on an open WebSocket are not Worker requests.
- **Duration: 13,000 GB-s per day**, billed at 128 MB per object while it is active or not eligible for hibernation. Hibernated objects cost nothing, so this only covers the time spent handling messages and the short windows with a timer running (up to 10 s while a desktop registers or picks up a device connection). It is unlikely to bite before the request limit.
- **SQLite rows written: 100,000 per day.** One write when a desktop registers and one when it goes offline.

On the Workers Paid plan these become billed usage instead of hard limits.

## Tests

`pnpm --filter @wevir/relay-worker test` bundles the Worker and runs the shared protocol tests from `apps/relay` (`@wevir/relay/conformance`) against it in Miniflare, the same suite the Node relay runs, plus a test that idles long enough for the Durable Objects to hibernate.

## Protocol

The wire format is defined in `packages/protocol/src/relay.ts` and described in [`apps/relay/README.md`](../relay/README.md#protocol).
