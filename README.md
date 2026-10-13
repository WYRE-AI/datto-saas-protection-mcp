# Datto SaaS Protection MCP Server

[![CI](https://github.com/WYRE-AI/datto-saas-protection-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WYRE-AI/datto-saas-protection-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
[Datto SaaS Protection (Backupify)](https://www.datto.com/products/saas-protection/)
API to Claude and other MCP clients.

## What it does

Surfaces SaaS backup posture for your Microsoft 365 and Google Workspace
customers to AI assistants, using the **documented Datto REST API**
(`https://api.datto.com/v1/saas/...`): list protected customers/domains,
inspect seats and their protection state, review backup status per
application, and (with confirmation) license, pause or unlicense seats in bulk.

- **Interactive Seat Card (MCP Apps)**: `datto_saas_get_seat` renders as an interactive card in MCP Apps hosts (Claude Desktop/web) — read-only, showing seat type and Datto seat state; neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars; plain-JSON behavior is unchanged in other hosts

## Tools

| Tool | Datto endpoint | Annotations |
| --- | --- | --- |
| `datto_saas_list_domains` | `GET /v1/saas/domains` | read-only |
| `datto_saas_list_seats` | `GET /v1/saas/{saasCustomerId}/seats` | read-only |
| `datto_saas_get_seat` | `GET /v1/saas/{saasCustomerId}/seats` (filtered to one seat) | read-only |
| `datto_saas_list_applications` | `GET /v1/saas/{saasCustomerId}/applications` | read-only |
| `datto_saas_get_backup_stats` | `GET /v1/saas/{saasCustomerId}/detailedBackupStats` | read-only |
| `datto_saas_bulk_seat_change` | `PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange` | **write, destructive** (asks for confirmation) |

Start with `datto_saas_list_domains`: it returns the `saasCustomerId` and
`externalSubscriptionId` every other tool needs.

> Earlier versions exposed `list_clients`, `list_backups`, `queue_restore`,
> `get_restore_status`, `list_activity` and `get_license_usage`. Those were
> built on routes Datto does not serve (`/v1/saas/clients`, `/restores`, …)
> and always returned 404, so they are removed.

## Credentials

Create an API key in the Datto Partner Portal (Admin > Integrations > API
Keys). The API uses HTTP Basic auth with the public/secret key pair. There is a
single API host (`api.datto.com`); there is no regional (EU) API host.

Copy [`.env.example`](.env.example) and set the variables below.

| Variable | Required | Description |
| --- | --- | --- |
| `DATTO_SAAS_PUBLIC_KEY` | For stdio and `AUTH_MODE=env` | Datto REST API public key |
| `DATTO_SAAS_SECRET_KEY` | For stdio and `AUTH_MODE=env` | Datto REST API secret key |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires `X-Datto-SaaS-Public-Key` and `X-Datto-SaaS-Secret-Key` on each `/mcp` request and never falls back to `DATTO_SAAS_*`. `env` uses those variables only after S2S auth succeeds. Unset means `env`. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `secret`, `replace-me`, `your-s2s-secret`, `replace-with-a-real-secret`, and the other example values, plus an unresolved `${...}` template). Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is overridden and that override is logged. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset defaults to `127.0.0.1`. The container image and Compose set `0.0.0.0` inside the container. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### Local (env mode)

```sh
export DATTO_SAAS_PUBLIC_KEY="..."
export DATTO_SAAS_SECRET_KEY="..."
```

### Hosted (gateway mode)

The WYRE MCP Gateway injects credentials per request via headers:

- `X-Datto-SaaS-Public-Key` (required, secret)
- `X-Datto-SaaS-Secret-Key` (required, secret)
- `X-Datto-SaaS-Region` (accepted for backward compatibility; ignored)

A request missing the public or secret key gets HTTP 401 and does not fall back to `DATTO_SAAS_PUBLIC_KEY` / `DATTO_SAAS_SECRET_KEY` in the process environment.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in [`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with `CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300 seconds of the server clock. A missing or invalid header is HTTP 401, before vendor credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-Datto-SaaS-Public-Key: $DATTO_SAAS_PUBLIC_KEY" \
  -H "X-Datto-SaaS-Secret-Key: $DATTO_SAAS_SECRET_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Run

```sh
npm install
npm run build
npm start                       # stdio
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http npm start
```

HTTP refuses to start until `CONDUIT_S2S_SECRET` is a real secret. Local HTTP without one is development-only and binds `127.0.0.1`:

```sh
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

### Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass a real S2S secret. In gateway mode, Datto credentials arrive on each request as headers; they are not read from the environment.

```bash
docker build -t datto-saas-protection-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  datto-saas-protection-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset. The gateway service sets `AUTH_MODE=gateway`, does not inject `DATTO_SAAS_PUBLIC_KEY` or `DATTO_SAAS_SECRET_KEY`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `DATTO_SAAS_PUBLIC_KEY` and `DATTO_SAAS_SECRET_KEY`. It is separate from the gateway Compose service above.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e DATTO_SAAS_PUBLIC_KEY=your-public-key \
  -e DATTO_SAAS_SECRET_KEY=your-secret-key \
  -p 127.0.0.1:8080:8080 \
  datto-saas-protection-mcp
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
