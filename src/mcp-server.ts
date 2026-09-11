/**
 * Shared MCP server factory for Datto SaaS Protection.
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint and driven directly from tests.
 * All tools are exposed upfront for universal MCP client compatibility. A
 * fresh server is created per request (for credential isolation in HTTP mode).
 *
 * Every tool maps onto a route that exists in Datto's published REST API
 * contract, or is a clearly-labelled reshaping of one that does — see
 * src/datto-api.ts and src/derived.ts. Datto's SaaS Protection surface is
 * read-only apart from a bulk seat-licensing call, which this server does not
 * expose; there is no restore API, so there are no restore tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { elicitSelection } from "./utils/elicitation.js";
import { SEAT_TYPES, type DattoSaasApi } from "./datto-api.js";
import { deriveCustomers, deriveLicenseUsage, findSeat, matchesCustomer } from "./derived.js";
import {
  createClient,
  getCredentials,
  type DattoSaasCredentials,
} from "./credentials.js";
import {
  MCP_APP_RESOURCE_MIME,
  SEAT_CARD_META,
  SEAT_CARD_RESOURCE_URI,
  applyBrandInjection,
  buildSeatCard,
  resolveBrandFromEnv,
} from "./seat-card.js";
import { SEAT_CARD_HTML } from "./generated/seat-card-html.js";

/** Every tool takes the customer id Datto actually keys its routes on. */
const SAAS_CUSTOMER_ID_PROPERTY = {
  type: ["string", "number"],
  description:
    "Datto SaaS Protection customer id (the numeric `saasCustomerId` from datto_saas_list_clients or datto_saas_list_domains)",
} as const;

// ---------------------------------------------------------------------------
// Server factory — fresh server per request (stateless HTTP mode)
// ---------------------------------------------------------------------------

export function createMcpServer(credentialOverrides?: DattoSaasCredentials): Server {
  const server = new Server(
    {
      name: "datto-saas-protection-mcp",
      version: "0.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // The caller owns binding this server into server-ref.ts's scope now
  // (bindServerRef for stdio's single session, runWithServerRef wrapping
  // the whole per-request chain for HTTP) — createMcpServer() stays
  // side-effect-free with respect to server-ref.

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "datto_saas_list_clients",
          description:
            "List the customer organizations protected by Datto SaaS Protection, with their domains and seats used. Derived from GET /v1/saas/domains — Datto has no separate customers endpoint.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "datto_saas_list_domains",
          description:
            "List protected domains (GET /v1/saas/domains). Returns every domain the API key can see, each with its saasCustomerId, product type, subscription and 24h backup stats. Optionally narrow to one customer.",
          inputSchema: {
            type: "object",
            properties: {
              saasCustomerId: SAAS_CUSTOMER_ID_PROPERTY,
            },
          },
        },
        {
          name: "datto_saas_list_seats",
          description:
            "List a customer's seats — mailboxes, sites, teams and drives (GET /v1/saas/{saasCustomerId}/seats). Seats are customer-scoped, not domain-scoped.",
          inputSchema: {
            type: "object",
            properties: {
              saasCustomerId: SAAS_CUSTOMER_ID_PROPERTY,
              seatType: {
                type: "array",
                description: "Optional seat types to filter by.",
                items: { type: "string", enum: [...SEAT_TYPES] },
              },
            },
            required: ["saasCustomerId"],
          },
        },
        {
          name: "datto_saas_get_seat",
          description:
            "Get one seat by its mainId (usually an email address) or remoteId. Datto has no single-seat route, so this filters the customer's seat list.",
          _meta: SEAT_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              saasCustomerId: SAAS_CUSTOMER_ID_PROPERTY,
              seatId: {
                type: "string",
                description: "The seat's mainId (e.g. user@contoso.com) or remoteId",
              },
            },
            required: ["saasCustomerId", "seatId"],
          },
        },
        {
          name: "datto_saas_get_backup_report",
          description:
            "Get a customer's backup and storage report (GET /v1/saas/{saasCustomerId}/applications) — protected suites, application types and bytes used. Datto reports backup posture per customer, not per seat.",
          inputSchema: {
            type: "object",
            properties: {
              saasCustomerId: SAAS_CUSTOMER_ID_PROPERTY,
              daysUntil: {
                type: "number",
                description: "Days of history the report should cover (optional)",
              },
            },
            required: ["saasCustomerId"],
          },
        },
        {
          name: "datto_saas_list_activity",
          description:
            "Read the Datto partner portal activity log (GET /v1/report/activity-log). This is the account-wide audit log across Datto products, filterable by client name, user and look-back window — not a SaaS-Protection-only feed.",
          inputSchema: {
            type: "object",
            properties: {
              clientName: { type: "string", description: "Partial/prefix match on client name" },
              user: { type: "string", description: "Partial/prefix match on the acting user" },
              since: {
                type: "number",
                description: "Look back this many sinceUnits from now (default 1)",
              },
              sinceUnits: {
                type: "string",
                enum: ["days", "hours", "minutes"],
                description: "Units for `since` (default: days)",
              },
              page: { type: "number", description: "Page number (default 1)" },
              perPage: { type: "number", description: "Results per page (default 25)" },
            },
          },
        },
        {
          name: "datto_saas_get_license_usage",
          description:
            "Seats used per customer, broken down by subscription, product type and retention. Derived from GET /v1/saas/domains — Datto publishes seats used, not seats purchased.",
          inputSchema: {
            type: "object",
            properties: {
              saasCustomerId: SAAS_CUSTOMER_ID_PROPERTY,
            },
          },
        },
      ],
    };
  });

  // MCP Apps (SEP-1865): the ui:// seat card is static HTML embedded at
  // build time (src/generated/seat-card-html.ts), so it serves identically
  // from stdio and Node HTTP without touching the filesystem.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: SEAT_CARD_RESOURCE_URI,
          name: "Datto SaaS Protection Seat Card",
          description:
            "Interactive MCP Apps card rendering a protected seat's status",
          mimeType: MCP_APP_RESOURCE_MIME,
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri !== SEAT_CARD_RESOURCE_URI) {
      throw new Error(`Unknown resource: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: MCP_APP_RESOURCE_MIME,
          // The card ships neutral; operators brand it at serve time via
          // MCP_BRAND_* env vars (no vars = HTML served unchanged).
          text: applyBrandInjection(SEAT_CARD_HTML, resolveBrandFromEnv()),
        },
      ],
    };
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function json(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  }

  function failure(message: string) {
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }

  /**
   * Resolve the customer to act on, prompting from the real domain list when
   * the caller didn't supply one.
   */
  async function resolveSaasCustomerId(
    api: DattoSaasApi,
    provided?: string | number
  ): Promise<string | number | null> {
    if (provided !== undefined && provided !== null && provided !== "") return provided;

    try {
      const customers = deriveCustomers(await api.listDomains());
      if (customers.length === 0) return null;
      if (customers.length === 1) return customers[0].saasCustomerId;
      const picked = await elicitSelection(
        "Select a SaaS Protection customer:",
        "saasCustomerId",
        customers.slice(0, 25).map((c) => ({
          value: String(c.saasCustomerId),
          label: c.saasCustomerName
            ? `${c.saasCustomerName} (${c.saasCustomerId})`
            : String(c.saasCustomerId),
        }))
      );
      return picked;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return failure(
        "Error: No API credentials provided. Please configure DATTO_SAAS_PUBLIC_KEY + DATTO_SAAS_SECRET_KEY environment variables, or pass them as gateway headers."
      );
    }

    const api = createClient(creds);

    try {
      switch (name) {
        case "datto_saas_list_clients": {
          return json(deriveCustomers(await api.listDomains()));
        }

        case "datto_saas_list_domains": {
          const params = (args ?? {}) as { saasCustomerId?: string | number };
          const domains = await api.listDomains();
          if (params.saasCustomerId === undefined) return json(domains);
          return json(domains.filter((d) => matchesCustomer(d, params.saasCustomerId!)));
        }

        case "datto_saas_list_seats": {
          const params = (args ?? {}) as {
            saasCustomerId?: string | number;
            seatType?: string[];
          };
          const saasCustomerId = await resolveSaasCustomerId(api, params.saasCustomerId);
          if (saasCustomerId === null) return failure("Error: saasCustomerId is required.");
          return json(await api.listSeats(saasCustomerId, { seatType: params.seatType }));
        }

        case "datto_saas_get_seat": {
          const { saasCustomerId, seatId } = (args ?? {}) as {
            saasCustomerId?: string | number;
            seatId?: string;
          };
          if (!seatId) return failure("Error: seatId is required.");
          const customerId = await resolveSaasCustomerId(api, saasCustomerId);
          if (customerId === null) return failure("Error: saasCustomerId is required.");

          const seat = findSeat(await api.listSeats(customerId), seatId);
          if (!seat) {
            return failure(
              `Seat not found: no seat with mainId or remoteId "${seatId}" under customer ${customerId}.`
            );
          }
          // MCP Apps: attach the normalized payload the ui:// seat card
          // renders from. Best-effort — any failure just means no UI surface,
          // never a failed tool result.
          const card = buildSeatCard(seat);
          return json(card ? { ...seat, _card: card } : seat);
        }

        case "datto_saas_get_backup_report": {
          const params = (args ?? {}) as {
            saasCustomerId?: string | number;
            daysUntil?: number;
          };
          const saasCustomerId = await resolveSaasCustomerId(api, params.saasCustomerId);
          if (saasCustomerId === null) return failure("Error: saasCustomerId is required.");
          return json(
            await api.getBackupReport(saasCustomerId, { daysUntil: params.daysUntil })
          );
        }

        case "datto_saas_list_activity": {
          const params = (args ?? {}) as {
            clientName?: string;
            user?: string;
            since?: number;
            sinceUnits?: "days" | "hours" | "minutes";
            page?: number;
            perPage?: number;
          };
          return json(await api.listActivity(params));
        }

        case "datto_saas_get_license_usage": {
          const params = (args ?? {}) as { saasCustomerId?: string | number };
          const domains = await api.listDomains();
          const scoped =
            params.saasCustomerId === undefined
              ? domains
              : domains.filter((d) => matchesCustomer(d, params.saasCustomerId!));
          return json(deriveLicenseUsage(scoped));
        }

        default:
          return failure(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(`Error: ${message}`);
    }
  });

  return server;
}
