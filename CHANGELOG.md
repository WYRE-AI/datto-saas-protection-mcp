# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- HTTP transport fails closed on `CONDUIT_S2S_SECRET`. An empty or known-placeholder secret refuses startup by throwing, so a direct caller of `startHttpTransport()` can handle it; the CLI exits from that rejection. `MCP_ALLOW_INSECURE_DEV=1` is the only empty-secret bypass: it skips `X-Gateway-S2S` and binds `127.0.0.1` only. With a real secret, `/mcp` requires a valid `X-Gateway-S2S` header. Gateway mode requires `X-Datto-SaaS-Public-Key` and `X-Datto-SaaS-Secret-Key` on the request and does not fall back to `DATTO_SAAS_*`.

### Changed
- Docker image defaults to `AUTH_MODE=gateway`. Compose publishes HTTP on `127.0.0.1:8080` and requires `CONDUIT_S2S_SECRET`.

### Added
- **Interactive seat card via MCP Apps (SEP-1865).** `datto_saas_get_seat` results render as an interactive backup-status card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows the seat's display name, email, label-resolved seat type (Mailbox / OneDrive / SharePoint site / Google Workspace user), Active/Archived status, derived backup status, and last-backup timestamp. The card is read-only — restores stay behind the elicitation-gated `datto_saas_queue_restore` tool. Non-App hosts are unaffected: the tool's JSON payload is the raw seat plus a new `_card` field.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://datto-saas/seat-card.html` resource served as `text/html;profile=mcp-app`. The server now declares the `resources` capability and answers `resources/list` / `resources/read` for the card.
  - The card is **neutral by default** and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` environment variables (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`), applied at serve time by replacing the card's `BRAND_INJECT` marker. No branding configured = the HTML is served unchanged and the card renders with no brand identity.
  - The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/seat-card-html.ts`, committed), so it serves identically from stdio and Node HTTP without filesystem access.
  - The card payload builder is best-effort: a sparse or unrecognized seat degrades the card (or drops it) without affecting the tool result. New contract tests in `test/mcp-apps.test.ts` drive the real server factory over an in-memory transport to pin the `_meta` advertisement, the `ui://` resource wire shape, and the `_card` normalization.
  - New `npm run build:ui` regenerates the embedded HTML after editing `ui/` (requires the new `vite`, `vite-plugin-singlefile`, and `@modelcontextprotocol/ext-apps` devDependencies); plain `npm run build` and CI are unaffected.
  - The server factory moved from `src/index.ts` into a side-effect-free `src/mcp-server.ts` so tests can drive it directly; `src/index.ts` keeps the stdio/HTTP transport wiring unchanged.

### Changed (BREAKING)
- Credentials: `DATTO_SAAS_API_KEY` (single value) → `DATTO_SAAS_PUBLIC_KEY` + `DATTO_SAAS_SECRET_KEY` (pair). Gateway headers renamed correspondingly: `X-Datto-SaaS-API-Key` → `X-Datto-SaaS-Public-Key` + `X-Datto-SaaS-Secret-Key`. The original scaffold modeled the API as Bearer-auth single-key, but Datto SaaS Protection's REST API actually uses HTTP Basic auth with a public/secret pair issued from the partner portal.

### Added
- Initial scaffold of the Datto SaaS Protection (Backupify) MCP server.
- Stdio + HTTP (StreamableHTTP) transports.
- Gateway-mode credential handling via `X-Datto-SaaS-Public-Key` / `X-Datto-SaaS-Secret-Key` / `X-Datto-SaaS-Region` headers.
- 9 tools covering clients, domains, seats, backups, restores, activity, and license usage.
- Destructive-action confirmation elicitation for `datto_saas_queue_restore`.
- Multi-stage `Dockerfile` with GitHub Packages auth via build secret.
- Semantic-release based CI release pipeline (`.github/workflows/release.yml`).
- MCPB packaging script and Smithery registry config.
