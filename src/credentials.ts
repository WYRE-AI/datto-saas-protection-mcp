/**
 * Credential handling for the Datto SaaS Protection MCP server.
 *
 * Credentials arrive either from environment variables (env / desktop mode) or
 * per-request HTTP headers (gateway mode). This module normalises them at
 * ingress and builds the API client.
 */

import { DattoSaasApi } from "./datto-api.js";

export interface DattoSaasCredentials {
  publicKey: string;
  secretKey: string;
  /**
   * Optional API origin override (proxies, contract tests). Datto has exactly
   * one API host, so leaving this unset is correct for every real deployment.
   */
  baseUrl?: string;
}

// An unresolved MCPB/DXT manifest placeholder, e.g. "${user_config.foo}".
// Desktop hosts inject the config template verbatim when an optional
// user_config field is left blank, so the literal string arrives in the env
// var / header instead of an empty value.
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Normalise a single credential read from an env var or gateway header.
 *
 * Returns `undefined` for values that are effectively absent, so callers can
 * fall back to a default instead of treating them as real input:
 *   - undefined / empty / whitespace-only
 *   - an unresolved manifest placeholder like `${user_config.datto_saas_api_url}`
 *
 * Root cause of issue #73: an unresolved placeholder is a truthy string, so it
 * beat every `|| default` fallback and reached the client as if it were real
 * configuration. Stripping it here restores the default.
 */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

export function getCredentials(): DattoSaasCredentials | null {
  const publicKey = cleanCredential(process.env.DATTO_SAAS_PUBLIC_KEY);
  const secretKey = cleanCredential(process.env.DATTO_SAAS_SECRET_KEY);
  if (!publicKey || !secretKey) return null;
  return {
    publicKey,
    secretKey,
    baseUrl: cleanCredential(process.env.DATTO_SAAS_API_URL),
  };
}

export function createClient(creds: DattoSaasCredentials): DattoSaasApi {
  return new DattoSaasApi({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    baseUrl: cleanCredential(creds.baseUrl),
  });
}
