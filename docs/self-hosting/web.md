# Self-hosting Wevir Web

English · [简体中文](web.zh-CN.md)

[Wevir Web](https://github.com/marvinli001/wevir-web) on your own server: the browser client and the relay on one domain, matching `web.wevir.si`.

| Path | Served by |
| --- | --- |
| `/v1/*`, `/healthz` | Relay ([`apps/relay`](../../apps/relay/README.md)), WebSocket |
| All other paths | Static site (`dist/`); unknown paths return `index.html` |

Caddy terminates TLS, obtains certificates, and applies the site's security headers. The relay image is built from the wevir commit pinned by the wevir-web submodule, so the site and the relay share one protocol version.

## Requirements

- Linux server, amd64 or arm64, 2 GiB RAM or more for the site build
- Docker Engine with Compose v2
- Ports 80 and 443 (TCP) and 443 (UDP) open
- A domain whose A/AAAA record points to the server; examples use `wevir.example.com`

## Layout

| Path | Contents |
| --- | --- |
| `/opt/wevir-web` | wevir-web clone with the wevir submodule |
| `/opt/wevir-web/dist` | Site build output |
| `/opt/wevir-web-server` | `compose.yaml`, `Caddyfile`, `.env` |

## Deployment

### 1. Source

```sh
git clone --recurse-submodules https://github.com/marvinli001/wevir-web.git /opt/wevir-web
```

### 2. Site build

```sh
docker run --rm -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -v /opt/wevir-web:/src -w /src node:24 \
  sh -c 'corepack enable && pnpm run setup && pnpm run build'
```

Output: `/opt/wevir-web/dist`. `pnpm run setup` installs the dependencies of the pinned wevir commit from its lockfile. Building on another machine (Node 24.22.1+, pnpm 12.6.0) and copying `dist/` to the server is equivalent.

### 3. Server configuration

`/opt/wevir-web-server/compose.yaml`:

```yaml
services:
  relay:
    build:
      context: ../wevir-web/wevir
      dockerfile: apps/relay/Dockerfile
    image: wevir-relay
    restart: unless-stopped
    environment:
      WEVIR_RELAY_TRUST_PROXY: "1"
      WEVIR_RELAY_LOG_LEVEL: info
    expose:
      - "8080"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      WEB_DOMAIN: ${WEB_DOMAIN:?set WEB_DOMAIN}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ../wevir-web/dist:/srv/wevir-web:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - relay

volumes:
  caddy-data:
  caddy-config:
```

`/opt/wevir-web-server/Caddyfile` (header values from wevir-web's [`public/_headers`](https://github.com/marvinli001/wevir-web/blob/main/public/_headers)):

```caddyfile
{$WEB_DOMAIN} {
	@relay path /v1/* /healthz
	handle @relay {
		reverse_proxy relay:8080
	}

	handle {
		root * /srv/wevir-web
		encode zstd gzip
		header {
			Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss:; media-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
			Referrer-Policy "no-referrer"
			X-Content-Type-Options "nosniff"
			X-Frame-Options "DENY"
			Cross-Origin-Opener-Policy "same-origin"
			Cross-Origin-Resource-Policy "same-origin"
			Permissions-Policy "camera=(self), geolocation=(), microphone=(self), payment=(), usb=()"
			Strict-Transport-Security "max-age=63072000; includeSubDomains"
			-Server
		}
		@assets path /assets/*
		header @assets Cache-Control "public, max-age=31536000, immutable"
		try_files {path} /index.html
		file_server
	}
}
```

`/opt/wevir-web-server/.env`:

```sh
WEB_DOMAIN=wevir.example.com
```

### 4. Start

```sh
cd /opt/wevir-web-server
docker compose up -d --build
```

### 5. Verification

```sh
curl -fsS https://wevir.example.com/healthz
curl -fsSI https://wevir.example.com/pair
docker compose ps
```

| Check | Expected |
| --- | --- |
| `/healthz` | `200`, `{"status":"ok","routes":…,"connections":…}` |
| `/pair` | `200`, `text/html`, `Content-Security-Policy` header |
| `docker compose ps` | `relay` healthy, `caddy` running |

## Desktop configuration

**Settings → Devices**:

| Setting | Value |
| --- | --- |
| Relay | Custom address: `wss://wevir.example.com` |
| Web client address | `https://wevir.example.com` |

Pairing: **Add web device** → open the pairing link in the browser → approve on the computer. Pairing is per origin; browsers paired with `web.wevir.si` pair again with the self-hosted address.

## Updates

```sh
cd /opt/wevir-web
git pull
git submodule update --init
docker run --rm -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -v /opt/wevir-web:/src -w /src node:24 \
  sh -c 'corepack enable && pnpm run setup && pnpm run build'
cd /opt/wevir-web-server
docker compose up -d --build
```

After an update, compare the Caddyfile headers with `public/_headers`.

## Operation

- The relay forwards Noise ciphertext only; it holds no keys and stores no messages. Logs are JSON lines on stdout, without addresses or route IDs: `docker compose logs relay`.
- `WEVIR_RELAY_TRUST_PROXY=1` is valid only with Caddy in front; the relay port stays unpublished.
- Relay limits and other variables: [`apps/relay/README.md`](../../apps/relay/README.md#configuration).
- The production CSP permits `wss://` relays only.

## Alternatives

| Deployment | Reference |
| --- | --- |
| Cloudflare Workers, site and relay as one Worker | [wevir-web README](https://github.com/marvinli001/wevir-web#self-hosting) |
| Vercel or another static host, site only | [wevir-web README](https://github.com/marvinli001/wevir-web#self-hosting) |
| Relay only (phone, remote CLI) | [`apps/relay`](../../apps/relay/README.md), [`apps/relay-worker`](../../apps/relay-worker/README.md) |

## Agent prompt

For an agent with SSH access to the server (Wevir, Codex, Claude Code). Replace `<SSH target>` and `<domain>`.

```text
Deploy Wevir Web on <SSH target> at https://<domain>, following
https://github.com/marvinli001/wevir/blob/master/docs/self-hosting/web.md

Scope
- One domain: /v1/* and /healthz to the Node relay, all other paths to the static site with index.html as fallback.
- Docker Compose with Caddy for TLS; relay image built from the wevir commit pinned by the wevir-web submodule.
- Security headers identical to wevir-web's public/_headers.
- Directories: /opt/wevir-web (source and dist), /opt/wevir-web-server (compose.yaml, Caddyfile, .env).

Preconditions (stop and report on failure)
- Docker Engine and Compose v2 present.
- Ports 80/tcp, 443/tcp, 443/udp free and reachable.
- <domain> resolves to the server's public address.
- At least 2 GiB RAM available for the site build.

Constraints
- Relay port not published; WEVIR_RELAY_TRUST_PROXY=1 only behind Caddy.
- No changes to other services, firewall rules, or DNS records without confirmation.
- No secrets in files, commands, or output.

Acceptance
- curl -fsS https://<domain>/healthz returns {"status":"ok",...}.
- curl -fsSI https://<domain>/pair returns 200 with a Content-Security-Policy header.
- docker compose ps: relay healthy, caddy running.

Report
- wevir-web commit and pinned wevir commit.
- Relay address wss://<domain> and web client address https://<domain>.
- Deviations from the guide, with reasons.
```
