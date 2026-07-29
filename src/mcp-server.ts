/**
 * Shared MCP server factory for Datto SaaS Protection.
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
import type { DattoSaasProtectionClient } from "@wyre-technology/node-datto-saas-protection";
import { elicitConfirmation, elicitSelection, elicitText } from "./utils/elicitation.js";
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
          description: "List all customer organizations protected by Datto SaaS Protection.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max results (default: 100)", default: 100 },
            },
          },
        },
        {
          name: "datto_saas_list_domains",
          description:
            "List protected domains under a client. If clientId is omitted, the user will be prompted to pick one.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier (optional — will elicit if omitted)" },
            },
          },
        },
        {
          name: "datto_saas_list_seats",
          description:
            "List seats (mailboxes/users) in a domain. Toggle includeArchived to see deactivated seats.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier" },
              domainId: { type: "string", description: "Domain identifier" },
              includeArchived: {
                type: "boolean",
                description: "Include archived seats (optional — will elicit if omitted)",
              },
            },
            required: ["clientId", "domainId"],
          },
        },
        {
          name: "datto_saas_get_seat",
          description: "Get details for a single seat by ID.",
          _meta: SEAT_CARD_META,
          inputSchema: {
            type: "object",
            properties: {
              seatId: { type: "string", description: "Seat identifier" },
            },
            required: ["seatId"],
          },
        },
        {
          name: "datto_saas_list_backups",
          description: "List backup runs / snapshots for a seat.",
          inputSchema: {
            type: "object",
            properties: {
              seatId: { type: "string", description: "Seat identifier" },
            },
            required: ["seatId"],
          },
        },
        {
          name: "datto_saas_queue_restore",
          description:
            "Queue a restore for a seat. DESTRUCTIVE: writes data back into the target tenant. The destination user must have appropriate Microsoft Graph / Google API permissions for the restore to land. Requires explicit confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              seatId: { type: "string", description: "Seat identifier to restore from" },
              items: {
                type: "array",
                description: "Items (folder/message/file IDs) to restore. Pass an empty array to restore the entire seat.",
                items: { type: "string" },
              },
            },
            required: ["seatId", "items"],
          },
        },
        {
          name: "datto_saas_get_restore_status",
          description: "Check the status / progress of a queued restore.",
          inputSchema: {
            type: "object",
            properties: {
              restoreId: { type: "string", description: "Restore job identifier" },
            },
            required: ["restoreId"],
          },
        },
        {
          name: "datto_saas_list_activity",
          description:
            "List activity log entries for a client. If date range is omitted, the user will be prompted.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier" },
              since: { type: "string", description: "ISO 8601 start datetime (optional)" },
              until: { type: "string", description: "ISO 8601 end datetime (optional)" },
            },
            required: ["clientId"],
          },
        },
        {
          name: "datto_saas_get_license_usage",
          description: "Get license usage / seat counts vs purchased for a client.",
          inputSchema: {
            type: "object",
            properties: {
              clientId: { type: "string", description: "Client identifier" },
            },
            required: ["clientId"],
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

  const DATE_FILTER_PAGE_CAP = 2000;

  interface DateRangeMs {
    sinceMs?: number;
    untilMs?: number;
  }

  function normalizeTs(raw: number): number {
    return raw < 1e12 ? raw * 1000 : raw;
  }

  function filterByDate<T extends { createdAt?: number | string; timestamp?: number | string }>(
    items: T[],
    range: DateRangeMs
  ): T[] {
    const sinceMs = range.sinceMs ?? -Infinity;
    const untilMs = range.untilMs ?? Infinity;
    const out: T[] = [];
    for (const item of items) {
      const raw = item.createdAt ?? item.timestamp;
      if (raw != null) {
        const numeric = typeof raw === "string" ? Date.parse(raw) : normalizeTs(raw);
        if (!Number.isNaN(numeric) && (numeric < sinceMs || numeric > untilMs)) continue;
      }
      out.push(item);
      if (out.length >= DATE_FILTER_PAGE_CAP) break;
    }
    return out;
  }

  async function resolveDateRange(
    args: { since?: string; until?: string }
  ): Promise<DateRangeMs> {
    if (args.since || args.until) {
      return {
        sinceMs: args.since ? new Date(args.since).getTime() : undefined,
        untilMs: args.until ? new Date(args.until).getTime() : undefined,
      };
    }

    const choice = await elicitSelection(
      "No date range provided. This query can return many results. Choose a window:",
      "range",
      [
        { value: "24h", label: "Last 24 hours" },
        { value: "7d", label: "Last 7 days" },
        { value: "30d", label: "Last 30 days" },
        { value: "custom", label: "Enter custom ISO 8601 dates" },
        { value: "all", label: "No filter (return everything)" },
      ]
    );

    const nowMs = Date.now();
    const PRESET_WINDOWS_MS: Record<string, number> = {
      "24h": 24 * 60 * 60 * 1000,
      "7d": 7 * 24 * 60 * 60 * 1000,
      "30d": 30 * 24 * 60 * 60 * 1000,
    };
    if (!choice || choice === "all") return {};
    if (choice in PRESET_WINDOWS_MS) {
      return { sinceMs: nowMs - PRESET_WINDOWS_MS[choice] };
    }
    if (choice === "custom") {
      const since = await elicitText(
        "Enter the start datetime in ISO 8601 format (e.g. 2025-04-01T00:00:00Z).",
        "since",
        "Start datetime"
      );
      const until = await elicitText(
        "Enter the end datetime in ISO 8601 format (leave blank for now).",
        "until",
        "End datetime"
      );
      return {
        sinceMs: since ? new Date(since).getTime() : undefined,
        untilMs: until ? new Date(until).getTime() : undefined,
      };
    }
    return {};
  }

  async function resolveClientId(
    client: DattoSaasProtectionClient,
    provided?: string
  ): Promise<string | null> {
    if (provided) return provided;

    try {
      const result = await client.clients.list({ limit: 50 });
      const items: Array<{ id: string; name?: string }> = Array.isArray(
        (result as { items?: unknown }).items
      )
        ? ((result as { items: Array<{ id: string; name?: string }> }).items)
        : (Array.isArray(result) ? (result as Array<{ id: string; name?: string }>) : []);

      if (items.length === 0) return null;

      const options = items.slice(0, 25).map((c) => ({
        value: c.id,
        label: c.name ? `${c.name} (${c.id})` : c.id,
      }));
      const picked = await elicitSelection(
        "Select a client:",
        "clientId",
        options
      );
      return picked;
    } catch {
      return null;
    }
  }

  async function resolveIncludeArchived(provided?: boolean): Promise<boolean> {
    if (provided !== undefined) return provided;

    const choice = await elicitSelection(
      "Include archived (deactivated) seats?",
      "includeArchived",
      [
        { value: "false", label: "No — only active seats" },
        { value: "true", label: "Yes — include archived" },
      ]
    );
    return choice === "true";
  }

  // -------------------------------------------------------------------------
  // Tool call handler
  // -------------------------------------------------------------------------

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const creds = credentialOverrides ?? getCredentials();

    if (!creds) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error: No API credentials provided. Please configure DATTO_SAAS_PUBLIC_KEY + DATTO_SAAS_SECRET_KEY (and optionally DATTO_SAAS_REGION) environment variables, or pass them as gateway headers.",
          },
        ],
        isError: true,
      };
    }

    const client = createClient(creds);

    try {
      switch (name) {
        case "datto_saas_list_clients": {
          const params = (args ?? {}) as { limit?: number };
          const result = await client.clients.list({ limit: params.limit ?? 100 });
          return { content: [{ type: "text", text: JSON.stringify(result ?? [], null, 2) }] };
        }

        case "datto_saas_list_domains": {
          const params = (args ?? {}) as { clientId?: string };
          const clientId = await resolveClientId(client, params.clientId);
          if (!clientId) {
            return {
              content: [{ type: "text", text: "Error: clientId is required." }],
              isError: true,
            };
          }
          const domains = await client.domains.list(clientId);
          return { content: [{ type: "text", text: JSON.stringify(domains ?? [], null, 2) }] };
        }

        case "datto_saas_list_seats": {
          const params = (args ?? {}) as {
            clientId: string;
            domainId: string;
            includeArchived?: boolean;
          };
          const includeArchived = await resolveIncludeArchived(params.includeArchived);
          const seats = await client.seats.list(params.clientId, params.domainId, {
            includeArchived,
          });
          return { content: [{ type: "text", text: JSON.stringify(seats ?? [], null, 2) }] };
        }

        case "datto_saas_get_seat": {
          const { seatId } = args as { seatId: string };
          const seat = await client.seats.get(seatId);
          // MCP Apps: attach the normalized payload the ui:// seat card
          // renders from. Best-effort — any failure just means no UI surface,
          // never a failed tool result.
          let card = null;
          try {
            card = buildSeatCard(seat);
          } catch {
            /* card is progressive enhancement only */
          }
          const payload = card ? { ...seat, _card: card } : seat;
          return { content: [{ type: "text", text: JSON.stringify(payload ?? {}, null, 2) }] };
        }

        case "datto_saas_list_backups": {
          const { seatId } = args as { seatId: string };
          const backups = await client.backups.list(seatId);
          return { content: [{ type: "text", text: JSON.stringify(backups ?? [], null, 2) }] };
        }

        case "datto_saas_queue_restore": {
          const { seatId, items } = args as { seatId: string; items: string[] };
          const confirmed = await elicitConfirmation(
            `About to QUEUE A RESTORE for seat ${seatId} (${items.length} item(s)).\n\n` +
              "This writes data back into the target M365/GWS tenant. " +
              "The destination user must have appropriate Microsoft Graph / Google API permissions " +
              "for the restore to land successfully.\n\nProceed?"
          );
          if (confirmed !== true) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    confirmed === null
                      ? "Restore cancelled: client does not support confirmation prompts. Pass an explicit confirm flag from a different client to proceed."
                      : "Restore cancelled by user.",
                },
              ],
              isError: true,
            };
          }
          const restore = await client.restores.queue(seatId, { items });
          return { content: [{ type: "text", text: JSON.stringify(restore ?? {}, null, 2) }] };
        }

        case "datto_saas_get_restore_status": {
          const { restoreId } = args as { restoreId: string };
          const status = await client.restores.get(restoreId);
          return { content: [{ type: "text", text: JSON.stringify(status ?? {}, null, 2) }] };
        }

        case "datto_saas_list_activity": {
          const params = (args ?? {}) as { clientId: string; since?: string; until?: string };
          const range = await resolveDateRange(params);
          const activity = await client.activity.list(params.clientId);
          const list: Array<{ createdAt?: number | string; timestamp?: number | string }> =
            Array.isArray((activity as { items?: unknown }).items)
              ? ((activity as { items: Array<{ createdAt?: number | string; timestamp?: number | string }> }).items)
              : (Array.isArray(activity)
                  ? (activity as Array<{ createdAt?: number | string; timestamp?: number | string }>)
                  : []);
          const filtered = filterByDate(list, range);
          return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
        }

        case "datto_saas_get_license_usage": {
          const { clientId } = args as { clientId: string };
          const license = await client.license.getUsage(clientId);
          return { content: [{ type: "text", text: JSON.stringify(license ?? {}, null, 2) }] };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
