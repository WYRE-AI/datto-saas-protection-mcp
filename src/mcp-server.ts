/**
 * Shared MCP server factory for Datto SaaS Protection.
 *
 * Tools map 1:1 onto the documented Datto REST API SaaS Protection endpoints
 * (https://api.datto.com/v1/saas/...):
 *   GET /saas/domains, GET /saas/{id}/seats, GET /saas/{id}/applications,
 *   GET /saas/{id}/detailedBackupStats,
 *   PUT /saas/{id}/{externalSubscriptionId}/bulkSeatChange
 *
 * This module is **side-effect free** (importing it never starts a transport),
 * so it can be reused by every entrypoint and driven directly from tests.
 * All tools are exposed upfront for universal MCP client compatibility. A
 * fresh server is created per request (for credential isolation in HTTP mode).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_BULK_SEAT_IDS,
  SEAT_ACTION_TYPES,
  SEAT_TYPES,
  type DattoSaasProtectionClient,
  type SaasProtectionSeat,
  type SeatActionType,
  type SeatType,
} from "@wyre-ai/node-datto-saas-protection";
import { elicitConfirmation, elicitSelection } from "./utils/elicitation.js";
import { getServerRef } from "./utils/server-ref.js";
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

// ---------------------------------------------------------------------------
// Tool definitions (exported for tests / manifest generation)
// ---------------------------------------------------------------------------

const SAAS_CUSTOMER_ID = {
  type: ["number", "string"],
  description:
    "SaaS Protection customer ID (saasCustomerId from datto_saas_list_domains). Optional on read tools — the user is prompted to pick one if omitted and the client supports it.",
};

export const TOOL_DEFINITIONS = [
  {
    name: "datto_saas_list_domains",
    title: "List SaaS Protection customers / domains",
    description:
      "List every Datto SaaS Protection customer domain (M365 tenant or Google Workspace domain) visible to the API key: saasCustomerId, customer name, domain, productType, externalSubscriptionId, retention, seatsUsed and backup stats. Start here — the IDs it returns are required by every other tool. GET /v1/saas/domains.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional case-insensitive filter on customer name, domain, organization or subscription ID.",
        },
      },
    },
  },
  {
    name: "datto_saas_list_seats",
    title: "List protected seats for a customer",
    description:
      "List seats (users, shared mailboxes, shared drives, sites, team sites, teams) for a SaaS Protection customer with seatType, seatState (Active / Paused / Archived / Unprotected), billable flag and remoteId. GET /v1/saas/{saasCustomerId}/seats.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        saasCustomerId: SAAS_CUSTOMER_ID,
        seatType: {
          type: "string",
          enum: [...SEAT_TYPES],
          description: "Optional seat type filter (case-sensitive, sent to Datto).",
        },
        seatState: {
          type: "string",
          description: "Optional state filter applied to the result, e.g. Active, Paused, Archived, Unprotected.",
        },
      },
    },
  },
  {
    name: "datto_saas_get_seat",
    title: "Get one seat",
    description:
      "Look up a single seat for a customer by its remoteId or mainId (email / site URL) and render the seat card. Reads GET /v1/saas/{saasCustomerId}/seats.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: SEAT_CARD_META,
    inputSchema: {
      type: "object",
      properties: {
        saasCustomerId: SAAS_CUSTOMER_ID,
        seatId: { type: "string", description: "remoteId or mainId of the seat (from datto_saas_list_seats)." },
      },
      required: ["seatId"],
    },
  },
  {
    name: "datto_saas_list_applications",
    title: "Backup status per application",
    description:
      "Backup history per suite / application (Exchange, OneDrive, SharePoint, Teams, Gmail, Drive...) for a SaaS Protection customer, including per-window backup status. Optionally include remote IDs per seat type. GET /v1/saas/{saasCustomerId}/applications.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        saasCustomerId: SAAS_CUSTOMER_ID,
        daysUntil: {
          type: "number",
          description: "Days of backup history to include (Datto returns up to ~30).",
        },
        includeRemoteID: {
          type: "boolean",
          description: "Include remote IDs per seat type in the response.",
        },
      },
    },
  },
  {
    name: "datto_saas_get_backup_stats",
    title: "Detailed backup statistics",
    description:
      "Detailed backup statistics for a SaaS Protection customer (per-service last-7-day status, last backups, storage). GET /v1/saas/{saasCustomerId}/detailedBackupStats.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        saasCustomerId: SAAS_CUSTOMER_ID,
      },
    },
  },
  {
    name: "datto_saas_bulk_seat_change",
    title: "License / pause / unlicense seats",
    description:
      "WRITE. License, Pause or Unlicense up to 100 seats of one type for a customer subscription (Seat Management 2.0 tenants). Pause stops new backups; Unlicense stops protection; License starts protection and billing. Asks the user to confirm; on clients without confirmation prompts it requires confirm: true after explicit user approval. PUT /v1/saas/{saasCustomerId}/{externalSubscriptionId}/bulkSeatChange.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        saasCustomerId: { type: ["number", "string"], description: "saasCustomerId from datto_saas_list_domains." },
        externalSubscriptionId: {
          type: "string",
          description: "externalSubscriptionId from datto_saas_list_domains, e.g. Classic:Office365:123456.",
        },
        seatType: { type: "string", enum: [...SEAT_TYPES], description: "Seat type (case-sensitive)." },
        actionType: { type: "string", enum: [...SEAT_ACTION_TYPES], description: "Action (case-sensitive)." },
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_BULK_SEAT_IDS,
          description: "remoteId values of the seats to change (from datto_saas_list_seats).",
        },
        confirm: {
          type: "boolean",
          description: "Only for clients without confirmation prompts: set true after the user explicitly approved this exact change.",
        },
      },
      required: ["saasCustomerId", "externalSubscriptionId", "seatType", "actionType", "ids"],
    },
  },
];

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
    return { tools: TOOL_DEFINITIONS };
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
            "Interactive MCP Apps card rendering a protected seat's backup status",
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
    return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }] };
  }

  function fail(message: string) {
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }

  /**
   * Resolve a saasCustomerId: use the provided value, otherwise offer a
   * picker built from GET /saas/domains (when the client supports
   * elicitation). Returns null when nothing could be resolved.
   */
  async function resolveCustomerId(
    client: DattoSaasProtectionClient,
    provided: unknown
  ): Promise<string | null> {
    if (provided !== undefined && provided !== null && String(provided).trim() !== "") {
      return String(provided).trim();
    }
    try {
      const domains = await client.domains.list();
      if (domains.length === 0) return null;
      const seen = new Set<string>();
      const options: Array<{ value: string; label: string }> = [];
      for (const d of domains) {
        const id = String(d.saasCustomerId);
        if (seen.has(id)) continue;
        seen.add(id);
        const name = d.saasCustomerName ?? d.organizationName ?? id;
        options.push({ value: id, label: d.domain ? `${name} — ${d.domain} (${id})` : `${name} (${id})` });
        if (options.length >= 25) break;
      }
      return await elicitSelection("Select a SaaS Protection customer:", "saasCustomerId", options);
    } catch {
      return null;
    }
  }

  function clientCanElicit(): boolean {
    const caps = getServerRef()?.getClientCapabilities();
    return Boolean(caps?.elicitation);
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return fail(
        "No API credentials provided. Please configure DATTO_SAAS_PUBLIC_KEY + DATTO_SAAS_SECRET_KEY environment variables, or pass them as gateway headers."
      );
    }

    const client = createClient(creds);

    try {
      switch (name) {
        case "datto_saas_list_domains": {
          const domains = await client.domains.list();
          const q = typeof args.search === "string" ? args.search.trim().toLowerCase() : "";
          const filtered = q
            ? domains.filter((d) =>
                [d.saasCustomerName, d.domain, d.organizationName, d.externalSubscriptionId]
                  .filter((v): v is string => typeof v === "string")
                  .some((v) => v.toLowerCase().includes(q))
              )
            : domains;
          return json(filtered);
        }

        case "datto_saas_list_seats": {
          const customerId = await resolveCustomerId(client, args.saasCustomerId);
          if (!customerId) return fail("saasCustomerId is required (see datto_saas_list_domains).");
          const seatType =
            typeof args.seatType === "string" && args.seatType ? (args.seatType as SeatType) : undefined;
          let seats: SaasProtectionSeat[] = await client.seats.list(customerId, { seatType });
          if (typeof args.seatState === "string" && args.seatState) {
            const state = args.seatState.toLowerCase();
            seats = seats.filter((s) => String(s.seatState ?? "").toLowerCase() === state);
          }
          return json(seats);
        }

        case "datto_saas_get_seat": {
          const customerId = await resolveCustomerId(client, args.saasCustomerId);
          if (!customerId) return fail("saasCustomerId is required (see datto_saas_list_domains).");
          const seatId = typeof args.seatId === "string" ? args.seatId.trim() : "";
          if (!seatId) return fail("seatId is required (remoteId or mainId from datto_saas_list_seats).");
          const seats = await client.seats.list(customerId);
          const needle = seatId.toLowerCase();
          const seat = seats.find(
            (s) =>
              String(s.remoteId ?? "").toLowerCase() === needle ||
              String(s.mainId ?? "").toLowerCase() === needle
          );
          if (!seat) return fail(`No seat with remoteId/mainId "${seatId}" for customer ${customerId}.`);
          // MCP Apps: attach the normalized payload the ui:// seat card
          // renders from. Best-effort — any failure just means no UI surface,
          // never a failed tool result.
          let card = null;
          try {
            card = buildSeatCard(seat);
          } catch {
            /* card is progressive enhancement only */
          }
          return json(card ? { ...seat, _card: card } : seat);
        }

        case "datto_saas_list_applications": {
          const customerId = await resolveCustomerId(client, args.saasCustomerId);
          if (!customerId) return fail("saasCustomerId is required (see datto_saas_list_domains).");
          const daysUntil =
            typeof args.daysUntil === "number" && Number.isFinite(args.daysUntil)
              ? Math.max(0, Math.floor(args.daysUntil))
              : undefined;
          const includeRemoteID = typeof args.includeRemoteID === "boolean" ? args.includeRemoteID : undefined;
          return json(await client.applications.list(customerId, { daysUntil, includeRemoteID }));
        }

        case "datto_saas_get_backup_stats": {
          const customerId = await resolveCustomerId(client, args.saasCustomerId);
          if (!customerId) return fail("saasCustomerId is required (see datto_saas_list_domains).");
          return json(await client.applications.detailedBackupStats(customerId));
        }

        case "datto_saas_bulk_seat_change": {
          const customerId =
            args.saasCustomerId !== undefined && args.saasCustomerId !== null
              ? String(args.saasCustomerId).trim()
              : "";
          const externalSubscriptionId =
            typeof args.externalSubscriptionId === "string" ? args.externalSubscriptionId.trim() : "";
          const seatType = args.seatType as SeatType;
          const actionType = args.actionType as SeatActionType;
          const ids = Array.isArray(args.ids) ? args.ids.map((v) => String(v)) : [];
          if (!customerId) return fail("saasCustomerId is required.");
          if (!externalSubscriptionId) return fail("externalSubscriptionId is required (see datto_saas_list_domains).");
          if (!SEAT_TYPES.includes(seatType)) return fail(`seatType must be one of ${SEAT_TYPES.join(", ")} (case-sensitive).`);
          if (!SEAT_ACTION_TYPES.includes(actionType)) return fail(`actionType must be one of ${SEAT_ACTION_TYPES.join(", ")} (case-sensitive).`);
          if (ids.length === 0 || ids.length > MAX_BULK_SEAT_IDS) {
            return fail(`ids must contain between 1 and ${MAX_BULK_SEAT_IDS} remote seat IDs.`);
          }

          const summary =
            `About to ${actionType.toUpperCase()} ${ids.length} ${seatType} seat(s) for SaaS Protection customer ` +
            `${customerId} (subscription ${externalSubscriptionId}).\n\n` +
            (actionType === "License"
              ? "Licensed seats are backed up and billed."
              : actionType === "Pause"
                ? "Paused seats keep existing backups but STOP taking new backups."
                : "Unlicensed seats are NO LONGER PROTECTED (no new backups).") +
            "\n\nProceed?";

          if (clientCanElicit()) {
            const confirmed = await elicitConfirmation(summary);
            if (confirmed !== true) {
              return fail("Bulk seat change cancelled by user.");
            }
          } else if (args.confirm !== true) {
            return fail(
              "Bulk seat change not sent. This client cannot show a confirmation prompt; re-run with confirm: true only after the user has explicitly approved this exact change.\n\n" +
                summary
            );
          }

          const result = await client.seats.bulkChange(customerId, externalSubscriptionId, {
            seatType,
            actionType,
            ids,
          });
          return json(result);
        }

        default:
          return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(message);
    }
  });

  return server;
}
