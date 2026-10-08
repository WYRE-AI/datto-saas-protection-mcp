/**
 * Handler-invocation tests for the tool call dispatcher in src/mcp-server.ts.
 *
 * Drives the real Server over a linked in-memory transport (same pattern as
 * test/mcp-apps.test.ts), mocking the SDK client so each test asserts the
 * exact outbound call shape -- for every tool except datto_saas_get_seat,
 * whose request/response shape is covered by test/mcp-apps.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp-server.js";
import { bindServerRef } from "../src/utils/server-ref.js";

const {
  mockDomainsList,
  mockSeatsList,
  mockSeatsBulkChange,
  mockApplicationsList,
  mockBackupStats,
} = vi.hoisted(() => ({
  mockDomainsList: vi.fn(),
  mockSeatsList: vi.fn(),
  mockSeatsBulkChange: vi.fn(),
  mockApplicationsList: vi.fn(),
  mockBackupStats: vi.fn(),
}));

vi.mock("@wyre-ai/node-datto-saas-protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wyre-ai/node-datto-saas-protection")>();
  return {
    ...actual,
    DattoSaasProtectionClient: class {
      domains = { list: mockDomainsList };
      seats = { list: mockSeatsList, bulkChange: mockSeatsBulkChange };
      applications = { list: mockApplicationsList, detailedBackupStats: mockBackupStats };
    },
  };
});

const ALL_MOCKS = [
  mockDomainsList,
  mockSeatsList,
  mockSeatsBulkChange,
  mockApplicationsList,
  mockBackupStats,
];

const CREDS = { publicKey: "public-key", secretKey: "secret-key", region: "us" as const };

async function connectClient(
  creds?: { publicKey: string; secretKey: string; region: "us" | "eu" }
): Promise<Client> {
  // Bind the server ref exactly like the real stdio/HTTP entrypoints do, so
  // "elicitation unavailable" tests exercise the real reason it's
  // unavailable -- the connected client not declaring the capability --
  // rather than accidentally testing a ref that was never bound at all.
  const server = createMcpServer(creds);
  bindServerRef(server);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** A Client that declares elicitation support and answers every prompt with a fixed response. */
async function connectElicitingClient(
  creds: { publicKey: string; secretKey: string; region: "us" | "eu" },
  response: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }
): Promise<Client> {
  const server = createMcpServer(creds);
  bindServerRef(server);
  const client = new Client(
    { name: "test-host", version: "0.0.0" },
    { capabilities: { elicitation: { form: {} } } }
  );
  client.setRequestHandler(ElicitRequestSchema, async () => response);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

function text(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const m of ALL_MOCKS) m.mockReset();
});

const DOMAINS = [
  {
    saasCustomerId: 1001,
    saasCustomerName: "Acme Co",
    domain: "acme.com",
    productType: "Office365",
    externalSubscriptionId: "Classic:Office365:1001",
  },
  {
    saasCustomerId: 1002,
    saasCustomerName: "Beta Inc",
    domain: "beta.io",
    productType: "GoogleApps",
    externalSubscriptionId: "Classic:GoogleApps:1002",
  },
];

const EXPECTED_TOOLS = [
  "datto_saas_list_domains",
  "datto_saas_list_seats",
  "datto_saas_get_seat",
  "datto_saas_list_applications",
  "datto_saas_get_backup_stats",
  "datto_saas_bulk_seat_change",
];

describe("tool surface", () => {
  it("exposes exactly the documented-API tools", async () => {
    const client = await connectClient(CREDS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("annotates every read tool readOnly and bulk_seat_change as a destructive write", async () => {
    const client = await connectClient(CREDS);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (tool.name === "datto_saas_bulk_seat_change") {
        expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      } else {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
    }
  });
});

describe("missing credentials", () => {
  it("returns an isError result instead of calling the API client", async () => {
    vi.stubEnv("DATTO_SAAS_PUBLIC_KEY", "");
    vi.stubEnv("DATTO_SAAS_SECRET_KEY", "");
    const client = await connectClient();
    const result = (await client.callTool({
      name: "datto_saas_list_domains",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No API credentials provided/);
    expect(mockDomainsList).not.toHaveBeenCalled();
  });
});

describe("datto_saas_list_domains", () => {
  it("passes through GET /saas/domains", async () => {
    mockDomainsList.mockResolvedValue(DOMAINS);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({ name: "datto_saas_list_domains", arguments: {} })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual(DOMAINS);
  });

  it("filters by search across name/domain/subscription", async () => {
    mockDomainsList.mockResolvedValue(DOMAINS);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_domains",
      arguments: { search: "GOOGLEAPPS" },
    })) as ToolResult;
    expect(JSON.parse(text(result)).map((d: { saasCustomerId: number }) => d.saasCustomerId)).toEqual([1002]);
  });

  it("returns an isError result instead of throwing when the client rejects", async () => {
    mockDomainsList.mockRejectedValue(new Error("Authentication failed (401)"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({ name: "datto_saas_list_domains", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: Authentication failed (401)");
  });
});

describe("datto_saas_list_seats", () => {
  it("forwards saasCustomerId and seatType", async () => {
    mockSeatsList.mockResolvedValue([{ remoteId: "r1", seatType: "User", seatState: "Active" }]);
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "datto_saas_list_seats",
      arguments: { saasCustomerId: 1001, seatType: "User" },
    });
    expect(mockSeatsList).toHaveBeenCalledWith("1001", { seatType: "User" });
  });

  it("filters by seatState case-insensitively", async () => {
    mockSeatsList.mockResolvedValue([
      { remoteId: "r1", seatState: "Active" },
      { remoteId: "r2", seatState: "Paused" },
    ]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_seats",
      arguments: { saasCustomerId: "1001", seatState: "paused" },
    })) as ToolResult;
    expect(JSON.parse(text(result))).toEqual([{ remoteId: "r2", seatState: "Paused" }]);
  });

  it("errors without calling seats.list when saasCustomerId is omitted and elicitation is unavailable", async () => {
    mockDomainsList.mockResolvedValue(DOMAINS);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({ name: "datto_saas_list_seats", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/saasCustomerId is required/);
    expect(mockSeatsList).not.toHaveBeenCalled();
  });

  it("surfaces a vendor error from the customer picker instead of a missing-id message", async () => {
    mockDomainsList.mockRejectedValue(new Error("Authentication failed (401)"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({ name: "datto_saas_list_seats", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: Authentication failed (401)");
    expect(mockSeatsList).not.toHaveBeenCalled();
  });

  it("offers a customer picker from /saas/domains when elicitation is available", async () => {
    mockDomainsList.mockResolvedValue(DOMAINS);
    mockSeatsList.mockResolvedValue([]);
    const client = await connectElicitingClient(CREDS, {
      action: "accept",
      content: { saasCustomerId: "1002" },
    });
    const result = (await client.callTool({ name: "datto_saas_list_seats", arguments: {} })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(mockSeatsList).toHaveBeenCalledWith("1002", { seatType: undefined });
  });
});

describe("datto_saas_list_applications", () => {
  it("forwards daysUntil (floored) and includeRemoteID", async () => {
    mockApplicationsList.mockResolvedValue([{ customerId: 1001, suites: [] }]);
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_applications",
      arguments: { saasCustomerId: 1001, daysUntil: 7.9, includeRemoteID: true },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(mockApplicationsList).toHaveBeenCalledWith("1001", { daysUntil: 7, includeRemoteID: true });
  });
});

describe("datto_saas_get_backup_stats", () => {
  it("calls detailedBackupStats with the customer id", async () => {
    mockBackupStats.mockResolvedValue({ tenantId: "t" });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_get_backup_stats",
      arguments: { saasCustomerId: 1001 },
    })) as ToolResult;
    expect(mockBackupStats).toHaveBeenCalledWith("1001");
    expect(JSON.parse(text(result))).toEqual({ tenantId: "t" });
  });
});

describe("datto_saas_bulk_seat_change", () => {
  const ARGS = {
    saasCustomerId: 1001,
    externalSubscriptionId: "Classic:Office365:1001",
    seatType: "User",
    actionType: "Pause",
    ids: ["r1", "r2"],
  };

  it("sends the change when the user confirms via elicitation", async () => {
    mockSeatsBulkChange.mockResolvedValue([{ id: 1, status: "success" }]);
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: true } });
    const result = (await client.callTool({ name: "datto_saas_bulk_seat_change", arguments: ARGS })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(mockSeatsBulkChange).toHaveBeenCalledWith("1001", "Classic:Office365:1001", {
      seatType: "User",
      actionType: "Pause",
      ids: ["r1", "r2"],
    });
  });

  it("cancels when the user answers confirm false", async () => {
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: false } });
    const result = (await client.callTool({ name: "datto_saas_bulk_seat_change", arguments: ARGS })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/cancelled/);
    expect(mockSeatsBulkChange).not.toHaveBeenCalled();
  });

  it("cancels when the user declines the prompt, even if confirm: true was passed", async () => {
    const client = await connectElicitingClient(CREDS, { action: "decline" });
    const result = (await client.callTool({
      name: "datto_saas_bulk_seat_change",
      arguments: { ...ARGS, confirm: true },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(mockSeatsBulkChange).not.toHaveBeenCalled();
  });

  it("without elicitation, refuses unless confirm: true is passed", async () => {
    const client = await connectClient(CREDS);
    const refused = (await client.callTool({ name: "datto_saas_bulk_seat_change", arguments: ARGS })) as ToolResult;
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/confirm: true/);
    expect(mockSeatsBulkChange).not.toHaveBeenCalled();

    mockSeatsBulkChange.mockResolvedValue([]);
    const sent = (await client.callTool({
      name: "datto_saas_bulk_seat_change",
      arguments: { ...ARGS, confirm: true },
    })) as ToolResult;
    expect(sent.isError).toBeFalsy();
    expect(mockSeatsBulkChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ seatType: "user" }, /seatType/],
    [{ actionType: "pause" }, /actionType/],
    [{ ids: [] }, /between 1 and 100/],
    [{ ids: Array.from({ length: 101 }, (_, i) => `r${i}`) }, /between 1 and 100/],
    [{ ids: [null] }, /non-empty string/],
    [{ ids: [" "] }, /non-empty string/],
    [{ ids: [1] }, /non-empty string/],
    [{ externalSubscriptionId: "" }, /externalSubscriptionId/],
  ])("validates %o before prompting", async (override, pattern) => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_bulk_seat_change",
      arguments: { ...ARGS, ...override, confirm: true },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(pattern);
    expect(mockSeatsBulkChange).not.toHaveBeenCalled();
  });
});

describe("unknown tool", () => {
  it("returns an isError result naming the unknown tool", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_not_a_real_tool",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Unknown tool: datto_saas_not_a_real_tool");
  });
});
