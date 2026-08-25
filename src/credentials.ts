/**
 * Credential handling for the Datto SaaS Protection MCP server.
 *
 * Credentials arrive either from environment variables (env / desktop mode) or
 * per-request HTTP headers (gateway mode). This module normalises them at
 * ingress and builds the SDK client.
 */

import { DattoSaasProtectionClient } from "@wyre-technology/node-datto-saas-protection";

export interface DattoSaasCredentials {
  publicKey: string;
  secretKey: string;
  region?: string;
}

// An unresolved MCPB/DXT manifest placeholder, e.g.
// "${user_config.datto_saas_region}". Desktop hosts inject the config template
// verbatim when its optional user_config field is left blank, so the literal
// string arrives in the env var / header instead of an empty value.
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Normalise a single credential read from an env var or gateway header.
 *
 * Returns `undefined` for values that are effectively absent, so callers can
 * fall back to a default instead of treating them as real input:
 *   - undefined / empty / whitespace-only
 *   - an unresolved manifest placeholder like `${user_config.datto_saas_region}`
 *
 * Root cause of issue #73: leaving the optional region field blank left the
 * literal `${user_config.datto_saas_region}` in DATTO_SAAS_REGION. Being a
 * truthy string it beat the `|| "us"` fallback and reached the SDK, which threw
 * `Unsupported region: ${user_config.datto_saas_region}` from createClient() —
 * outside the tool handler's try/catch — so every tool call failed with an
 * uncaught MCP protocol error. Stripping the placeholder here restores the
 * "us" default. Mirrors itglue-mcp #73.
 */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

export function getCredentials(): DattoSaasCredentials | null {
  const publicKey = process.env.DATTO_SAAS_PUBLIC_KEY;
  const secretKey = process.env.DATTO_SAAS_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  return {
    publicKey,
    secretKey,
    // Strip an unresolved placeholder before the "us" fallback (issue #73).
    region: cleanCredential(process.env.DATTO_SAAS_REGION) || "us",
  };
}

export function createClient(creds: DattoSaasCredentials): DattoSaasProtectionClient {
  return new DattoSaasProtectionClient({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    // Clean here too as the final guard before the SDK: the previous
    // `(creds.region as "us" | "eu")` cast was a no-op that let a placeholder
    // slip through to `resolveConfig`, which throws "Unsupported region".
    region: (cleanCredential(creds.region) as "us" | "eu") || "us",
  });
}
