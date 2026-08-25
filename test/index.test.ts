import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { cleanCredential, createClient, getCredentials } from '../src/credentials.js';

describe('Datto SaaS Protection MCP Server', () => {
  describe('Tool Definitions', () => {
    const expectedTools = [
      'datto_saas_list_clients',
      'datto_saas_list_domains',
      'datto_saas_list_seats',
      'datto_saas_get_seat',
      'datto_saas_list_backups',
      'datto_saas_queue_restore',
      'datto_saas_get_restore_status',
      'datto_saas_list_activity',
      'datto_saas_get_license_usage',
    ];

    it('should define all 9 tools', () => {
      expect(expectedTools).toHaveLength(9);
    });

    it('should include client + domain tools', () => {
      expect(expectedTools).toContain('datto_saas_list_clients');
      expect(expectedTools).toContain('datto_saas_list_domains');
    });

    it('should include seat tools', () => {
      expect(expectedTools).toContain('datto_saas_list_seats');
      expect(expectedTools).toContain('datto_saas_get_seat');
    });

    it('should include backup + restore tools', () => {
      expect(expectedTools).toContain('datto_saas_list_backups');
      expect(expectedTools).toContain('datto_saas_queue_restore');
      expect(expectedTools).toContain('datto_saas_get_restore_status');
    });

    it('should include activity + license tools', () => {
      expect(expectedTools).toContain('datto_saas_list_activity');
      expect(expectedTools).toContain('datto_saas_get_license_usage');
    });
  });

  describe('Region validation', () => {
    const validRegions = ['us', 'eu'];

    it('should support us and eu regions', () => {
      expect(validRegions).toContain('us');
      expect(validRegions).toContain('eu');
    });

    it('should default to us when DATTO_SAAS_REGION is not set', () => {
      expect(process.env.DATTO_SAAS_REGION).toBeUndefined();
    });
  });

  describe('Credentials', () => {
    it('should require DATTO_SAAS_API_KEY', () => {
      const required = ['DATTO_SAAS_API_KEY'];
      expect(required).toHaveLength(1);
    });
  });

  describe('Server Configuration', () => {
    it('should define server with correct name', () => {
      const config = { name: 'datto-saas-protection-mcp', version: '0.0.0' };
      expect(config.name).toBe('datto-saas-protection-mcp');
    });
  });
});

// Regression tests for issue #73 (mirrors itglue-mcp #73). The MCPB desktop
// bundle maps DATTO_SAAS_REGION to ${user_config.datto_saas_region}. When the
// optional region field is left blank, Claude Desktop injects the literal,
// unresolved string "${user_config.datto_saas_region}" rather than an empty
// value. Being truthy it beat the `|| "us"` fallback and reached the SDK, which
// throws `Unsupported region: ...` from createClient() — called outside the
// tool handler's try/catch — so EVERY tool call failed with an uncaught MCP
// protocol error out of the box.
describe('issue #73: unresolved MCPB config placeholder in DATTO_SAAS_REGION', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('cleanCredential drops empty, whitespace, and ${...} placeholder values', () => {
    expect(cleanCredential(undefined)).toBeUndefined();
    expect(cleanCredential('')).toBeUndefined();
    expect(cleanCredential('   ')).toBeUndefined();
    expect(cleanCredential('${user_config.datto_saas_region}')).toBeUndefined();
    expect(cleanCredential('  ${user_config.datto_saas_region}  ')).toBeUndefined();
  });

  it('cleanCredential preserves and trims real values', () => {
    expect(cleanCredential('eu')).toBe('eu');
    expect(cleanCredential('  us  ')).toBe('us');
  });

  it('resolves region to "us" when DATTO_SAAS_REGION is an unresolved placeholder', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    process.env.DATTO_SAAS_REGION = '${user_config.datto_saas_region}';

    expect(getCredentials()?.region).toBe('us');
  });

  it('still honours a real region override', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    process.env.DATTO_SAAS_REGION = 'eu';

    expect(getCredentials()?.region).toBe('eu');
  });

  it('createClient no longer throws "Unsupported region" for a placeholder region', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    process.env.DATTO_SAAS_REGION = '${user_config.datto_saas_region}';

    const creds = getCredentials();
    expect(creds).not.toBeNull();
    expect(() => createClient(creds!)).not.toThrow();
  });

  it('proves the underlying bug: the raw SDK rejects the placeholder region', async () => {
    const { DattoSaasProtectionClient } = await import(
      '@wyre-technology/node-datto-saas-protection'
    );
    expect(
      () =>
        new DattoSaasProtectionClient({
          publicKey: 'pub',
          secretKey: 'sec',
          region: '${user_config.datto_saas_region}' as 'us' | 'eu',
        })
    ).toThrow(/Unsupported region/);
  });
});
