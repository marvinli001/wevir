# 自建 Wevir Web

[English](web.md) · 简体中文

在自有服务器上部署 [Wevir Web](https://github.com/marvinli001/wevir-web)：网页客户端与中继共用一个域名，结构与 `web.wevir.si` 一致。

| 路径 | 服务 |
| --- | --- |
| `/v1/*`、`/healthz` | 中继（[`apps/relay`](../../apps/relay/README.md)），WebSocket |
| 其他路径 | 静态站点（`dist/`），未知路径返回 `index.html` |

Caddy 负责 TLS 终止、证书签发与站点安全响应头。中继镜像由 wevir-web 子模块钉住的 wevir 提交构建，站点与中继协议版本一致。

## 环境要求

- Linux 服务器，amd64 或 arm64，站点构建需 2 GiB 以上内存
- Docker Engine 与 Compose v2
- 开放端口 80、443（TCP）与 443（UDP）
- 域名 A/AAAA 记录指向该服务器；示例域名为 `wevir.example.com`

## 目录

| 路径 | 内容 |
| --- | --- |
| `/opt/wevir-web` | wevir-web 克隆，含 wevir 子模块 |
| `/opt/wevir-web/dist` | 站点构建产物 |
| `/opt/wevir-web-server` | `compose.yaml`、`Caddyfile`、`.env` |

## 部署

### 1. 源码

```sh
git clone --recurse-submodules https://github.com/marvinli001/wevir-web.git /opt/wevir-web
```

### 2. 构建站点

```sh
docker run --rm -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -v /opt/wevir-web:/src -w /src node:24 \
  sh -c 'corepack enable && pnpm run setup && pnpm run build'
```

产物：`/opt/wevir-web/dist`。`pnpm run setup` 按钉住的 wevir 提交的锁文件安装依赖。也可在其他机器（Node 24.22.1+、pnpm 12.6.0）构建后将 `dist/` 复制到服务器。

### 3. 服务配置

`/opt/wevir-web-server/compose.yaml`：

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

`/opt/wevir-web-server/Caddyfile`（响应头取自 wevir-web 的 [`public/_headers`](https://github.com/marvinli001/wevir-web/blob/main/public/_headers)）：

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

`/opt/wevir-web-server/.env`：

```sh
WEB_DOMAIN=wevir.example.com
```

### 4. 启动

```sh
cd /opt/wevir-web-server
docker compose up -d --build
```

### 5. 验证

```sh
curl -fsS https://wevir.example.com/healthz
curl -fsSI https://wevir.example.com/pair
docker compose ps
```

| 检查项 | 预期 |
| --- | --- |
| `/healthz` | `200`，`{"status":"ok","routes":…,"connections":…}` |
| `/pair` | `200`，`text/html`，带 `Content-Security-Policy` 响应头 |
| `docker compose ps` | `relay` 为 healthy，`caddy` 为 running |

## 桌面端配置

**设置 → 设备**：

| 设置项 | 值 |
| --- | --- |
| 中继 | 自建地址：`wss://wevir.example.com` |
| 网页地址 | `https://wevir.example.com` |

配对：**添加网页设备** → 在浏览器打开配对链接 → 在电脑上批准。配对按来源（origin）区分，已与 `web.wevir.si` 配对的浏览器需在自建地址重新配对。

## 更新

```sh
cd /opt/wevir-web
git pull
git submodule update --init
docker run --rm -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 -v /opt/wevir-web:/src -w /src node:24 \
  sh -c 'corepack enable && pnpm run setup && pnpm run build'
cd /opt/wevir-web-server
docker compose up -d --build
```

更新后核对 Caddyfile 响应头与 `public/_headers` 是否一致。

## 运维

- 中继只转发 Noise 密文，不持有密钥、不存储消息。日志为 stdout 上的 JSON 行，不含地址与路由 ID：`docker compose logs relay`。
- `WEVIR_RELAY_TRUST_PROXY=1` 仅在 Caddy 前置时有效；中继端口不对外发布。
- 中继限额与其他变量：[`apps/relay/README.md`](../../apps/relay/README.md#configuration)。
- 生产环境 CSP 仅允许 `wss://` 中继。

## 其他部署方式

| 方式 | 参考 |
| --- | --- |
| Cloudflare Workers，站点与中继同一 Worker | [wevir-web README](https://github.com/marvinli001/wevir-web/blob/main/README.zh-CN.md) |
| Vercel 或其他静态托管，仅站点 | [wevir-web README](https://github.com/marvinli001/wevir-web/blob/main/README.zh-CN.md) |
| 仅中继（手机、远程 CLI） | [`apps/relay`](../../apps/relay/README.md)、[`apps/relay-worker`](../../apps/relay-worker/README.md) |

## Agent 提示词

适用于可通过 SSH 访问服务器的 agent（Wevir、Codex、Claude Code）。替换 `<SSH 目标>` 与 `<域名>`。

```text
按 https://github.com/marvinli001/wevir/blob/master/docs/self-hosting/web.zh-CN.md
在 <SSH 目标> 上部署 Wevir Web，访问地址 https://<域名>。

范围
- 单域名：/v1/* 与 /healthz 转发至 Node 中继，其余路径为静态站点，回退至 index.html。
- Docker Compose + Caddy 提供 TLS；中继镜像由 wevir-web 子模块钉住的 wevir 提交构建。
- 安全响应头与 wevir-web 的 public/_headers 完全一致。
- 目录：/opt/wevir-web（源码与 dist），/opt/wevir-web-server（compose.yaml、Caddyfile、.env）。

前置条件（任一不满足即停止并报告）
- 已安装 Docker Engine 与 Compose v2。
- 端口 80/tcp、443/tcp、443/udp 空闲且可从公网访问。
- <域名> 解析至服务器公网地址。
- 站点构建可用内存不少于 2 GiB。

约束
- 中继端口不对外发布；WEVIR_RELAY_TRUST_PROXY=1 仅在 Caddy 之后使用。
- 未经确认，不改动其他服务、防火墙规则与 DNS 记录。
- 文件、命令与输出中不出现密钥。

验收
- curl -fsS https://<域名>/healthz 返回 {"status":"ok",...}。
- curl -fsSI https://<域名>/pair 返回 200，带 Content-Security-Policy 响应头。
- docker compose ps：relay 为 healthy，caddy 为 running。

报告
- wevir-web 提交与钉住的 wevir 提交。
- 中继地址 wss://<域名> 与网页地址 https://<域名>。
- 与文档不一致之处及原因。
```
