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

const mockSeatsList = vi.fn();

vi.mock('@wyre-ai/node-datto-saas-protection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@wyre-ai/node-datto-saas-protection')>();
  return {
    ...actual,
    DattoSaasProtectionClient: class {
      seats = { list: mockSeatsList };
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
  remoteId: 'seat-3f8a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8',
  mainId: 'dana.ruiz@example.com',
  name: 'Dana Ruiz',
  seatType: 'User',
  seatState: 'Active',
  billable: 1,
  dateAdded: '2026-01-02T00:00:00Z',
};

describe('MCP Apps seat card', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockSeatsList.mockReset();
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
      mockSeatsList.mockResolvedValue([{ remoteId: 'other', mainId: 'x@example.com' }, activeSeat]);
      const client = await connectClient(true);
      const result = (await client.callTool({
        name: 'datto_saas_get_seat',
        arguments: { saasCustomerId: 1001, seatId: activeSeat.remoteId },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBeFalsy();
      expect(mockSeatsList).toHaveBeenCalledWith('1001');
      const payload = JSON.parse(result.content[0]?.text ?? '{}');
      expect(payload.remoteId).toBe(activeSeat.remoteId);
      expect(payload.mainId).toBe(activeSeat.mainId);
      expect(payload._card).toEqual({
        seatId: activeSeat.remoteId,
        title: 'Dana Ruiz',
        email: 'dana.ruiz@example.com',
        seatType: 'User',
        status: 'Active',
        backupStatus: 'Protected (backups enabled)',
      });
    });

    it('matches on mainId case-insensitively', async () => {
      mockSeatsList.mockResolvedValue([activeSeat]);
      const client = await connectClient(true);
      const result = (await client.callTool({
        name: 'datto_saas_get_seat',
        arguments: { saasCustomerId: '1001', seatId: 'DANA.RUIZ@example.com' },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0]?.text ?? '{}')._card.seatId).toBe(activeSeat.remoteId);
    });

    it('returns an isError result when no seat matches', async () => {
      mockSeatsList.mockResolvedValue([activeSeat]);
      const client = await connectClient(true);
      const result = (await client.callTool({
        name: 'datto_saas_get_seat',
        arguments: { saasCustomerId: 1001, seatId: 'missing' },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/No seat/);
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
    it('normalizes a Datto seat with label-resolved type and state', () => {
      expect(buildSeatCard(activeSeat)).toEqual({
        seatId: activeSeat.remoteId,
        title: 'Dana Ruiz',
        email: 'dana.ruiz@example.com',
        seatType: 'User',
        status: 'Active',
        backupStatus: 'Protected (backups enabled)',
      });
    });

    it('maps every Datto seatState to a protection wording', () => {
      expect(buildSeatCard({ ...activeSeat, seatState: 'Paused' })?.backupStatus).toBe('Paused (no new backups)');
      expect(buildSeatCard({ ...activeSeat, seatState: 'Archived' })?.backupStatus).toBe('Archived (backups retained)');
      expect(buildSeatCard({ ...activeSeat, seatState: 'Unprotected' })?.backupStatus).toBe('Not protected');
      expect(buildSeatCard({ ...activeSeat, seatState: 'Weird' })?.backupStatus).toBe('Unknown');
    });

    it('resolves known seat types and passes unknown types through', () => {
      expect(buildSeatCard({ ...activeSeat, seatType: 'SharedMailbox' })?.seatType).toBe('Shared mailbox');
      expect(buildSeatCard({ ...activeSeat, seatType: 'TeamSite' })?.seatType).toBe('Team site');
      expect(buildSeatCard({ ...activeSeat, seatType: 'NewKind' })?.seatType).toBe('NewKind');
    });

    it('falls back through mainId to the remote id for the title', () => {
      expect(buildSeatCard({ ...activeSeat, name: undefined })?.title).toBe('dana.ruiz@example.com');
      expect(buildSeatCard({ remoteId: 'r-1' })?.title).toBe('r-1');
    });

    it('only treats mainId as an email when it looks like one', () => {
      const site = buildSeatCard({ remoteId: 'r-2', mainId: 'https://acme.sharepoint.com/sites/x', seatType: 'Site' });
      expect(site?.email).toBeUndefined();
      expect(site?.title).toBe('https://acme.sharepoint.com/sites/x');
    });

    it('keys on mainId when remoteId is absent', () => {
      expect(buildSeatCard({ mainId: 'a@b.com' })?.seatId).toBe('a@b.com');
    });

    it('returns null for payloads that are not a seat', () => {
      expect(buildSeatCard(undefined)).toBeNull();
      expect(buildSeatCard(null)).toBeNull();
      expect(buildSeatCard({} as never)).toBeNull();
    });

    it('survives sparse seats (card is best-effort)', () => {
      expect(buildSeatCard({ remoteId: 'abc' })).toEqual({
        seatId: 'abc',
        title: 'abc',
        status: 'Unknown',
        backupStatus: 'Unknown',
      });
    });
  });
});
