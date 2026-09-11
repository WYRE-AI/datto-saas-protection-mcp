/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the seat card:
 *   1. renderable tools advertise the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. datto_saas_get_seat results carry the normalized `_card` payload the
 *      iframe renders from
 *
 * Wire-level checks drive the real server factory over an in-memory
 * transport pair (the same Server as production) with `fetch` stubbed, so the
 * request URL asserted here is the one the client would really put on the
 * wire; buildSeatCard is unit-tested directly.
 *
 * The card renders only fields Datto's seat schema actually returns —
 * `mainId`, `name`, `seatType`, `seatState`, `billable`, `dateAdded`,
 * `remoteId`. There is no per-seat backup timestamp in this API, so the card
 * shows billing and protection start instead of the `lastBackupAt` the
 * previous, speculative schema invented.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';
import type { SaasSeat } from '../src/datto-api.js';
import {
  applyBrandInjection,
  buildSeatCard,
  SEAT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from '../src/seat-card.js';
import { SEAT_CARD_HTML } from '../src/generated/seat-card-html.js';

const fetchMock = vi.fn();

/** A fresh Response per call — a Response body can only be read once. */
function jsonBody(body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk' };
const SAAS_CUSTOMER_ID = 53124;

async function connectClient(withCreds = false): Promise<Client> {
  const server = createMcpServer(withCreds ? TEST_CREDS : undefined);
  const client = new Client({ name: 'mcp-apps-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const RENDERABLE_TOOLS = ['datto_saas_get_seat'];

/** Datto's documented seat shape — `billable` really is a string. */
const activeSeat: SaasSeat = {
  mainId: 'dana.ruiz@example.com',
  name: 'Dana Ruiz',
  seatType: 'SharedMailbox',
  seatState: 'Active',
  billable: '1',
  dateAdded: '2022-04-26T16:43:05+00:00',
  remoteId: '12345221-d561-11ee-9645-abcdef123456',
};

const ACTIVE_SEAT_CARD = {
  seatId: 'dana.ruiz@example.com',
  title: 'Dana Ruiz',
  email: 'dana.ruiz@example.com',
  seatType: 'Shared mailbox',
  status: 'Active',
  billing: 'Billable',
  protectedSince: '2022-04-26T16:43:05.000Z',
};

async function getSeat(client: Client, seatId: string) {
  return (await client.callTool({
    name: 'datto_saas_get_seat',
    arguments: { saasCustomerId: SAAS_CUSTOMER_ID, seatId },
  })) as { isError?: boolean; content: Array<{ text?: string }> };
}

describe('MCP Apps seat card', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('tool _meta advertisement', () => {
    it.each(RENDERABLE_TOOLS)('%s links the card via _meta', async (name) => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === name);
      expect(tool).toBeDefined();
      // Canonical flat key (ext-apps RESOURCE_URI_META_KEY) …
      expect(tool?._meta?.['ui/resourceUri']).toBe(SEAT_CARD_RESOURCE_URI);
      // … and the nested form registerAppTool also emits.
      expect((tool?._meta?.ui as { resourceUri?: string })?.resourceUri).toBe(
        SEAT_CARD_RESOURCE_URI
      );
    });

    it('no other tools carry UI metadata', async () => {
      const client = await connectClient();
      const { tools } = await client.listTools();
      const others = tools.filter(
        (t) => t._meta && !RENDERABLE_TOOLS.includes(t.name)
      );
      expect(others).toEqual([]);
    });
  });

  describe('ui:// resource', () => {
    it('is listed with the MCP Apps MIME type', async () => {
      const client = await connectClient();
      const { resources } = await client.listResources();
      const card = resources.find((r) => r.uri === SEAT_CARD_RESOURCE_URI);
      expect(card?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    });

    it('reads back as profile=mcp-app HTML containing the card app', async () => {
      const client = await connectClient();
      const { contents } = await client.readResource({ uri: SEAT_CARD_RESOURCE_URI });
      const content = contents[0];
      expect(content?.mimeType).toBe(MCP_APP_RESOURCE_MIME);
      // No MCP_BRAND_* env set → the embedded HTML is served byte-identical.
      expect(content?.text).toBe(SEAT_CARD_HTML);
      expect(content?.text).toContain('card__bar');
      // The vite build must have inlined the bridge script — a bare <script src>
      // would be unloadable from a resources/read HTML string.
      expect(content?.text).not.toContain('src="./seat-card.ts"');
    });

    it('serves neutral defaults with no vendor identity or external fetches', () => {
      expect(SEAT_CARD_HTML).not.toMatch(/WYRE/i);
      expect(SEAT_CARD_HTML).not.toContain('00c9db'); // WYRE cyan
      expect(SEAT_CARD_HTML).not.toContain('ede947'); // WYRE yellow
      expect(SEAT_CARD_HTML).not.toContain('fonts.googleapis.com');
      // The brand-injection marker must appear exactly once in the bundle.
      expect(SEAT_CARD_HTML.match(/BRAND_INJECT/g)).toHaveLength(1);
    });

    it('renders only fields the real seat schema returns', () => {
      // Guards against the card drifting back to the invented per-seat
      // backup timestamp: Datto's seats route returns no such field.
      expect(SEAT_CARD_HTML).toContain('Protected since');
      expect(SEAT_CARD_HTML).not.toContain('Last backup');
      expect(SEAT_CARD_HTML).not.toContain('lastBackupAt');
    });

    it('injects MCP_BRAND_* env branding at serve time', async () => {
      vi.stubEnv('MCP_BRAND_NAME', 'Acme MSP');
      vi.stubEnv('MCP_BRAND_PRIMARY_COLOR', '#ff0000');
      const client = await connectClient();
      const { contents } = await client.readResource({ uri: SEAT_CARD_RESOURCE_URI });
      const text = (contents[0]?.text as string) ?? '';
      expect(text).toContain(
        '<script>window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}</script>'
      );
      expect(text).not.toContain('BRAND_INJECT');
    });

    it('rejects unknown resource URIs', async () => {
      const client = await connectClient();
      await expect(
        client.readResource({ uri: 'ui://datto-saas/nope.html' })
      ).rejects.toThrow(/Unknown resource/);
    });
  });

  describe('datto_saas_get_seat result', () => {
    it('carries the normalized _card payload alongside the raw seat', async () => {
      fetchMock.mockImplementation(jsonBody([activeSeat]));
      const client = await connectClient(true);
      const result = await getSeat(client, activeSeat.mainId!);

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload.mainId).toBe(activeSeat.mainId);
      expect(payload.billable).toBe('1');
      expect(payload._card).toEqual(ACTIVE_SEAT_CARD);
    });

    it('reads the customer-scoped seats route, not a per-seat route', async () => {
      fetchMock.mockImplementation(jsonBody([activeSeat]));
      const client = await connectClient(true);
      await getSeat(client, activeSeat.mainId!);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://api.datto.com/v1/saas/53124/seats'
      );
    });

    it('finds a seat by its opaque remoteId too', async () => {
      fetchMock.mockImplementation(jsonBody([activeSeat]));
      const client = await connectClient(true);
      const result = await getSeat(client, activeSeat.remoteId!);

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload.mainId).toBe(activeSeat.mainId);
    });

    it('reports a miss as a seat-not-found error, not an empty card', async () => {
      fetchMock.mockImplementation(jsonBody([activeSeat]));
      const client = await connectClient(true);
      const result = await getSeat(client, 'nobody@example.com');

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/Seat not found/);
    });

    it('drops the card (not the result) when the seat cannot be normalized', async () => {
      // Matched on remoteId but carrying no mainId — nothing to key a card on.
      const partial = { remoteId: 'orphan-id', seatState: 'Active' };
      fetchMock.mockImplementation(jsonBody([partial]));
      const client = await connectClient(true);
      const result = await getSeat(client, 'orphan-id');

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload.remoteId).toBe('orphan-id');
      expect(payload._card).toBeUndefined();
    });
  });

  describe('applyBrandInjection', () => {
    it('replaces the BRAND_INJECT marker with a window.__BRAND__ script', () => {
      const out = applyBrandInjection(SEAT_CARD_HTML, {
        name: 'Acme MSP',
        primaryColor: '#ff0000',
      });
      expect(out).not.toContain('BRAND_INJECT');
      expect(out).toContain(
        'window.__BRAND__={"name":"Acme MSP","primaryColor":"#ff0000"}'
      );
    });

    it('escapes < so brand values cannot break out of the script tag', () => {
      const out = applyBrandInjection(SEAT_CARD_HTML, {
        name: '</script><script>alert(1)',
      });
      expect(out).not.toContain('</script><script>alert(1)');
      expect(out).toContain('\\u003c/script');
    });

    it('returns the HTML unchanged for an empty brand', () => {
      expect(applyBrandInjection(SEAT_CARD_HTML, {})).toBe(SEAT_CARD_HTML);
      expect(applyBrandInjection(SEAT_CARD_HTML, { name: '' })).toBe(SEAT_CARD_HTML);
    });
  });

  describe('buildSeatCard', () => {
    it('normalizes a full seat with label-resolved type and status', () => {
      expect(buildSeatCard(activeSeat)).toEqual(ACTIVE_SEAT_CARD);
    });

    it('reads Datto\'s string billable flag, not a boolean', () => {
      expect(buildSeatCard({ ...activeSeat, billable: '0' })?.billing).toBe('Not billable');
      // A boolean would be a schema drift — no billing line rather than a wrong one.
      expect(
        buildSeatCard({ ...activeSeat, billable: true as unknown as string })?.billing
      ).toBeUndefined();
    });

    it('reflects seatState verbatim and defaults it when absent', () => {
      expect(buildSeatCard({ ...activeSeat, seatState: 'Archived' })?.status).toBe(
        'Archived'
      );
      expect(buildSeatCard({ ...activeSeat, seatState: undefined })?.status).toBe(
        'Unknown'
      );
    });

    it('labels known seat types and passes unknown types through', () => {
      expect(buildSeatCard({ ...activeSeat, seatType: 'Site' })?.seatType).toBe(
        'SharePoint site'
      );
      expect(buildSeatCard({ ...activeSeat, seatType: 'SharedDrive' })?.seatType).toBe(
        'Shared drive'
      );
      expect(buildSeatCard({ ...activeSeat, seatType: 'FutureType' })?.seatType).toBe(
        'FutureType'
      );
    });

    it('falls back from name to mainId for the title', () => {
      expect(buildSeatCard({ ...activeSeat, name: undefined })?.title).toBe(
        activeSeat.mainId
      );
    });

    it('exposes mainId as an email only when it is an address', () => {
      expect(buildSeatCard(activeSeat)?.email).toBe('dana.ruiz@example.com');
      const siteSeat = buildSeatCard({
        ...activeSeat,
        mainId: 'b!9d2f-site-collection-id',
        seatType: 'Site',
      });
      expect(siteSeat?.seatId).toBe('b!9d2f-site-collection-id');
      expect(siteSeat?.email).toBeUndefined();
    });

    it('omits protectedSince when dateAdded is absent or unparseable', () => {
      expect(buildSeatCard({ ...activeSeat, dateAdded: undefined })?.protectedSince)
        .toBeUndefined();
      expect(buildSeatCard({ ...activeSeat, dateAdded: 'not-a-date' })?.protectedSince)
        .toBeUndefined();
    });

    it('returns null for payloads that are not a seat', () => {
      expect(buildSeatCard(undefined)).toBeNull();
      expect(buildSeatCard(null)).toBeNull();
      expect(buildSeatCard({})).toBeNull();
      // No mainId means no stable identity to render.
      expect(buildSeatCard({ remoteId: 'abc', seatState: 'Active' })).toBeNull();
    });

    it('survives sparse seats (card is best-effort)', () => {
      expect(buildSeatCard({ mainId: 'abc' })).toEqual({
        seatId: 'abc',
        title: 'abc',
        status: 'Unknown',
      });
    });
  });
});
