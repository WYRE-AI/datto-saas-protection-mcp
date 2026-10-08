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

## Run

```sh
npm install
npm run build
npm start                       # stdio
MCP_TRANSPORT=http npm start    # HTTP on :8080
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
