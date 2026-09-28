import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { cleanCredential, createClient, getCredentials } from '../src/credentials.js';

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
