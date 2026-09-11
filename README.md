# Datto SaaS Protection MCP Server

[![CI](https://github.com/WYRE-AI/datto-saas-protection-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WYRE-AI/datto-saas-protection-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
[Datto SaaS Protection (Backupify)](https://www.datto.com/products/saas-protection/)
API to Claude and other MCP clients.

## What it does

Surface SaaS backup posture for your M365 and Google Workspace tenants directly
to AI assistants — list the customers your API key protects, inspect their
domains, seats and backup/storage reports, and audit the partner portal
activity log.

- **Interactive Seat Card (MCP Apps)**: `datto_saas_get_seat` renders as an interactive card in MCP Apps hosts (Claude Desktop/web) — read-only, showing seat type, state, billing and protection start date; neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars; plain-JSON behavior is unchanged in other hosts

## API contract

Every tool maps onto a route Datto actually serves, on a single host with HTTP
Basic auth (public key as username, secret key as password):

| Route | Used by |
| --- | --- |
| `GET https://api.datto.com/v1/saas/domains` | `list_domains`, `list_clients`, `get_license_usage` |
| `GET https://api.datto.com/v1/saas/{saasCustomerId}/seats` | `list_seats`, `get_seat` |
| `GET https://api.datto.com/v1/saas/{saasCustomerId}/applications` | `get_backup_report` |
| `GET https://api.datto.com/v1/report/activity-log` | `list_activity` |

There is **no** regional host split, no `/clients` route, no per-seat route and
no restore API. Seats are scoped by `saasCustomerId`, not by domain. The host
and paths are pinned by wire-contract tests in `test/datto-api.test.ts`.

This server is read-only: the client exposes no method capable of issuing
anything but a `GET`, so the one write route on the SaaS surface
(`PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange`)
cannot be reached through it.

## Tools

| Tool | Purpose |
| --- | --- |
| `datto_saas_list_clients` | Customers protected by the key, with domains and seats used (derived from `/v1/saas/domains`) |
| `datto_saas_list_domains` | Protected domains, each with its `saasCustomerId`, subscription and 24h backup stats |
| `datto_saas_list_seats` | A customer's seats — mailboxes, sites, teams, drives — optionally filtered by seat type |
| `datto_saas_get_seat` | One seat by `mainId` (usually an email) or `remoteId` |
| `datto_saas_get_backup_report` | A customer's backup/storage report — protected suites and bytes used |
| `datto_saas_list_activity` | Partner portal activity log, filterable by client, user and look-back window |
| `datto_saas_get_license_usage` | Seats used per customer, broken down by subscription and product type |

## Credentials

The public/secret key pair comes from Partner Portal → Admin → Integrations →
API Keys.

### Local (env mode)

```sh
export DATTO_SAAS_PUBLIC_KEY="..."
export DATTO_SAAS_SECRET_KEY="..."
# DATTO_SAAS_API_URL is an optional origin override for proxies only.
```

### Hosted (gateway mode)

The WYRE MCP Gateway injects credentials per request via headers:

- `X-Datto-SaaS-Public-Key` (required, secret)
- `X-Datto-SaaS-Secret-Key` (required, secret)

## Run

```sh
npm install
npm run build
npm start                       # stdio
MCP_TRANSPORT=http npm start    # HTTP on :8080
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
