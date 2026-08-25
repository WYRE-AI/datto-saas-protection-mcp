/**
 * Seat-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * datto_saas_get_seat results get a normalized `_card` object attached (see
 * mcp-server.ts) that the ui:// seat card renders from. The card is
 * progressive enhancement: normalization is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 */

import type { SaasProtectionSeat } from "@wyre-technology/node-datto-saas-protection";

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
  /** "Active" or "Archived" (retained-but-deleted). */
  status: string;
  /** "Backed up" when a last-backup timestamp exists, else "No backups recorded". */
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

/** Human-readable labels for the SDK's SeatType values. */
const SEAT_TYPE_LABELS: Record<string, string> = {
  mailbox: "Mailbox",
  onedrive: "OneDrive",
  sharepoint: "SharePoint site",
  google_user: "Google Workspace user",
};

/**
 * Normalize an SDK seat into the flat, label-resolved payload the ui:// seat
 * card renders from. Seat types are resolved via SEAT_TYPE_LABELS (unknown
 * types pass through as-is), archived seats are labelled "Archived", and the
 * backup status is derived from the presence of a last-backup timestamp.
 */
export function buildSeatCard(
  seat: Partial<SaasProtectionSeat> | null | undefined
): SeatCard | null {
  if (!seat || typeof seat.id !== "string" || seat.id === "") {
    return null;
  }

  const email = typeof seat.email === "string" && seat.email ? seat.email : undefined;
  const displayName =
    typeof seat.displayName === "string" && seat.displayName ? seat.displayName : undefined;

  let lastBackupAt: string | undefined;
  if (typeof seat.lastBackupAt === "string" && seat.lastBackupAt) {
    const parsed = new Date(seat.lastBackupAt);
    if (!Number.isNaN(parsed.getTime())) lastBackupAt = parsed.toISOString();
  }

  const card: SeatCard = {
    seatId: seat.id,
    title: displayName ?? email ?? seat.id,
    status: seat.archived === true ? "Archived" : "Active",
    backupStatus: lastBackupAt ? "Backed up" : "No backups recorded",
  };

  if (email) card.email = email;
  if (typeof seat.type === "string" && seat.type) {
    card.seatType = SEAT_TYPE_LABELS[seat.type] ?? seat.type;
  }
  if (lastBackupAt) card.lastBackupAt = lastBackupAt;

  return card;
}
