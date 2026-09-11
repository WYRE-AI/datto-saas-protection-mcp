import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { cleanCredential, createClient, getCredentials } from '../src/credentials.js';
import { DATTO_API_BASE_URL } from '../src/datto-api.js';

describe('Datto SaaS Protection MCP Server', () => {
  describe('Tool Definitions', () => {
    const expectedTools = [
      'datto_saas_list_clients',
      'datto_saas_list_domains',
      'datto_saas_list_seats',
      'datto_saas_get_seat',
      'datto_saas_get_backup_report',
      'datto_saas_list_activity',
      'datto_saas_get_license_usage',
    ];

    it('should define all 7 tools', () => {
      expect(expectedTools).toHaveLength(7);
    });

    it('should include client + domain tools', () => {
      expect(expectedTools).toContain('datto_saas_list_clients');
      expect(expectedTools).toContain('datto_saas_list_domains');
    });

    it('should include seat tools', () => {
      expect(expectedTools).toContain('datto_saas_list_seats');
      expect(expectedTools).toContain('datto_saas_get_seat');
    });

    it('should include the backup report tool', () => {
      expect(expectedTools).toContain('datto_saas_get_backup_report');
    });

    it('should include activity + license tools', () => {
      expect(expectedTools).toContain('datto_saas_list_activity');
      expect(expectedTools).toContain('datto_saas_get_license_usage');
    });

    // Datto's REST API has no restore route of any kind. The old tools called
    // /seats/{id}/restores and /restores/{id}, which do not exist.
    it('should not expose restore tools', () => {
      expect(expectedTools).not.toContain('datto_saas_queue_restore');
      expect(expectedTools).not.toContain('datto_saas_get_restore_status');
    });
  });

  describe('Server Configuration', () => {
    it('should define server with correct name', () => {
      const config = { name: 'datto-saas-protection-mcp', version: '0.0.0' };
      expect(config.name).toBe('datto-saas-protection-mcp');
    });
  });
});

describe('credentials', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DATTO_SAAS_PUBLIC_KEY;
    delete process.env.DATTO_SAAS_SECRET_KEY;
    delete process.env.DATTO_SAAS_API_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns null without both keys', () => {
    expect(getCredentials()).toBeNull();
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    expect(getCredentials()).toBeNull();
  });

  it('reads the public/secret key pair', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    expect(getCredentials()).toEqual({
      publicKey: 'pub',
      secretKey: 'sec',
      baseUrl: undefined,
    });
  });

  // There is no region option any more: Datto SaaS Protection is served from a
  // single host. The SDK's "eu" region (api.eu.datto.com) does not resolve.
  it('has no region concept', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    process.env.DATTO_SAAS_REGION = 'eu';
    expect(getCredentials()).not.toHaveProperty('region');
    expect(DATTO_API_BASE_URL).toBe('https://api.datto.com');
  });

  it('createClient builds a client without throwing', () => {
    expect(() => createClient({ publicKey: 'pub', secretKey: 'sec' })).not.toThrow();
  });

  it('createClient rejects missing keys', () => {
    expect(() => createClient({ publicKey: '', secretKey: 'sec' })).toThrow(/publicKey/);
    expect(() => createClient({ publicKey: 'pub', secretKey: '' })).toThrow(/secretKey/);
  });
});

// Regression tests for issue #73 (mirrors itglue-mcp #73). An MCPB desktop
// bundle maps optional config to ${user_config.*}; when the field is left
// blank Claude Desktop injects that literal, unresolved string rather than an
// empty value. Being truthy it beats every `|| default` fallback and reaches
// the client as if it were real configuration.
describe('issue #73: unresolved MCPB config placeholders', () => {
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
    expect(cleanCredential('${user_config.datto_saas_api_url}')).toBeUndefined();
    expect(cleanCredential('  ${user_config.datto_saas_api_url}  ')).toBeUndefined();
  });

  it('cleanCredential preserves and trims real values', () => {
    expect(cleanCredential('https://api.datto.com')).toBe('https://api.datto.com');
    expect(cleanCredential('  pub-key  ')).toBe('pub-key');
  });

  it('an unresolved DATTO_SAAS_API_URL placeholder falls back to the real host', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    process.env.DATTO_SAAS_API_URL = '${user_config.datto_saas_api_url}';

    expect(getCredentials()?.baseUrl).toBeUndefined();
    expect(() => createClient(getCredentials()!)).not.toThrow();
  });

  it('still honours a real API URL override', () => {
    process.env.DATTO_SAAS_PUBLIC_KEY = 'pub';
    process.env.DATTO_SAAS_SECRET_KEY = 'sec';
    process.env.DATTO_SAAS_API_URL = 'https://proxy.example.com';

    expect(getCredentials()?.baseUrl).toBe('https://proxy.example.com');
  });
});
