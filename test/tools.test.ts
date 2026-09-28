/**
 * Handler-invocation tests for the tool call dispatcher in src/mcp-server.ts.
 *
 * Replaces the "Tool Definitions" / "Region validation" / "Credentials" /
 * "Server Configuration" blocks of test/index.test.ts, which asserted only
 * against locally-declared literal arrays/objects and never touched real
 * server code (the issue #73 regression block in that file is real and
 * stays as-is). Drives the real Server over a linked in-memory transport
 * (same pattern as test/mcp-apps.test.ts), mocking
 * @wyre-technology/node-datto-saas-protection so each test asserts the exact
 * outbound call shape and response transformation -- for every tool except
 * datto_saas_get_seat, whose request/response shape is already covered by
 * test/mcp-apps.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../src/mcp-server.js";
import { bindServerRef } from "../src/utils/server-ref.js";

const {
  mockClientsList,
  mockDomainsList,
  mockSeatsList,
  mockSeatsGet,
  mockBackupsList,
  mockRestoresQueue,
  mockRestoresGet,
  mockActivityList,
  mockLicenseGetUsage,
} = vi.hoisted(() => ({
  mockClientsList: vi.fn(),
  mockDomainsList: vi.fn(),
  mockSeatsList: vi.fn(),
  mockSeatsGet: vi.fn(),
  mockBackupsList: vi.fn(),
  mockRestoresQueue: vi.fn(),
  mockRestoresGet: vi.fn(),
  mockActivityList: vi.fn(),
  mockLicenseGetUsage: vi.fn(),
}));

vi.mock("@wyre-technology/node-datto-saas-protection", () => ({
  DattoSaasProtectionClient: class {
    clients = { list: mockClientsList };
    domains = { list: mockDomainsList };
    seats = { list: mockSeatsList, get: mockSeatsGet };
    backups = { list: mockBackupsList };
    restores = { queue: mockRestoresQueue, get: mockRestoresGet };
    activity = { list: mockActivityList };
    license = { getUsage: mockLicenseGetUsage };
  },
}));

const ALL_MOCKS = [
  mockClientsList,
  mockDomainsList,
  mockSeatsList,
  mockSeatsGet,
  mockBackupsList,
  mockRestoresQueue,
  mockRestoresGet,
  mockActivityList,
  mockLicenseGetUsage,
];

const CREDS = { publicKey: "public-key", secretKey: "secret-key", region: "us" as const };

async function connectClient(
  creds?: { publicKey: string; secretKey: string; region: "us" | "eu" }
): Promise<Client> {
  const server = createMcpServer(creds);
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

describe("tool surface", () => {
  it("exposes exactly the 9 documented tools", async () => {
    const client = await connectClient(CREDS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "datto_saas_list_clients",
        "datto_saas_list_domains",
        "datto_saas_list_seats",
        "datto_saas_get_seat",
        "datto_saas_list_backups",
        "datto_saas_queue_restore",
        "datto_saas_get_restore_status",
        "datto_saas_list_activity",
        "datto_saas_get_license_usage",
      ].sort()
    );
  });
});

describe("missing credentials", () => {
  it("returns an isError result instead of calling the API client", async () => {
    vi.stubEnv("DATTO_SAAS_PUBLIC_KEY", "");
    vi.stubEnv("DATTO_SAAS_SECRET_KEY", "");
    const client = await connectClient();
    const result = (await client.callTool({
      name: "datto_saas_list_clients",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No API credentials provided/);
    expect(mockClientsList).not.toHaveBeenCalled();
  });
});

describe("datto_saas_list_clients", () => {
  it("defaults limit to 100 and passes through the SDK response", async () => {
    mockClientsList.mockResolvedValue({ items: [{ id: "c1" }], pagination: {} });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_clients",
      arguments: {},
    })) as ToolResult;
    expect(mockClientsList).toHaveBeenCalledWith({ limit: 100 });
    expect(JSON.parse(text(result))).toEqual({ items: [{ id: "c1" }], pagination: {} });
  });

  it("forwards an explicit limit", async () => {
    mockClientsList.mockResolvedValue({ items: [], pagination: {} });
    const client = await connectClient(CREDS);
    await client.callTool({ name: "datto_saas_list_clients", arguments: { limit: 10 } });
    expect(mockClientsList).toHaveBeenCalledWith({ limit: 10 });
  });

  it("returns an isError result instead of throwing when the client rejects", async () => {
    mockClientsList.mockRejectedValue(new Error("upstream 500"));
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_clients",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: upstream 500");
  });
});

describe("datto_saas_list_domains", () => {
  it("forwards an explicit clientId to domains.list", async () => {
    mockDomainsList.mockResolvedValue({ items: [{ id: "d1" }], pagination: {} });
    const client = await connectClient(CREDS);
    await client.callTool({ name: "datto_saas_list_domains", arguments: { clientId: "c1" } });
    expect(mockDomainsList).toHaveBeenCalledWith("c1");
  });

  it("errors instead of calling the client when clientId is omitted and elicitation is unavailable", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_domains",
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: clientId is required.");
    expect(mockDomainsList).not.toHaveBeenCalled();
  });

  it("lists clients and resolves the picked clientId when elicitation is available", async () => {
    mockClientsList.mockResolvedValue({ items: [{ id: "c9", name: "Acme" }], pagination: {} });
    mockDomainsList.mockResolvedValue({ items: [], pagination: {} });
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { clientId: "c9" } });
    const result = (await client.callTool({
      name: "datto_saas_list_domains",
      arguments: {},
    })) as ToolResult;
    expect(mockClientsList).toHaveBeenCalledWith({ limit: 50 });
    expect(mockDomainsList).toHaveBeenCalledWith("c9");
    expect(result.isError).toBeFalsy();
  });
});

describe("datto_saas_list_seats", () => {
  it("forwards explicit includeArchived without prompting", async () => {
    mockSeatsList.mockResolvedValue({ items: [], pagination: {} });
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "datto_saas_list_seats",
      arguments: { clientId: "c1", domainId: "d1", includeArchived: true },
    });
    expect(mockSeatsList).toHaveBeenCalledWith("c1", "d1", { includeArchived: true });
  });

  it("defaults includeArchived to false when omitted and elicitation is unavailable", async () => {
    mockSeatsList.mockResolvedValue({ items: [], pagination: {} });
    const client = await connectClient(CREDS);
    await client.callTool({
      name: "datto_saas_list_seats",
      arguments: { clientId: "c1", domainId: "d1" },
    });
    expect(mockSeatsList).toHaveBeenCalledWith("c1", "d1", { includeArchived: false });
  });
});

describe("datto_saas_get_seat", () => {
  it("calls seats.get with the exact seat id", async () => {
    mockSeatsGet.mockResolvedValue({ id: "s1" });
    const client = await connectClient(CREDS);
    await client.callTool({ name: "datto_saas_get_seat", arguments: { seatId: "s1" } });
    expect(mockSeatsGet).toHaveBeenCalledWith("s1");
  });
});

describe("datto_saas_list_backups", () => {
  it("calls backups.list with the exact seat id", async () => {
    mockBackupsList.mockResolvedValue({ items: [{ id: "b1" }], pagination: {} });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_backups",
      arguments: { seatId: "s1" },
    })) as ToolResult;
    expect(mockBackupsList).toHaveBeenCalledWith("s1");
    expect(JSON.parse(text(result))).toEqual({ items: [{ id: "b1" }], pagination: {} });
  });
});

describe("datto_saas_queue_restore", () => {
  it("queues the restore when the user confirms", async () => {
    mockRestoresQueue.mockResolvedValue({ id: "r1", status: "queued" });
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: true } });
    const result = (await client.callTool({
      name: "datto_saas_queue_restore",
      arguments: { seatId: "s1", items: ["item1"] },
    })) as ToolResult;
    expect(mockRestoresQueue).toHaveBeenCalledWith("s1", { items: ["item1"] });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ id: "r1", status: "queued" });
  });

  it("cancels without calling the client when the user declines", async () => {
    const client = await connectElicitingClient(CREDS, { action: "accept", content: { confirm: false } });
    const result = (await client.callTool({
      name: "datto_saas_queue_restore",
      arguments: { seatId: "s1", items: ["item1"] },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Restore cancelled by user.");
    expect(mockRestoresQueue).not.toHaveBeenCalled();
  });

  it("cancels without calling the client when confirmation is unsupported", async () => {
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_queue_restore",
      arguments: { seatId: "s1", items: ["item1"] },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/does not support confirmation prompts/);
    expect(mockRestoresQueue).not.toHaveBeenCalled();
  });
});

describe("datto_saas_get_restore_status", () => {
  it("calls restores.get with the exact restore id", async () => {
    mockRestoresGet.mockResolvedValue({ id: "r1", status: "completed" });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_get_restore_status",
      arguments: { restoreId: "r1" },
    })) as ToolResult;
    expect(mockRestoresGet).toHaveBeenCalledWith("r1");
    expect(JSON.parse(text(result))).toEqual({ id: "r1", status: "completed" });
  });
});

describe("datto_saas_list_activity", () => {
  it("filters a mix of numeric (seconds/ms) and ISO-string timestamps by the given window", async () => {
    mockActivityList.mockResolvedValue({
      items: [
        { id: "before-numeric-seconds", createdAt: Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000) },
        { id: "in-window-numeric-seconds", createdAt: Math.floor(new Date("2026-01-03T00:00:00Z").getTime() / 1000) },
        { id: "in-window-numeric-ms", createdAt: new Date("2026-01-03T12:00:00Z").getTime() },
        { id: "in-window-iso-string", createdAt: "2026-01-03T06:00:00Z" },
        { id: "after-iso-string", createdAt: "2026-01-05T00:00:00Z" },
      ],
    });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_activity",
      arguments: { clientId: "c1", since: "2026-01-02T00:00:00Z", until: "2026-01-04T00:00:00Z" },
    })) as ToolResult;
    expect(mockActivityList).toHaveBeenCalledWith("c1");
    const ids = (JSON.parse(text(result)) as Array<{ id: string }>).map((a) => a.id).sort();
    expect(ids).toEqual(["in-window-iso-string", "in-window-numeric-ms", "in-window-numeric-seconds"].sort());
  });

  it("returns everything unfiltered when since/until are omitted and elicitation is unavailable", async () => {
    mockActivityList.mockResolvedValue({ items: [{ id: "a1" }, { id: "a2" }] });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_list_activity",
      arguments: { clientId: "c1" },
    })) as ToolResult;
    const ids = (JSON.parse(text(result)) as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(["a1", "a2"]);
  });
});

describe("datto_saas_get_license_usage", () => {
  it("calls license.getUsage with the exact client id", async () => {
    mockLicenseGetUsage.mockResolvedValue({ used: 10, total: 25 });
    const client = await connectClient(CREDS);
    const result = (await client.callTool({
      name: "datto_saas_get_license_usage",
      arguments: { clientId: "c1" },
    })) as ToolResult;
    expect(mockLicenseGetUsage).toHaveBeenCalledWith("c1");
    expect(JSON.parse(text(result))).toEqual({ used: 10, total: 25 });
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
