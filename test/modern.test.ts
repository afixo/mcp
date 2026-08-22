/**
 * The same surface through the official MCP SDK v2 client — the 2026-07-28 protocol (no
 * initialize handshake, a per-request envelope) — with the client's fetch routed into the Worker.
 * test/mcp.test.ts covers the 2025-era lane most hosts still speak; this covers the modern one.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { ALLOW, MCP, TOKEN, call, envWith, fakeApi, machineApi } from "./helpers";

async function connect(env: Env, authorization?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP), {
    fetch: (url, init) => call(env, new Request(url, init)),
    ...(authorization ? { requestInit: { headers: { authorization } } } : {}),
  });
  const client = new Client({ name: "afixo-mcp-test", version: "0" });
  await client.connect(transport);
  return client;
}

describe("2026-07-28 client", () => {
  it("discovers the server, lists the tools and reads the docs resource", async () => {
    const client = await connect(envWith(fakeApi(machineApi).api));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["afixo_disclose", "afixo_health", "afixo_list_purposes"]);
    const docs = await client.readResource({ uri: "afixo://docs" });
    expect((docs.contents[0] as { text: string }).text).toContain("https://docs.afixo.io");
    await client.close();
  });

  it("calls afixo_disclose with the bearer configured on the connection", async () => {
    const api = fakeApi(machineApi);
    const client = await connect(envWith(api.api), TOKEN);
    const result = await client.callTool({ name: "afixo_disclose", arguments: { handle: "alice", purpose: "legal" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(ALLOW);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.url).toBe("https://api.afixo.io/v1/disclose/alice?purpose=legal");
    expect(api.calls[0]!.headers.get("authorization")).toBe(TOKEN);
    await client.close();
  });

  it("without a token the tool error explains how to authenticate, and nothing goes upstream", async () => {
    const api = fakeApi(machineApi);
    const client = await connect(envWith(api.api));
    const result = await client.callTool({ name: "afixo_disclose", arguments: { handle: "alice", purpose: "legal" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("https://api.afixo.io/oauth/token");
    expect(api.calls).toHaveLength(0);
    await client.close();
  });
});
