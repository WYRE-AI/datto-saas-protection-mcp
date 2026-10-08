/**
 * Seat-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * datto_saas_get_seat results get a normalized `_card` object attached (see
 * mcp-server.ts) that the ui:// seat card renders from. The card is
 * progressive enhancement: normalization is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 */

import type { SaasProtectionSeat } from "@wyre-ai/node-datto-saas-protection";

export const SEAT_CARD_RESOURCE_URI = "ui://datto-saas/seat-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const SEAT_CARD_META = {
  "ui/resourceUri": SEAT_CARD_RESOURCE_URI,
  ui: { resourceUri: SEAT_CARD_RESOURCE_URI },
} as const;

/** Mirror of SeatCard in ui/seat-card.ts — keep in sync. */
export interface SeatCard {
  seatId: string;
  /** Display name, falling back to email, falling back to the seat ID. */
  title: string;
  email?: string;
  /** Label-resolved seat type, e.g. "Mailbox" or "Google Workspace user". */
  seatType?: string;
  /** Datto seatState: Active / Paused / Archived / Unprotected. */
  status: string;
  /** Human wording of the seat's protection state. */
  backupStatus: string;
  /** ISO 8601 timestamp of the most recent backup, when known. */
  lastBackupAt?: string;
}

/** Brand overrides injected into the card as `window.__BRAND__`. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The comment marker in ui/index.html that serve-time injection replaces. */
const BRAND_INJECT_MARKER = /<!-- BRAND_INJECT:[\s\S]*?-->/;

/**
 * Replace the card's BRAND_INJECT comment with a `window.__BRAND__` script.
 * The card ships neutral; this is the customization mechanism. An empty
 * brand returns the HTML unchanged. `<` is escaped so brand values can
 * never break out of the injected script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  const entries = Object.entries(brand).filter(
    ([, value]) => typeof value === "string" && value !== ""
  );
  if (entries.length === 0) return html;
  const json = JSON.stringify(Object.fromEntries(entries)).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_MARKER, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Returns
 * an empty brand (HTML served unchanged) when none are set, or on runtimes
 * without `process.env`.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Human-readable labels for Datto's (case-sensitive) seatType values. */
const SEAT_TYPE_LABELS: Record<string, string> = {
  User: "User",
  SharedMailbox: "Shared mailbox",
  SharedDrive: "Shared drive",
  Site: "SharePoint site",
  TeamSite: "Team site",
  Team: "Team",
};

/** Backup-status wording per Datto seatState. */
const SEAT_STATE_BACKUP: Record<string, string> = {
  active: "Protected (backups enabled)",
  paused: "Paused (no new backups)",
  archived: "Archived (backups retained)",
  unprotected: "Not protected",
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Normalize a Datto seat (GET /v1/saas/{id}/seats row) into the flat,
 * label-resolved payload the ui:// seat card renders from. The seat is keyed
 * by remoteId (falling back to mainId); seat types resolve via
 * SEAT_TYPE_LABELS (unknown types pass through); status is Datto's seatState.
 * Datto's seat rows carry no last-backup timestamp, so lastBackupAt is only
 * set when a payload happens to include one.
 */
export function buildSeatCard(
  seat: Partial<SaasProtectionSeat> | null | undefined
): SeatCard | null {
  if (!seat || typeof seat !== "object") return null;
  const mainId = nonEmpty(seat.mainId);
  const seatId = nonEmpty(seat.remoteId) ?? mainId;
  if (!seatId) return null;

  const name = nonEmpty(seat.name);
  const email = mainId && mainId.includes("@") ? mainId : undefined;
  const state = nonEmpty(seat.seatState);

  let lastBackupAt: string | undefined;
  const rawLast = nonEmpty((seat as Record<string, unknown>).lastBackupAt);
  if (rawLast) {
    const parsed = new Date(rawLast);
    if (!Number.isNaN(parsed.getTime())) lastBackupAt = parsed.toISOString();
  }

  const card: SeatCard = {
    seatId,
    title: name ?? mainId ?? seatId,
    status: state ?? "Unknown",
    backupStatus: (state && SEAT_STATE_BACKUP[state.toLowerCase()]) ?? "Unknown",
  };

  if (email) card.email = email;
  const type = nonEmpty(seat.seatType);
  if (type) card.seatType = SEAT_TYPE_LABELS[type] ?? type;
  if (lastBackupAt) card.lastBackupAt = lastBackupAt;

  return card;
}
