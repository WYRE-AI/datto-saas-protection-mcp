#!/usr/bin/env node
/**
 * Datto SaaS Protection MCP Server
 *
 * This MCP server provides tools for interacting with the Datto SaaS
 * Protection (Backupify) API. It accepts credentials via environment
 * variables (env mode) or per-request HTTP headers (gateway mode).
 *
 * Supports both stdio (default) and HTTP (StreamableHTTP) transports.
 * The server factory itself lives in mcp-server.ts (side-effect free, so
 * tests can drive it directly); this entrypoint only wires up transports.
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is a real
 * secret. Known placeholders are rejected. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, does not
 * enforce X-Gateway-S2S, and listens on 127.0.0.1 only. A configured secret
 * honors MCP_HTTP_HOST (default 127.0.0.1 when unset). Gateway mode rejects
 * /mcp requests that omit credential headers and does not fall back to
 * DATTO_SAAS_* env vars. /health stays unauthenticated. stdio does not use
 * S2S auth.
 */

import { createServer, IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { cleanCredential, type DattoSaasCredentials } from "./credentials.js";
import { createMcpServer } from "./mcp-server.js";
import { bindServerRef, runWithServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/** Bind used when MCP_HTTP_HOST is unset, and the only bind the dev bypass allows. */
const LOOPBACK_HOST = "127.0.0.1";

/**
 * Public example values. A copied placeholder must not verify as a real secret.
 * Comparison is case-insensitive after trim. Unresolved ${...} config templates
 * are rejected too.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

function refuseStart(message: string): never {
  console.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, localhost, and ::1, including a bracketed IPv6 form. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV is exactly "1". A known
 * placeholder is refused even when that flag is set. The secret is never logged.
 */
function resolveHttpS2sSecret(): string {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && (KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase()) || CONFIG_PLACEHOLDER.test(raw))) {
    refuseStart(
      "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
        "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value."
    );
  }
  if (raw) return raw;
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") return "";
  refuseStart(
    "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
      "Set CONDUIT_S2S_SECRET, or set MCP_ALLOW_INSECURE_DEV=1 for local development only."
  );
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST is overridden
 * and logged. A configured secret honors MCP_HTTP_HOST; unset stays loopback.
 */
function resolveBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || LOOPBACK_HOST;
  if (configured && !isLoopbackBindHost(configured)) {
    console.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default)
// ---------------------------------------------------------------------------

async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session for the whole process — no concurrent tenants
  // to isolate from each other, so enterWith's process-lifetime binding is
  // safe.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Datto SaaS Protection MCP server running on stdio");
}

// ---------------------------------------------------------------------------
// Transport: HTTP (StreamableHTTPServerTransport)
// ---------------------------------------------------------------------------

let httpServer: HttpServer | undefined;

export async function startHttpTransport(): Promise<HttpServer> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const s2sSecret = resolveHttpS2sSecret();
  const host = resolveBindHost(s2sSecret);
  if (!s2sSecret) {
    console.error(
      "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
        `HTTP /mcp is not enforcing X-Gateway-S2S and is limited to loopback (${host}). ` +
        "Do not use this outside local development."
    );
  }
  const authMode = process.env.AUTH_MODE || "env";
  const isGatewayMode = authMode === "gateway";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint — liveness only. No auth and no credential reads.
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
      // A configured secret is always enforced, before any credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
        return;
      }

      // In gateway mode, extract credentials from headers and pass directly
      // to avoid process.env race conditions under concurrent load.
      let gatewayCredentials: DattoSaasCredentials | undefined;
      if (isGatewayMode) {
        const publicKey = cleanCredential(headerValue(req.headers["x-datto-saas-public-key"]));
        const secretKey = cleanCredential(headerValue(req.headers["x-datto-saas-secret-key"]));
        // Strip an unresolved placeholder before the "us" fallback (issue #73).
        const region = cleanCredential(headerValue(req.headers["x-datto-saas-region"])) || "us";

        if (!publicKey || !secretKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message:
                "Gateway mode requires X-Datto-SaaS-Public-Key and X-Datto-SaaS-Secret-Key headers (X-Datto-SaaS-Region optional, defaults to 'us')",
              required: ["X-Datto-SaaS-Public-Key", "X-Datto-SaaS-Secret-Key"],
            })
          );
          return;
        }

        gatewayCredentials = { publicKey, secretKey, region };
      }

      // Stateless: fresh server + transport per request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      // The whole chain below (connect through the catch handler) runs
      // inside runWithServerRef so the server-ref binding — used by
      // elicitation (elicitConfirmation/elicitSelection/elicitText) —
      // survives every await gap in this request's lifecycle without
      // leaking into a concurrent request's server-ref.
      runWithServerRef(server, () =>
        server
          .connect(transport as unknown as Transport)
          .then(() => {
            transport.handleRequest(req, res);
          })
          .catch((err) => {
            console.error("MCP transport error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32603, message: "Internal error" },
                  id: null,
                })
              );
            }
          })
      );

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  httpServer = server;

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      console.error(`Datto SaaS Protection MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return server;
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(): void {
  const shutdown = async () => {
    console.error("Shutting down Datto SaaS Protection MCP server...");
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }

  setupShutdownHandlers();
}

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
