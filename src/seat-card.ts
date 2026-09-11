/**
 * Seat-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * datto_saas_get_seat results get a normalized `_card` object attached (see
 * mcp-server.ts) that the ui:// seat card renders from. The card is
 * progressive enhancement: normalization is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 */

import type { SaasSeat } from "./datto-api.js";

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
  /** Datto's `mainId` — the protected entity, usually an email address. */
  seatId: string;
  /** Display name, falling back to the seat id. */
  title: string;
  /** `mainId` when it is an address rather than an opaque id. */
  email?: string;
  /** Label-resolved seat type, e.g. "Mailbox" or "SharePoint site". */
  seatType?: string;
  /** Datto's `seatState`, e.g. "Active". */
  status: string;
  /** "Billable" / "Not billable", from Datto's string `billable` flag. */
  billing?: string;
  /** ISO 8601 form of `dateAdded` — when the seat entered protection. */
  protectedSince?: string;

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

/** Human-readable labels for Datto's `seatType` values. */
const SEAT_TYPE_LABELS: Record<string, string> = {
  User: "User",
  SharedMailbox: "Shared mailbox",
  Site: "SharePoint site",
  TeamSite: "Team site",
  Team: "Team",
  SharedDrive: "Shared drive",
};

/** `mainId` is an address for user/mailbox seats and an opaque id otherwise. */
function asEmail(mainId: string): string | undefined {
  return mainId.includes("@") ? mainId : undefined;
}

/**
 * Normalize a Datto seat into the flat, label-resolved payload the ui:// seat
 * card renders from.
 *
 * Every field here exists on Datto's real seat schema (`mainId`, `name`,
 * `seatType`, `seatState`, `billable`, `dateAdded`, `remoteId`). The card
 * deliberately shows no backup timestamp: the seats endpoint does not return
 * one, and the previous card invented `lastBackupAt` from a speculative
 * schema. Per-customer backup posture comes from
 * `datto_saas_get_backup_report` instead.
 */
export function buildSeatCard(
  seat: Partial<SaasSeat> | null | undefined
): SeatCard | null {
  if (!seat || typeof seat.mainId !== "string" || seat.mainId === "") {
    return null;
  }

  const card: SeatCard = {
    seatId: seat.mainId,
    title: seat.name || seat.mainId,
    status: seat.seatState || "Unknown",
  };

  const email = asEmail(seat.mainId);
  if (email) card.email = email;

  if (typeof seat.seatType === "string" && seat.seatType) {
    card.seatType = SEAT_TYPE_LABELS[seat.seatType] ?? seat.seatType;
  }

  // Datto sends `billable` as the string "1" / "0".
  if (seat.billable === "1") card.billing = "Billable";
  else if (seat.billable === "0") card.billing = "Not billable";

  if (typeof seat.dateAdded === "string" && seat.dateAdded) {
    const parsed = new Date(seat.dateAdded);
    if (!Number.isNaN(parsed.getTime())) card.protectedSince = parsed.toISOString();
  }

  return card;
}
