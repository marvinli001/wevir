# wevir-relay

The optional relay for Wevir remote access. A phone or a remote `wevir` CLI normally reaches the desktop directly, over the local network or Tailscale. When the two are on different networks and there is no Tailscale, the desktop can open an outbound connection to a relay and devices reach it through there instead. Relay use is off by default and is turned on per computer in **Settings → Devices**.

The relay only forwards bytes. Every frame between a device and the desktop is Noise ciphertext (`Noise_XXpsk2` for pairing, `Noise_IK` after that), end to end. The relay never has the keys, never decrypts, does not write frames to disk and does not log their contents. If a relay is compromised, the attacker learns metadata (see below) and can drop or delay connections, but cannot read or forge messages.

There is an official instance at `wss://relay.wevir.si`. You can run your own and put its address in **Settings → Devices → Relay address**.

## What the relay sees

- The desktop's route ID: an Ed25519 public key. The desktop proves it holds the private key by signing a fresh challenge every time it registers, so nobody else can take over its route.
- When connections open and close, and the size and timing of each message.
- Which path a device asked for: pairing or reconnecting.
- Client IP addresses, for rate limiting. They are not logged, and the desktop only gets an opaque per-process tag of each device's address so that it can rate-limit failed handshakes without learning the address.

It does not see message contents, device names, session data, files, the pairing secret or the short pairing code.

## Behaviour

- No offline buffering. Each connection is its own Noise session; when either side disconnects, the other side is closed too and nothing is kept. Clients catch up with the event sequence numbers after reconnecting. Messages a device sends before the desktop has picked up the connection wait in a short queue (8 messages, 256 KiB, 10 s).
- Close codes from the desktop (device removed, permissions changed, remote access off) are passed through to the device unchanged. The relay's own close codes are in the 4100–4199 range: 4100 desktop unavailable, 4101 registration failed, 4102 route registered again elsewhere, 4103 a relay limit was hit, 4104 protocol error, 4105 rejected by the desktop.
- Every connection is pinged every 30 s and dropped if it does not answer.

## Running it

### Docker

Build the image from the repository root:

```sh
docker build -f apps/relay/Dockerfile -t wevir-relay .
```

Run it behind something that terminates TLS. `deploy/` has a Compose file that puts it behind [Caddy](https://caddyserver.com/), which gets and renews the certificate:

```sh
cd apps/relay/deploy
RELAY_DOMAIN=relay.example.com docker compose up -d
```

Point the domain's DNS at the machine first and open ports 80 and 443. Then use `wss://relay.example.com` as the relay address in Wevir.

To serve TLS from the relay itself instead, mount a certificate and key and set `WEVIR_RELAY_TLS_CERT` and `WEVIR_RELAY_TLS_KEY`.

### Without Docker

Node 24 or later:

```sh
pnpm install
pnpm --filter "@wevir/relay..." build
node apps/relay/dist/main.js
```

`dist/` is self-contained (dependencies are bundled), so you can copy it to a server and run `node main.js` there.

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `WEVIR_RELAY_PORT` | `8080` | Port to listen on |
| `WEVIR_RELAY_HOST` | `0.0.0.0` | Address to listen on |
| `WEVIR_RELAY_TLS_CERT`, `WEVIR_RELAY_TLS_KEY` | unset | PEM certificate chain and key; without them the relay speaks plain `ws://` and expects a TLS proxy in front |
| `WEVIR_RELAY_TRUST_PROXY` | off | Take the client address from the last `X-Forwarded-For` entry. Turn it on only behind a proxy you run, or anyone can spoof addresses and slip past the rate limits |
| `WEVIR_RELAY_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. `debug` adds one line per device connection |
| `WEVIR_RELAY_MAX_ROUTES` | `10000` | Desktops registered at once |
| `WEVIR_RELAY_MAX_CONNECTIONS` | `20000` | WebSocket connections in total |
| `WEVIR_RELAY_MAX_CONNECTIONS_PER_ROUTE` | `32` | Device connections to one desktop |
| `WEVIR_RELAY_MAX_CONNECTIONS_PER_SOURCE` | `64` | Connections from one client address at once |
| `WEVIR_RELAY_CONNECTS_PER_MINUTE` | `60` | New connections per client address per minute |
| `WEVIR_RELAY_BYTES_PER_SECOND` | `2097152` | Bandwidth per connection and direction. Over the limit the relay stops reading from that side for a moment; nothing is dropped |
| `WEVIR_RELAY_BURST_BYTES` | `8388608` | Burst allowance per connection and direction (keep it at 4 MiB or more, the largest frame) |

## Health check

`GET /healthz` returns `200` with `{"status":"ok","routes":…,"connections":…,"pending":…,"uptimeSeconds":…}`. The Docker image uses it as its `HEALTHCHECK`. Any other plain HTTP request gets `404`.

Logs are one JSON object per line on stdout. They contain connection events, counts and the first 12 hex digits of a hash of the route ID, never full route IDs, addresses or message contents.

## Protocol

The wire format is defined in `packages/protocol/src/relay.ts`.

1. The desktop opens `GET /v1/host` (WebSocket). The relay sends `{"type":"challenge","nonce":…}`; the desktop answers `{"type":"register","routeId":…,"signature":…}`, an Ed25519 signature over `wevir-relay/1 register\n<nonce>`. The relay replies `{"type":"registered"}`.
2. A device opens `/v1/connect?route=<route ID>` (or `/v1/pair`, `/v1/pair-code` for pairing). An unknown route gets `404`. The relay tells the desktop `{"type":"incoming","id":…,"path":…,"source":…}`.
3. The desktop opens `/v1/accept?id=<id>` for that device, or sends `{"type":"reject","id":…}`. The relay pairs the two connections and forwards binary messages, one Noise message per WebSocket message (at most 65535 bytes), in both directions. Text messages on these connections are a protocol error.
