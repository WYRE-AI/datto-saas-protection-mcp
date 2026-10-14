/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Empty and known placeholders
 * refuse to listen. MCP_ALLOW_INSECURE_DEV=1 is the empty-secret bypass: it
 * binds 127.0.0.1 only, even when MCP_HTTP_HOST is a wider address.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to DATTO_SAAS_* in process.env.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DattoSaasCredentials } from "../credentials.js";

const getCredentialsMock = vi.hoisted(() => vi.fn());
const createClientMock = vi.hoisted(() => vi.fn());

vi.mock("../credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials.js")>();
  return {
    ...actual,
    getCredentials: getCredentialsMock,
    createClient: createClientMock,
  };
});

import { startHttpTransport } from "../index.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_PUBLIC_KEY = "env-public-key-must-not-be-used";
const ENV_SECRET_KEY = "env-secret-key-must-not-be-used";
const HEADER_PUBLIC_KEY = "header-public-key";
const HEADER_SECRET_KEY = "header-secret-key-do-not-log";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "DATTO_SAAS_PUBLIC_KEY",
  "DATTO_SAAS_SECRET_KEY",
  "DATTO_SAAS_REGION",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

let logs: string[] = [];

function logText(): string {
  return logs.join("\n");
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function boundAddress(server: Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return address;
}

async function listen(): Promise<Server> {
  const server = await startHttpTransport();
  servers.push(server);
  return server;
}

/** Invalid-secret startup rejects. Callers can catch it; the process does not exit. */
async function rejectedStartup(): Promise<Error> {
  try {
    await startHttpTransport();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("startHttpTransport() resolved");
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

const domainsCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "datto_saas_list_domains", arguments: {} },
});

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });

  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.DATTO_SAAS_PUBLIC_KEY;
  delete process.env.DATTO_SAAS_SECRET_KEY;
  delete process.env.DATTO_SAAS_REGION;
  delete process.env.MCP_TRANSPORT;

  getCredentialsMock.mockReset();
  getCredentialsMock.mockImplementation(() => {
    throw new Error("getCredentials must not be used for HTTP auth tests");
  });
  createClientMock.mockReset();
  createClientMock.mockImplementation((creds: DattoSaasCredentials) => ({
    domains: {
      list: async () => [{ saasCustomerId: 1, saasCustomerName: "from-client", via: creds.publicKey }],
    },
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const error = await rejectedStartup();
    expect(error.message).toContain("Refusing to start HTTP transport");
    expect(error.message).toContain("CONDUIT_S2S_SECRET is empty");
    expect(error.message).not.toContain(S2S_SECRET);
    expect(logText()).not.toContain(S2S_SECRET);
  });

  it("refuses to start when CONDUIT_S2S_SECRET is whitespace", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const error = await rejectedStartup();
    expect(error.message).toContain("CONDUIT_S2S_SECRET is empty");
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const error = await rejectedStartup();
    expect(error.message).toContain("Refusing to start HTTP transport");
  });

  it.each(["changeme", "ChangeMe", "secret", "replace-me", "your-s2s-secret", "replace-with-a-real-secret"])(
    "refuses known placeholder %s even when the dev bypass is set",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = `  ${placeholder}  `;
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      const error = await rejectedStartup();
      expect(error.message).toContain("Refusing to start HTTP transport");
      expect(error.message).toContain("known placeholder");
      const redacted = error.message.replaceAll("CONDUIT_S2S_SECRET", "").replaceAll("Generate a secret", "");
      expect(redacted.toLowerCase()).not.toContain(placeholder.toLowerCase());
      expect(error.message).not.toContain("SECURITY WARNING");
      expect(logText()).not.toContain(placeholder);
    }
  );

  it("refuses an unresolved ${...} placeholder", async () => {
    process.env.CONDUIT_S2S_SECRET = "${user_config.conduit_s2s_secret}";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const error = await rejectedStartup();
    expect(error.message).toContain("known placeholder");
    expect(error.message).not.toContain("${user_config.conduit_s2s_secret}");
    expect(logText()).not.toContain("${user_config.conduit_s2s_secret}");
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const server = await listen();
    expect(boundAddress(server).address).toBe("127.0.0.1");
    const text = logText();
    expect(text).toContain("SECURITY WARNING");
    expect(text).toContain("CONDUIT_S2S_SECRET");
    expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
    expect(text).toContain("loopback");
    expect(text).not.toContain(S2S_SECRET);
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const server = await listen();
      expect(boundAddress(server).address).toBe("127.0.0.1");
      const text = logText();
      expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
      expect(text).toContain("Binding 127.0.0.1 only");
      expect(text).toContain("SECURITY WARNING");
      expect(text).not.toContain(S2S_SECRET);
    }
  );

  it("binds 127.0.0.1 for a loopback dev host without the override warning", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const server = await listen();
    expect(boundAddress(server).address).toBe("127.0.0.1");
    expect(logText()).toContain("SECURITY WARNING");
    expect(logText()).not.toContain("not a loopback address");
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const server = await listen();
    expect(boundAddress(server).address).toBe("0.0.0.0");
    expect(logText()).not.toContain("not a loopback address");
    expect(logText()).not.toContain(S2S_SECRET);
  });

  it("binds 127.0.0.1 when MCP_HTTP_HOST is unset and a secret is set", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(boundAddress(server).address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.DATTO_SAAS_PUBLIC_KEY = ENV_PUBLIC_KEY;
    process.env.DATTO_SAAS_SECRET_KEY = ENV_SECRET_KEY;
    process.env.DATTO_SAAS_REGION = "eu";
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const server = await listen();
    const port = boundAddress(server).port;

    const missing = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(),
      body: domainsCall,
    });
    const invalid = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader("wrong-secret") }),
      body: domainsCall,
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(missing.body).toContain("X-Gateway-S2S");
    expect(invalid.body).toContain("X-Gateway-S2S");
    expect(missing.body).not.toContain(S2S_SECRET);
    expect(invalid.body).not.toContain(S2S_SECRET);
    expect(missing.body).not.toContain(ENV_PUBLIC_KEY);
    expect(logText()).not.toContain(S2S_SECRET);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const port = boundAddress(server).port;

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: domainsCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("Missing credentials");
    expect(response.body).toContain("X-Datto-SaaS-Public-Key");
    expect(response.body).not.toContain(ENV_PUBLIC_KEY);
    expect(response.body).not.toContain(ENV_SECRET_KEY);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-datto-saas-public-key": HEADER_PUBLIC_KEY,
      }),
      body: domainsCall,
    });
    expect(partial.status).toBe(401);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const server = await listen();
    const port = boundAddress(server).port;

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-datto-saas-public-key": HEADER_PUBLIC_KEY,
        "x-datto-saas-secret-key": HEADER_SECRET_KEY,
        "x-datto-saas-region": "eu",
      }),
      body: domainsCall,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain(HEADER_PUBLIC_KEY);
    expect(response.body).not.toContain(HEADER_SECRET_KEY);
    expect(response.body).not.toContain(ENV_PUBLIC_KEY);
    expect(response.body).not.toContain(ENV_SECRET_KEY);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(logText()).not.toContain(S2S_SECRET);
    expect(logText()).not.toContain(HEADER_SECRET_KEY);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(createClientMock).toHaveBeenCalledWith({
      publicKey: HEADER_PUBLIC_KEY,
      secretKey: HEADER_SECRET_KEY,
      region: "eu",
    });
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    const port = boundAddress(server).port;

    const response = await sendHttp({
      port,
      method: "GET",
      path: "/health",
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; authMode?: string };
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_PUBLIC_KEY);
    expect(getCredentialsMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("does not enforce X-Gateway-S2S when the dev bypass is on", async () => {
    delete process.env.CONDUIT_S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const server = await listen();
    const port = boundAddress(server).port;

    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(),
      body: domainsCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain("Missing credentials");
    expect(response.body).not.toContain("X-Gateway-S2S");
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });
});
