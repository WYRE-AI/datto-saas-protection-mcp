/**
 * Datto SaaS Protection REST API client.
 *
 * Datto's SaaS Protection surface is a small, flat, read-only set of routes on
 * a single host. Every path below comes from Datto's published REST API
 * contract and was confirmed live against `api.datto.com` (an unauthenticated
 * probe returns 401 for a route that exists and 404 for one that does not):
 *
 *   GET /v1/saas/domains                        -> SaasDomain[]
 *   GET /v1/saas/{saasCustomerId}/seats         -> SaasSeat[]
 *   GET /v1/saas/{saasCustomerId}/applications  -> SaasBackupReport[]
 *   GET /v1/report/activity-log                 -> ActivityLogPage
 *
 * This module deliberately does NOT use the resource layer of
 * `@wyre-technology/node-datto-saas-protection`. That SDK's base URL and Basic
 * auth are right, but its per-resource paths (`/clients`,
 * `/clients/{id}/domains`, `/seats/{id}`, `/seats/{id}/backups`,
 * `/restores/{id}`, `/clients/{id}/activity`, `/clients/{id}/usage`) were
 * written against a speculative spec — its own CHANGELOG says so — and all of
 * them 404. The SDK's error taxonomy is correct and publicly exported, so it is
 * reused here and remains the error contract for callers.
 *
 * Read-only by construction: there is no method on this client that can issue
 * anything but a GET, so the one write route the API does have
 * (`PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange`)
 * cannot be reached through it even by accident.
 */

import {
  DattoSaasProtectionAuthenticationError,
  DattoSaasProtectionError,
  DattoSaasProtectionForbiddenError,
  DattoSaasProtectionNotFoundError,
  DattoSaasProtectionRateLimitError,
  DattoSaasProtectionServerError,
} from "@wyre-technology/node-datto-saas-protection";

// ---------------------------------------------------------------------------
// Contract constants — the single source of truth for host and paths
// ---------------------------------------------------------------------------

/**
 * The one and only Datto REST API origin.
 *
 * There is no regional split. `api.eu.datto.com` — which the SDK offers as its
 * `eu` region — does not resolve (NXDOMAIN), and Datto's OpenAPI contract
 * declares a single server. Multi-region partners are scoped by API key, not by
 * hostname.
 */
export const DATTO_API_BASE_URL = "https://api.datto.com";

/** All protected domains visible to the key, across every SaaS customer. */
export const DOMAINS_PATH = "/v1/saas/domains";

/** Partner-portal activity log (Reporting surface, shares host and auth). */
export const ACTIVITY_LOG_PATH = "/v1/report/activity-log";

/** Seats for one SaaS Protection customer. */
export function seatsPath(saasCustomerId: string | number): string {
  return `/v1/saas/${encodeURIComponent(String(saasCustomerId))}/seats`;
}

/** Backup report for one SaaS Protection customer. */
export function backupReportPath(saasCustomerId: string | number): string {
  return `/v1/saas/${encodeURIComponent(String(saasCustomerId))}/applications`;
}

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Response types — field names and types taken from Datto's schema
// ---------------------------------------------------------------------------

/** Seat types Datto accepts as a `seatType` filter and returns on a seat. */
export const SEAT_TYPES = [
  "User",
  "Site",
  "TeamSite",
  "SharedMailbox",
  "Team",
  "SharedDrive",
] as const;

export type SeatType = (typeof SEAT_TYPES)[number];

export interface BackupStats {
  activeServicesCount?: number;
  activeServicesWithRecentBackupCount?: number;
  backupPercentage?: number;
}

export interface SaasDomain {
  domain?: string;
  /** Integer in the live API — never quote it or compare it with `===` to a string. */
  saasCustomerId?: number;
  saasCustomerName?: string;
  organizationId?: number | null;
  organizationName?: string | null;
  seatsUsed?: number;
  productType?: string;
  externalSubscriptionId?: string;
  retentionType?: string;
  backupStats?: BackupStats;
}

export interface SaasSeat {
  /** The protected entity, e.g. an email address. Datto's per-seat identifier. */
  mainId?: string;
  name?: string;
  seatType?: string;
  seatState?: string;
  /** `"1"` / `"0"` — a string in the live API, not a boolean. */
  billable?: string;
  dateAdded?: string;
  /** Microsoft/Google object id. */
  remoteId?: string;
}

export interface Pagination {
  page?: number;
  perPage?: number;
  totalPages?: number;
  count?: number;
}

export interface BackupReportItem {
  customerId?: number;
  customerName?: string;
  usedBytes?: number;
  suites?: unknown[];
}

export interface SaasBackupReport {
  pagination?: Pagination;
  items?: BackupReportItem[];
}

export interface ActivityLogEntry {
  timestamp?: string;
  requestId?: string;
  targetType?: string;
  targetId?: string;
  targetDisplayName?: string;
  clientName?: string | null;
  interface?: string;
  user?: string;
  userRoles?: string[];
  ipAddress?: string;
  action?: string;
  messageEN?: string;
  success?: boolean;
}

export interface ActivityLogPage {
  pagination?: Pagination;
  items?: ActivityLogEntry[];
}

export interface ActivityLogParams {
  clientName?: string;
  user?: string;
  targetType?: string;
  /** Comma-separated `targetType:targetId` tuples, e.g. `bcdr-device:ABC123`. */
  target?: string;
  /** Look back this many `sinceUnits` from now. */
  since?: number;
  sinceUnits?: "days" | "hours" | "minutes";
  page?: number;
  perPage?: number;
}

export interface DattoSaasApiOptions {
  publicKey: string;
  secretKey: string;
  /** Override the API origin. Defaults to {@link DATTO_API_BASE_URL}. */
  baseUrl?: string;
  timeoutMs?: number;
}

type QueryValue = string | number | boolean | undefined;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DattoSaasApi {
  private readonly authHeader: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DattoSaasApiOptions) {
    if (!options.publicKey) throw new Error("publicKey must be provided");
    if (!options.secretKey) throw new Error("secretKey must be provided");

    // Basic auth: public key as username, secret key as password.
    const encoded = Buffer.from(
      `${options.publicKey}:${options.secretKey}`,
      "utf8"
    ).toString("base64");
    this.authHeader = `Basic ${encoded}`;
    this.baseUrl = (options.baseUrl || DATTO_API_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `GET /v1/saas/domains` — every protected domain the key can see. */
  async listDomains(): Promise<SaasDomain[]> {
    return this.getArray<SaasDomain>(DOMAINS_PATH);
  }

  /** `GET /v1/saas/{saasCustomerId}/seats` */
  async listSeats(
    saasCustomerId: string | number,
    params: { seatType?: string[] } = {}
  ): Promise<SaasSeat[]> {
    // Datto serialises seatType as one comma-separated value (form/no-explode).
    const seatType = params.seatType?.length ? params.seatType.join(",") : undefined;
    return this.getArray<SaasSeat>(seatsPath(saasCustomerId), { seatType });
  }

  /**
   * `GET /v1/saas/{saasCustomerId}/applications` — backup/usage report.
   *
   * Datto's contract declares this as an *array of* `{pagination, items}`
   * envelopes, which is almost certainly a spec-authoring artifact — a single
   * envelope is what a report endpoint would naturally return. It is the one
   * part of this contract that could not be confirmed against a live response,
   * so both shapes are accepted: a bare envelope is wrapped into a one-element
   * array rather than silently discarded.
   */
  async getBackupReport(
    saasCustomerId: string | number,
    params: { daysUntil?: number } = {}
  ): Promise<SaasBackupReport[]> {
    const body = await this.get<SaasBackupReport | SaasBackupReport[]>(
      backupReportPath(saasCustomerId),
      { daysUntil: params.daysUntil }
    );
    if (Array.isArray(body)) return body;
    return body && typeof body === "object" ? [body] : [];
  }

  /** `GET /v1/report/activity-log` */
  async listActivity(params: ActivityLogParams = {}): Promise<ActivityLogPage> {
    // `_page` / `_perPage` are underscore-prefixed in Datto's contract.
    const page = await this.get<ActivityLogPage>(ACTIVITY_LOG_PATH, {
      clientName: params.clientName,
      user: params.user,
      targetType: params.targetType,
      target: params.target,
      since: params.since,
      sinceUnits: params.sinceUnits,
      _page: params.page,
      _perPage: params.perPage,
    });
    return page ?? {};
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Datto returns bare JSON arrays for the SaaS collection routes (no envelope,
   * no pagination). Anything else is normalised to `[]` so a tool never renders
   * a stray object as if it were a list.
   */
  private async getArray<T>(path: string, query?: Record<string, QueryValue>): Promise<T[]> {
    const body = await this.get<T[]>(path, query);
    return Array.isArray(body) ? body : [];
  }

  private async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", Authorization: this.authHeader },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) throw await toApiError(response, path);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as T;
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new DattoSaasProtectionError(
        `Datto returned a malformed JSON body for GET ${path}`,
        response.status
      );
    }
  }
}

/**
 * Map an HTTP failure onto the SDK's error taxonomy.
 *
 * A 404 from this API means the route or record genuinely does not exist — it
 * is never an auth problem, which is what made the old client's wrong paths so
 * hard to diagnose. The message says so.
 */
async function toApiError(response: Response, path: string): Promise<DattoSaasProtectionError> {
  const body = await readBody(response);

  switch (response.status) {
    case 401:
      return new DattoSaasProtectionAuthenticationError(
        "Authentication failed (401). Check DATTO_SAAS_PUBLIC_KEY / DATTO_SAAS_SECRET_KEY — " +
          "they are the public/secret API key pair from Partner Portal > Admin > Integrations > API Keys.",
        401,
        body
      );
    case 403:
      return new DattoSaasProtectionForbiddenError(
        "Access forbidden (403) — the API key is valid but out of scope for this customer.",
        body
      );
    case 404:
      return new DattoSaasProtectionNotFoundError(
        `Not found (404) for ${path} — the route or customer id does not exist ` +
          "or is not visible to this key. A 404 here is never a credential problem; bad credentials return 401.",
        body
      );
    case 429: {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      return new DattoSaasProtectionRateLimitError(
        "Rate limit exceeded (429). Datto meters a weighted hourly budget per organization — " +
          "read X-API-Limit-Remaining / X-API-Limit-Resets / X-API-Limit-Cost from a live response " +
          "rather than assuming a flat call count.",
        (Number.isNaN(retryAfter) ? 5 : retryAfter) * 1000,
        body
      );
    }
    default:
      if (response.status >= 500) {
        return new DattoSaasProtectionServerError(
          `Datto server error: ${response.status} ${response.statusText}`,
          response.status,
          body
        );
      }
      return new DattoSaasProtectionError(
        `Request failed: ${response.status} ${response.statusText}`,
        response.status,
        body
      );
  }
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      return await response.text();
    } catch {
      return undefined;
    }
  }
}
