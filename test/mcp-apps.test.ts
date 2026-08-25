/**
 * MCP Apps (SEP-1865) contract tests — mirrors the checks an MCP Apps host
 * performs to render the seat card:
 *   1. renderable tools advertise the UI resource via _meta
 *   2. the ui:// resource lists and reads back as profile=mcp-app HTML
 *   3. datto_saas_get_seat results carry the normalized `_card` payload the
 *      iframe renders from
 *
 * Wire-level checks drive the real server factory over an in-memory
 * transport pair (the same Server as production); buildSeatCard is
 * unit-tested directly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';
import {
  applyBrandInjection,
  buildSeatCard,
  SEAT_CARD_RESOURCE_URI,
  MCP_APP_RESOURCE_MIME,
} from '../src/seat-card.js';
import { SEAT_CARD_HTML } from '../src/generated/seat-card-html.js';

const mockSeatsGet = vi.fn();

vi.mock('@wyre-technology/node-datto-saas-protection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@wyre-technology/node-datto-saas-protection')>();
  return {
    ...actual,
    DattoSaasProtectionClient: class {
      seats = { get: mockSeatsGet };
    },
  };
});

const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk', region: 'us' };

async function connectClient(withCreds = false): Promise<Client> {
  const server = createMcpServer(withCreds ? TEST_CREDS : undefined);
  const client = new Client({ name: 'mcp-apps-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const RENDERABLE_TOOLS = ['datto_saas_get_seat'];

const activeSeat = {
  id: 'seat-3f8a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8',
  domainId: 'domain-1',
  clientId: 'client-1',
  type: 'mailbox',
  email: 'dana.ruiz@example.com',
  displayName: 'Dana Ruiz',
  archived: false,
  lastBackupAt: '2026-07-16T04:00:00.000Z',
};

describe('MCP Apps seat card', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockSeatsGet.mockReset();
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
      mockSeatsGet.mockResolvedValue(activeSeat);
      const client = await connectClient(true);
      const result = (await client.callTool({
        name: 'datto_saas_get_seat',
        arguments: { seatId: activeSeat.id },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload.id).toBe(activeSeat.id);
      expect(payload.email).toBe(activeSeat.email);
      expect(payload._card).toEqual({
        seatId: activeSeat.id,
        title: 'Dana Ruiz',
        email: 'dana.ruiz@example.com',
        seatType: 'Mailbox',
        status: 'Active',
        backupStatus: 'Backed up',
        lastBackupAt: '2026-07-16T04:00:00.000Z',
      });
    });

    it('drops the card (not the result) when the payload is not a seat', async () => {
      mockSeatsGet.mockResolvedValue({ unexpected: 'shape' });
      const client = await connectClient(true);
      const result = (await client.callTool({
        name: 'datto_saas_get_seat',
        arguments: { seatId: 'whatever' },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload.unexpected).toBe('shape');
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
      expect(buildSeatCard(activeSeat)).toEqual({
        seatId: activeSeat.id,
        title: 'Dana Ruiz',
        email: 'dana.ruiz@example.com',
        seatType: 'Mailbox',
        status: 'Active',
        backupStatus: 'Backed up',
        lastBackupAt: '2026-07-16T04:00:00.000Z',
      });
    });

    it('labels archived seats', () => {
      const card = buildSeatCard({ ...activeSeat, archived: true });
      expect(card?.status).toBe('Archived');
    });

    it('resolves known seat types and passes unknown types through', () => {
      expect(buildSeatCard({ ...activeSeat, type: 'google_user' })?.seatType).toBe(
        'Google Workspace user'
      );
      expect(buildSeatCard({ ...activeSeat, type: 'teams_channel' })?.seatType).toBe(
        'teams_channel'
      );
    });

    it('falls back through email to the seat id for the title', () => {
      expect(buildSeatCard({ ...activeSeat, displayName: undefined })?.title).toBe(
        'dana.ruiz@example.com'
      );
      expect(
        buildSeatCard({ ...activeSeat, displayName: undefined, email: undefined })?.title
      ).toBe(activeSeat.id);
    });

    it('reports "No backups recorded" when the timestamp is absent or invalid', () => {
      const noBackup = buildSeatCard({ ...activeSeat, lastBackupAt: undefined });
      expect(noBackup?.backupStatus).toBe('No backups recorded');
      expect(noBackup?.lastBackupAt).toBeUndefined();
      const badDate = buildSeatCard({ ...activeSeat, lastBackupAt: 'not-a-date' });
      expect(badDate?.backupStatus).toBe('No backups recorded');
      expect(badDate?.lastBackupAt).toBeUndefined();
    });

    it('returns null for payloads that are not a seat', () => {
      expect(buildSeatCard(undefined)).toBeNull();
      expect(buildSeatCard(null)).toBeNull();
      expect(buildSeatCard({} as never)).toBeNull();
    });

    it('survives sparse seats (card is best-effort)', () => {
      expect(buildSeatCard({ id: 'abc' } as never)).toEqual({
        seatId: 'abc',
        title: 'abc',
        status: 'Active',
        backupStatus: 'No backups recorded',
      });
    });
  });
});
