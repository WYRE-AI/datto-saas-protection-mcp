# Datto SaaS Protection MCP Server

[![CI](https://github.com/WYRE-AI/datto-saas-protection-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/WYRE-AI/datto-saas-protection-mcp/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A [Model Context Protocol](https://modelcontextprotocol.io) server exposing the
[Datto SaaS Protection (Backupify)](https://www.datto.com/products/saas-protection/)
API to Claude and other MCP clients.

## What it does

Surface SaaS backup posture for your M365 and Google Workspace tenants directly
to AI assistants — list customer organizations, inspect protected domains and
seats, browse backup history, queue restores, and audit activity logs and
license usage.

- **Interactive Seat Card (MCP Apps)**: `datto_saas_get_seat` renders as an interactive backup-status card in MCP Apps hosts (Claude Desktop/web) — read-only, showing seat type, Active/Archived status, and last backup; neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars; plain-JSON behavior is unchanged in other hosts

## Tools

| Tool | Purpose |
| --- | --- |
| `datto_saas_list_clients` | List all customer organizations |
| `datto_saas_list_domains` | List protected domains under a client |
| `datto_saas_list_seats` | List seats in a domain (toggle archived) |
| `datto_saas_get_seat` | Fetch a single seat detail |
| `datto_saas_list_backups` | List backup runs for a seat |
| `datto_saas_queue_restore` | Queue a restore (DESTRUCTIVE — requires confirmation) |
| `datto_saas_get_restore_status` | Check restore progress |
| `datto_saas_list_activity` | Org activity log (date-range elicitation) |
| `datto_saas_get_license_usage` | Seat counts vs purchased |

## Credentials

### Local (env mode)

```sh
export DATTO_SAAS_PUBLIC_KEY="..."
export DATTO_SAAS_SECRET_KEY="..."
export DATTO_SAAS_REGION="us"   # or "eu"
```

### Hosted (gateway mode)

The WYRE MCP Gateway injects credentials per request via headers:

- `X-Datto-SaaS-Public-Key` (required, secret)
- `X-Datto-SaaS-Secret-Key` (required, secret)
- `X-Datto-SaaS-Region` (optional, default `us`)

## Run

```sh
npm install
npm run build
npm start                       # stdio
MCP_TRANSPORT=http npm start    # HTTP on :8080
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
