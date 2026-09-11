# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (BREAKING)
- **The REST API contract was substantially wrong — wrong path structure, wrong resource model, wrong response schemas.** Only two endpoints ever worked. The client has been rewritten against Datto's published contract and the corrected host, paths and parsed schemas are now pinned by wire-contract tests (`test/datto-api.test.ts`) so this cannot silently regress.

  Reported and corrected by @Curity-IT-Solutions in their fork.

  - **Paths.** The host was already right — `https://api.datto.com`. Everything below it was invented. The previous client called a speculative resource model that does not exist: `/v1/saas/clients`, `/v1/saas/clients/{id}/domains`, `/v1/saas/clients/{id}/domains/{domainId}/seats`, `/v1/saas/seats/{id}`, `/v1/saas/seats/{id}/backups`, `/v1/saas/seats/{id}/restores`, `/v1/saas/restores/{id}`, `/v1/saas/clients/{id}/activity` and `/v1/saas/clients/{id}/usage` all 404. The SDK's own changelog admits it: *"Resource paths ... were written against the same speculative spec as the auth/base-URL bugs. Only `/v1/saas/domains` is confirmed against published docs."* The real surface is four read routes keyed by `saasCustomerId`: `GET /v1/saas/domains`, `GET /v1/saas/{saasCustomerId}/seats`, `GET /v1/saas/{saasCustomerId}/applications` and `GET /v1/report/activity-log`.
  - **Resource model.** Seats are scoped by **customer**, not by domain, and there is no single-seat route — `datto_saas_get_seat` now filters the customer's seat list by `mainId` or `remoteId`. There is no customers endpoint: `datto_saas_list_clients` and `datto_saas_get_license_usage` are now honest reshapings of `GET /v1/saas/domains`, labelled as such in their tool descriptions.
  - **Response schemas.** `saasCustomerId` is an **integer**, not a string — id comparisons are stringified on both sides, which is why the old filters silently returned empty lists. `billable` is the **string** `"1"`/`"0"`, not a boolean. The SaaS collection routes return **bare JSON arrays** with no pagination envelope; only the activity log paginates, and it uses underscore-prefixed `_page`/`_perPage` parameters.
  - **Regions removed.** `DATTO_SAAS_REGION` / `X-Datto-SaaS-Region` are gone. Datto has exactly one API origin; `api.eu.datto.com` does not resolve. A `DATTO_SAAS_API_URL` override remains for proxies and contract tests only. An `X-Datto-SaaS-Region` header, if still sent, is ignored rather than rejected.
  - **Restore and backup-history tools removed.** `datto_saas_queue_restore`, `datto_saas_get_restore_status` and `datto_saas_list_backups` called routes that do not exist. Datto's SaaS Protection REST API has no restore surface and no per-seat backup history. Per-customer backup posture is now served by the new `datto_saas_get_backup_report` tool (`GET /v1/saas/{saasCustomerId}/applications`). The tool count goes from 9 to 7.
  - **Activity log `target` filter added.** Datto documents a `target` parameter taking comma-separated `targetType:targetId` tuples (e.g. `bcdr-device:ABC123`); the client never sent it.
  - **Backup report accepts either response shape.** Datto's contract declares `GET /v1/saas/{saasCustomerId}/applications` as an *array of* `{pagination, items}` envelopes, which looks like a spec-authoring artifact and is the one detail that could not be confirmed against a live response. A bare envelope is now wrapped into a one-element array rather than silently discarded by the array normalizer.
  - **Rate-limit guidance corrected.** The 429 message no longer asserts a flat "10,000 calls per hour" — Datto meters a *weighted* budget (`X-API-Limit-Cost` deducts a per-request amount), so the message points at the live `X-API-Limit-Remaining` / `X-API-Limit-Resets` headers instead.
  - **Read-only by construction.** The new client (`src/datto-api.ts`) exposes no method capable of issuing anything but a `GET`, so the one write route on the SaaS surface (`PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange`) cannot be reached through it even by accident. A test asserts the absence of any write method.
  - **Error taxonomy.** A `404` is now reported as a genuinely missing route or record and explicitly *not* a credential problem — the ambiguity between "wrong path" and "bad key" is what made the original breakage so hard to diagnose. The `@wyre-technology/node-datto-saas-protection` error classes remain the public error contract; only the SDK's resource layer (whose paths were speculative, as its own changelog admits) is no longer used.
  - README, `manifest.json`, `server.json` and `smithery.yaml` corrected: they advertised the removed restore tools, the nonexistent region setting, and a single `DATTO_SAAS_API_KEY` variable that the server has not read since the Basic-auth fix.

### Added
- **Interactive seat card via MCP Apps (SEP-1865).** `datto_saas_get_seat` results render as an interactive backup-status card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows the seat's name, email, label-resolved seat type (User / Shared mailbox / SharePoint site / Team site / Team / Shared drive), Datto's `seatState`, billable status and protection start date. The card is read-only, and every field on it exists on Datto's real seat schema — an earlier draft rendered a per-seat backup timestamp the API does not return. Non-App hosts are unaffected: the tool's JSON payload is the raw seat plus a new `_card` field.
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
