/**
 * Views derived from the two SaaS Protection collection endpoints.
 *
 * Datto exposes no `/clients`, `/seats/{id}` or license endpoint, so the tools
 * that used to call those speculative routes are served instead by reshaping
 * what `GET /v1/saas/domains` and `GET /v1/saas/{saasCustomerId}/seats` really
 * return. Keeping the reshaping here (rather than inline in the tool handlers)
 * keeps it directly unit-testable.
 */

import type { SaasDomain, SaasSeat } from "./datto-api.js";

export interface SaasCustomer {
  saasCustomerId: number | string;
  saasCustomerName?: string;
  organizationId?: number | null;
  organizationName?: string | null;
  domains: string[];
  seatsUsed: number;
}

export interface SaasSubscription {
  domain?: string;
  productType?: string;
  retentionType?: string;
  externalSubscriptionId?: string;
  seatsUsed: number;
  backupStats?: SaasDomain["backupStats"];
}

export interface SaasLicenseUsage {
  saasCustomerId: number | string;
  saasCustomerName?: string;
  totalSeatsUsed: number;
  subscriptions: SaasSubscription[];
}

/**
 * Does this domain row belong to the requested customer?
 *
 * `saasCustomerId` is an **integer** in the live API. Comparing it to a tool
 * argument (always a JSON string or number) with `===` silently matches
 * nothing, which is exactly how the old client's filters appeared to "work"
 * while returning empty lists. Both sides are stringified.
 */
export function matchesCustomer(domain: SaasDomain, saasCustomerId: string | number): boolean {
  return domain.saasCustomerId != null && String(domain.saasCustomerId) === String(saasCustomerId);
}

/**
 * Unique customers across every protected domain — the honest replacement for
 * the non-existent `/clients` endpoint.
 */
export function deriveCustomers(domains: SaasDomain[]): SaasCustomer[] {
  const byId = new Map<string, SaasCustomer>();

  for (const domain of domains) {
    if (domain.saasCustomerId == null) continue;
    const key = String(domain.saasCustomerId);
    let customer = byId.get(key);
    if (!customer) {
      customer = {
        saasCustomerId: domain.saasCustomerId,
        saasCustomerName: domain.saasCustomerName,
        organizationId: domain.organizationId,
        organizationName: domain.organizationName,
        domains: [],
        seatsUsed: 0,
      };
      byId.set(key, customer);
    }
    if (domain.domain && !customer.domains.includes(domain.domain)) {
      customer.domains.push(domain.domain);
    }
    customer.seatsUsed += domain.seatsUsed ?? 0;
  }

  return [...byId.values()];
}

/**
 * Licensed seat counts per customer, from the subscription fields every domain
 * row already carries. Datto reports seats *used*; it does not publish a
 * purchased/entitled count anywhere in this API, so neither does this view.
 */
export function deriveLicenseUsage(domains: SaasDomain[]): SaasLicenseUsage[] {
  const byId = new Map<string, SaasLicenseUsage>();

  for (const domain of domains) {
    if (domain.saasCustomerId == null) continue;
    const key = String(domain.saasCustomerId);
    let usage = byId.get(key);
    if (!usage) {
      usage = {
        saasCustomerId: domain.saasCustomerId,
        saasCustomerName: domain.saasCustomerName,
        totalSeatsUsed: 0,
        subscriptions: [],
      };
      byId.set(key, usage);
    }
    const seatsUsed = domain.seatsUsed ?? 0;
    usage.totalSeatsUsed += seatsUsed;
    usage.subscriptions.push({
      domain: domain.domain,
      productType: domain.productType,
      retentionType: domain.retentionType,
      externalSubscriptionId: domain.externalSubscriptionId,
      seatsUsed,
      backupStats: domain.backupStats,
    });
  }

  return [...byId.values()];
}

/**
 * Find one seat in a customer's seat list. There is no single-seat route, so a
 * lookup is a filter over the list. `mainId` is usually an email address, so it
 * is matched case-insensitively; `remoteId` is an opaque Microsoft/Google id.
 */
export function findSeat(seats: SaasSeat[], seatId: string): SaasSeat | undefined {
  const needle = seatId.trim().toLowerCase();
  return seats.find(
    (seat) =>
      seat.mainId?.toLowerCase() === needle || seat.remoteId?.toLowerCase() === needle
  );
}
