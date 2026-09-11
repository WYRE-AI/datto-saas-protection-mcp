/**
 * Wire-contract tests for the Datto SaaS Protection REST API client.
 *
 * These pin the exact host and paths Datto actually serves. Every URL asserted
 * here was confirmed live against api.datto.com: a route that exists answers an
 * unauthenticated GET with 401, a route that does not answers 404. The routes
 * the previous client used — /v1/saas/clients, /api/v1/clients — answer 404.
 *
 * Response fixtures use Datto's documented field names and types, including
 * `saasCustomerId` as an integer and `billable` as a string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_LOG_PATH,
  DATTO_API_BASE_URL,
  DOMAINS_PATH,
  DattoSaasApi,
  SEAT_TYPES,
  backupReportPath,
  seatsPath,
  type SaasDomain,
  type SaasSeat,
} from '../src/datto-api.js';
import {
  DattoSaasProtectionAuthenticationError,
  DattoSaasProtectionError,
  DattoSaasProtectionForbiddenError,
  DattoSaasProtectionNotFoundError,
  DattoSaasProtectionRateLimitError,
  DattoSaasProtectionServerError,
} from '@wyre-technology/node-datto-saas-protection';

const fetchMock = vi.fn();

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ code: 'error', message: 'nope' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The single URL the client requested. */
function requestedUrl(): string {
  return fetchMock.mock.calls[0][0] as string;
}

function requestInit(): RequestInit {
  return fetchMock.mock.calls[0][1] as RequestInit;
}

/** Verbatim shapes from Datto's SaaS Protection schema. */
const DOMAIN_FIXTURE: SaasDomain = {
  backupStats: {
    activeServicesCount: 89,
    activeServicesWithRecentBackupCount: 71,
    backupPercentage: 79.78,
  },
  domain: 'integrityhealth.onmicrosoft.com',
  saasCustomerId: 53124,
  saasCustomerName: 'Integrity Health',
  organizationId: 12345,
  organizationName: 'Integrity Health Group',
  seatsUsed: 15,
  productType: 'Office365',
  externalSubscriptionId: 'Classic:Office365:123456',
  retentionType: 'ICR',
};

const SEAT_FIXTURE: SaasSeat = {
  mainId: 'johnnyrose@backupifydevman6.onmicrosoft.com',
  name: 'Johnny Rose',
  seatType: 'User',
  seatState: 'Active',
  billable: '1',
  dateAdded: '2022-04-26T16:43:05+00:00',
  remoteId: '12345221-d561-11ee-9645-abcdef123456',
};

function api(overrides: Partial<ConstructorParameters<typeof DattoSaasApi>[0]> = {}) {
  return new DattoSaasApi({ publicKey: 'pub', secretKey: 'sec', ...overrides });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API contract constants', () => {
  it('pins the one real Datto API host', () => {
    expect(DATTO_API_BASE_URL).toBe('https://api.datto.com');
  });

  it('pins the documented SaaS Protection paths', () => {
    expect(DOMAINS_PATH).toBe('/v1/saas/domains');
    expect(seatsPath(53124)).toBe('/v1/saas/53124/seats');
    expect(backupReportPath(53124)).toBe('/v1/saas/53124/applications');
    expect(ACTIVITY_LOG_PATH).toBe('/v1/report/activity-log');
  });

  it('never uses the 404 routes the previous client called', () => {
    const paths = [DOMAINS_PATH, seatsPath(1), backupReportPath(1), ACTIVITY_LOG_PATH];
    for (const path of paths) {
      expect(path).not.toContain('/api/v1/');
      expect(path).not.toContain('/clients');
      expect(path).not.toContain('/restores');
    }
  });

  it('pins the documented seatType vocabulary', () => {
    expect([...SEAT_TYPES]).toEqual([
      'User',
      'Site',
      'TeamSite',
      'SharedMailbox',
      'Team',
      'SharedDrive',
    ]);
  });

  it('url-encodes the customer id', () => {
    expect(seatsPath('a b/../c')).toBe('/v1/saas/a%20b%2F..%2Fc/seats');
  });
});

describe('authentication', () => {
  it('sends HTTP Basic auth built from the public/secret key pair', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().listDomains();
    const headers = requestInit().headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('pub:sec').toString('base64')}`);
    expect(headers.Accept).toBe('application/json');
  });

  it('never sends a bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().listDomains();
    const headers = requestInit().headers as Record<string, string>;
    expect(headers.Authorization).not.toMatch(/^Bearer/);
  });

  it('requires both keys', () => {
    expect(() => api({ publicKey: '' })).toThrow(/publicKey/);
    expect(() => api({ secretKey: '' })).toThrow(/secretKey/);
  });
});

describe('GET /v1/saas/domains', () => {
  it('requests the documented URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse([DOMAIN_FIXTURE]));
    await api().listDomains();
    expect(requestedUrl()).toBe('https://api.datto.com/v1/saas/domains');
    expect(requestInit().method).toBe('GET');
  });

  it('parses the documented schema, keeping saasCustomerId numeric', async () => {
    fetchMock.mockResolvedValue(jsonResponse([DOMAIN_FIXTURE]));
    const [domain] = await api().listDomains();
    expect(domain.saasCustomerId).toBe(53124);
    expect(typeof domain.saasCustomerId).toBe('number');
    expect(domain.saasCustomerName).toBe('Integrity Health');
    expect(domain.externalSubscriptionId).toBe('Classic:Office365:123456');
    expect(domain.backupStats?.backupPercentage).toBeCloseTo(79.78);
  });

  it('returns a bare array, not a paginated envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse([DOMAIN_FIXTURE, DOMAIN_FIXTURE]));
    await expect(api().listDomains()).resolves.toHaveLength(2);
  });

  it('normalises a non-array body to an empty list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [DOMAIN_FIXTURE] }));
    await expect(api().listDomains()).resolves.toEqual([]);
  });
});

describe('GET /v1/saas/{saasCustomerId}/seats', () => {
  it('is customer-scoped, not domain-scoped', async () => {
    fetchMock.mockResolvedValue(jsonResponse([SEAT_FIXTURE]));
    await api().listSeats(53124);
    expect(requestedUrl()).toBe('https://api.datto.com/v1/saas/53124/seats');
  });

  it('accepts a numeric id sent as a string', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().listSeats('53124');
    expect(requestedUrl()).toBe('https://api.datto.com/v1/saas/53124/seats');
  });

  it('serialises seatType as one comma-separated parameter', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().listSeats(53124, { seatType: ['User', 'SharedMailbox'] });
    expect(requestedUrl()).toBe(
      'https://api.datto.com/v1/saas/53124/seats?seatType=User%2CSharedMailbox'
    );
  });

  it('omits seatType when no filter is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().listSeats(53124, { seatType: [] });
    expect(requestedUrl()).not.toContain('seatType');
  });

  it('parses the documented seat schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse([SEAT_FIXTURE]));
    const [seat] = await api().listSeats(53124);
    expect(seat.mainId).toBe('johnnyrose@backupifydevman6.onmicrosoft.com');
    expect(seat.seatState).toBe('Active');
    // `billable` is a string in the live API, not a boolean.
    expect(seat.billable).toBe('1');
    expect(typeof seat.billable).toBe('string');
    expect(seat.remoteId).toBe('12345221-d561-11ee-9645-abcdef123456');
  });
});

describe('GET /v1/saas/{saasCustomerId}/applications', () => {
  it('requests the backup report URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().getBackupReport(53124);
    expect(requestedUrl()).toBe('https://api.datto.com/v1/saas/53124/applications');
  });

  it('passes daysUntil through', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api().getBackupReport(53124, { daysUntil: 7 });
    expect(requestedUrl()).toBe(
      'https://api.datto.com/v1/saas/53124/applications?daysUntil=7'
    );
  });

  it('accepts a bare envelope as well as an array of them', async () => {
    // Datto's contract declares an array; a live response was never captured to
    // confirm it. A single envelope must not be silently dropped.
    fetchMock.mockResolvedValue(
      jsonResponse({ pagination: { count: 1 }, items: [{ customerId: 53124 }] })
    );
    const reports = await api().getBackupReport(53124);
    expect(reports).toHaveLength(1);
    expect(reports[0].items?.[0].customerId).toBe(53124);
  });

  it('parses the report envelope', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          pagination: { page: 1, perPage: 25, totalPages: 1, count: 1 },
          items: [{ customerId: 53124, customerName: 'Integrity Health', usedBytes: 5555555555 }],
        },
      ])
    );
    const [report] = await api().getBackupReport(53124);
    expect(report.pagination?.count).toBe(1);
    expect(report.items?.[0].usedBytes).toBe(5555555555);
  });
});

describe('GET /v1/report/activity-log', () => {
  it('uses Datto underscore-prefixed pagination params', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await api().listActivity({ clientName: 'Pruden', since: 5, sinceUnits: 'days', page: 2, perPage: 50 });
    const url = new URL(requestedUrl());
    expect(url.origin + url.pathname).toBe('https://api.datto.com/v1/report/activity-log');
    expect(url.searchParams.get('clientName')).toBe('Pruden');
    expect(url.searchParams.get('since')).toBe('5');
    expect(url.searchParams.get('sinceUnits')).toBe('days');
    expect(url.searchParams.get('_page')).toBe('2');
    expect(url.searchParams.get('_perPage')).toBe('50');
  });

  it('passes the documented target tuple filter through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await api().listActivity({ target: 'bcdr-device:ABC123', targetType: 'bcdr-device' });
    const url = new URL(requestedUrl());
    expect(url.searchParams.get('target')).toBe('bcdr-device:ABC123');
    expect(url.searchParams.get('targetType')).toBe('bcdr-device');
  });

  it('sends no query string when unfiltered', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [] }));
    await api().listActivity();
    expect(requestedUrl()).toBe('https://api.datto.com/v1/report/activity-log');
  });

  it('parses the paginated envelope', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        pagination: { page: 1, perPage: 25, totalPages: 3, count: 25 },
        items: [{ timestamp: '2018-08-28T19:00:16+00:00', action: 'protectedSystem.deleted', success: true }],
      })
    );
    const page = await api().listActivity();
    expect(page.pagination?.totalPages).toBe(3);
    expect(page.items?.[0].action).toBe('protectedSystem.deleted');
  });
});

describe('read-only by construction', () => {
  it('exposes no method that can issue a write', () => {
    const client = api() as unknown as Record<string, unknown>;
    const surface = [
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(client)),
      ...Object.keys(client),
    ];
    for (const forbidden of ['post', 'put', 'patch', 'delete', 'request', 'bulkSeatChange', 'queueRestore']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('only ever issues GET requests', async () => {
    // A fresh Response per call — a Response body can only be read once.
    fetchMock.mockImplementation(() => jsonResponse([]));
    const client = api();
    await client.listDomains();
    await client.listSeats(1);
    await client.getBackupReport(1);
    await client.listActivity();
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).method).toBe('GET');
      expect((call[1] as RequestInit).body).toBeUndefined();
    }
  });
});

describe('error mapping', () => {
  it.each([
    [401, DattoSaasProtectionAuthenticationError],
    [403, DattoSaasProtectionForbiddenError],
    [404, DattoSaasProtectionNotFoundError],
    [429, DattoSaasProtectionRateLimitError],
    [500, DattoSaasProtectionServerError],
    [503, DattoSaasProtectionServerError],
    [418, DattoSaasProtectionError],
  ])('maps %i onto the SDK error taxonomy', async (status, ErrorClass) => {
    fetchMock.mockResolvedValue(errorResponse(status));
    await expect(api().listDomains()).rejects.toBeInstanceOf(ErrorClass);
  });

  it('names the path in a 404 and says it is not a credential problem', async () => {
    fetchMock.mockResolvedValue(errorResponse(404));
    await expect(api().listSeats(53124)).rejects.toThrow(/\/v1\/saas\/53124\/seats/);
    fetchMock.mockResolvedValue(errorResponse(404));
    await expect(api().listSeats(53124)).rejects.toThrow(/never a credential problem/);
  });

  it('reads Retry-After into the rate limit error', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, { 'retry-after': '30' }));
    await expect(api().listDomains()).rejects.toMatchObject({ retryAfter: 30_000 });
  });

  it('never leaks the secret key in an error message', async () => {
    fetchMock.mockResolvedValue(errorResponse(401));
    await expect(api({ secretKey: 'super-secret' }).listDomains()).rejects.not.toThrow(
      /super-secret/
    );
  });

  it('wraps a malformed JSON body instead of leaking a SyntaxError', async () => {
    fetchMock.mockResolvedValue(
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    await expect(api().listDomains()).rejects.toThrow(/malformed JSON/);
  });
});

describe('base URL override', () => {
  it('defaults to the real host and strips a trailing slash from an override', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await api({ baseUrl: 'https://proxy.example.com/' }).listDomains();
    expect(requestedUrl()).toBe('https://proxy.example.com/v1/saas/domains');
  });
});
