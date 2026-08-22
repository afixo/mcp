/**
 * The MCP surface through the real handler, as a 2025-era client speaks it (one JSON-RPC POST per
 * request, no session). The machine API is a same-isolate fake of the `API` binding (helpers.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOW, DENY, INIT_PARAMS, PURPOSES, TOKEN, callTool, envWith, fakeApi, machineApi, rpc } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("handshake", () => {
  it("initialize answers with the server identity and its capabilities", async () => {
    const { response, message } = await rpc(envWith(fakeApi(machineApi).api), "initialize", INIT_PARAMS);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(message?.error).toBeUndefined();
    expect(message?.result.serverInfo).toMatchObject({ name: "afixo-mcp" });
    expect(message?.result.capabilities).toHaveProperty("tools");
    expect(message?.result.capabilities).toHaveProperty("resources");
    expect(message?.result.instructions).toContain("afixo_list_purposes");
  });

  it("tools/list exposes exactly the three tools with the fixed schemas", async () => {
    const { message } = await rpc(envWith(fakeApi(machineApi).api), "tools/list");
    const tools = message?.result.tools as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["afixo_disclose", "afixo_health", "afixo_list_purposes"]);

    const disclose = tools.find((t) => t.name === "afixo_disclose")!;
    expect(disclose.inputSchema["type"]).toBe("object");
    expect(Object.keys(disclose.inputSchema["properties"] as object).sort()).toEqual(["handle", "purpose"]);
    expect((disclose.inputSchema["required"] as string[]).sort()).toEqual(["handle", "purpose"]);

    const purposes = tools.find((t) => t.name === "afixo_list_purposes")!;
    expect(Object.keys((purposes.inputSchema["properties"] as object) ?? {})).toEqual([]);
  });

  it("GET and DELETE on /mcp are 405 (stateless: there is no session to stream or delete)", async () => {
    const env = envWith(fakeApi(machineApi).api);
    const { call } = await import("./helpers");
    for (const method of ["GET", "DELETE"]) {
      const res = await call(env, new Request("https://mcp.afixo.io/mcp", { method, headers: { accept: "text/event-stream" } }));
      expect(res.status, method).toBe(405);
    }
  });
});

describe("afixo_list_purposes", () => {
  it("returns the vocabulary and needs no token", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_list_purposes");
    expect(message?.result.isError).toBeFalsy();
    expect(JSON.parse(message?.result.content[0].text)).toEqual(PURPOSES);
    expect(message?.result.structuredContent).toEqual({ purposes: PURPOSES });

    expect(api.calls).toHaveLength(1);
    const sent = api.calls[0]!;
    expect(sent.url).toBe("https://api.afixo.io/v1/purposes");
    expect(sent.method).toBe("GET");
    expect(sent.headers.get("authorization")).toBeNull();
  });

  it("forwards the Authorization header unchanged when the connection has one", async () => {
    const api = fakeApi(machineApi);
    await callTool(envWith(api.api), "afixo_list_purposes", {}, { authorization: TOKEN });
    expect(api.calls[0]!.headers.get("authorization")).toBe(TOKEN);
  });

  it("is a tool error when the API fails", async () => {
    const api = fakeApi(() => Response.json({ error: "upstream_unavailable", message: "policy down" }, { status: 503 }));
    const { message } = await callTool(envWith(api.api), "afixo_list_purposes");
    expect(message?.result.isError).toBe(true);
    expect(message?.result.content[0].text).toContain("HTTP 503 upstream_unavailable");
    expect(message?.result.content[0].text).toContain("policy down");
  });
});

describe("afixo_disclose", () => {
  it("200 allow: the decision, through the binding, with the bearer passed through unchanged", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "legal" }, { authorization: TOKEN });
    expect(message?.error).toBeUndefined();
    expect(message?.result.isError).toBeFalsy();
    expect(message?.result.structuredContent).toEqual(ALLOW);
    expect(JSON.parse(message?.result.content[0].text)).toEqual(ALLOW);

    expect(api.calls).toHaveLength(1);
    const sent = api.calls[0]!;
    expect(sent.url).toBe("https://api.afixo.io/v1/disclose/alice?purpose=legal");
    expect(sent.method).toBe("GET");
    expect(sent.redirect).toBe("manual");
    expect(sent.headers.get("authorization")).toBe(TOKEN);
    expect(sent.headers.get("accept")).toBe("application/json");
    expect(sent.headers.get("cookie")).toBeNull();
  });

  it("403 deny is a normal result, not an error", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "nobody", purpose: "shipping" }, { authorization: TOKEN });
    expect(message?.result.isError).toBeFalsy();
    expect(message?.result.structuredContent).toEqual(DENY);
  });

  it("no Authorization header: a helpful tool error and nothing sent upstream", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "legal" });
    expect(message?.result.isError).toBe(true);
    const text = message?.result.content[0].text as string;
    expect(text).toContain("Not authenticated");
    expect(text).toContain("Authorization: Bearer");
    expect(text).toContain("https://api.afixo.io/oauth/token");
    expect(text).toContain("client_credentials");
    expect(api.calls).toHaveLength(0);
  });

  it("401 from the API: a tool error that says how to get a token", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "legal" }, { authorization: "Bearer expired" });
    expect(message?.result.isError).toBe(true);
    const text = message?.result.content[0].text as string;
    expect(text).toContain("Not authenticated");
    expect(text).toContain("token invalid or expired");
    expect(text).toContain("https://api.afixo.io/oauth/token");
    expect(api.calls[0]!.headers.get("authorization")).toBe("Bearer expired"); // forwarded as-is, never "fixed"
  });

  it("400 invalid_purpose: a tool error listing the valid purposes", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "marketing" }, { authorization: TOKEN });
    expect(message?.result.isError).toBe(true);
    const text = message?.result.content[0].text as string;
    expect(text).toContain('Invalid purpose "marketing"');
    expect(text).toContain("- shipping");
    expect(text).toContain("- legal");
    expect(api.calls.map((r) => new URL(r.url).pathname)).toEqual(["/v1/disclose/alice", "/v1/purposes"]);
  });

  it("403 that is not a decision (wrong_principal) is a tool error with the API's message", async () => {
    const api = fakeApi(() => Response.json({ error: "wrong_principal", message: "subject token on the machine listener" }, { status: 403 }));
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "legal" }, { authorization: TOKEN });
    expect(message?.result.isError).toBe(true);
    expect(message?.result.content[0].text).toContain("HTTP 403 wrong_principal");
  });

  it("validates its input before anything is sent", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice" }, { authorization: TOKEN });
    expect(message?.result?.isError ?? message?.error !== undefined).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("encodes the handle into the path", async () => {
    const api = fakeApi(machineApi);
    await callTool(envWith(api.api), "afixo_disclose", { handle: "al ice/../x?y", purpose: "legal" }, { authorization: TOKEN });
    expect(api.calls[0]!.url).toBe("https://api.afixo.io/v1/disclose/al%20ice%2F..%2Fx%3Fy?purpose=legal");
  });

  it("unreachable API: a tool error, not a crash", async () => {
    const api = fakeApi(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const { message } = await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "legal" }, { authorization: TOKEN });
    expect(message?.result.isError).toBe(true);
    expect(message?.result.content[0].text).toContain("could not be reached");
  });

  it("never logs the token or a disclosed value", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const api = fakeApi(machineApi);
    await callTool(envWith(api.api), "afixo_disclose", { handle: "alice", purpose: "legal" }, { authorization: TOKEN });
    const joined = lines.join("\n");
    expect(joined).toContain('"tool":"afixo_disclose"');
    expect(joined).toContain('"outcome":"allow"');
    expect(joined).not.toContain("secret-token-value");
    expect(joined).not.toContain("alice@example.test");
    expect(joined).not.toContain("Alice Example");
  });
});

describe("afixo_health", () => {
  it("reports the API's health", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_health");
    expect(message?.result.isError).toBeFalsy();
    expect(message?.result.structuredContent).toEqual({ ok: true, http_status: 200, status: "ok", service: "gateway", version: "0.1.0" });
    expect(api.calls[0]!.url).toBe("https://api.afixo.io/v1/health");
  });

  it("reports an unreachable API as ok:false rather than an error", async () => {
    const api = fakeApi(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const { message } = await callTool(envWith(api.api), "afixo_health");
    expect(message?.result.isError).toBeFalsy();
    expect(message?.result.structuredContent).toEqual({ ok: false, error: "upstream_unreachable" });
  });
});

describe("without the API binding (local dev)", () => {
  it("falls back to a plain fetch to MACHINE_API_URL", async () => {
    const seen: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      seen.push(request);
      return machineApi(request);
    });
    const { message } = await callTool(envWith(undefined, "http://localhost:8081/"), "afixo_disclose", { handle: "alice", purpose: "legal" }, { authorization: TOKEN });
    expect(message?.result.structuredContent).toEqual(ALLOW);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://localhost:8081/v1/disclose/alice?purpose=legal");
    expect(seen[0]!.headers.get("authorization")).toBe(TOKEN);
  });
});

describe("resources", () => {
  it("lists and reads afixo://docs", async () => {
    const env = envWith(fakeApi(machineApi).api);
    const list = await rpc(env, "resources/list");
    expect(list.message?.result.resources.map((r: { uri: string }) => r.uri)).toEqual(["afixo://docs"]);

    const read = await rpc(env, "resources/read", { uri: "afixo://docs" });
    const text = read.message?.result.contents[0].text as string;
    expect(read.message?.result.contents[0].uri).toBe("afixo://docs");
    expect(text).toContain("https://docs.afixo.io");
    expect(text).toContain("https://docs.afixo.io/api/overview/");
    expect(text).toContain("Authorization: Bearer");
  });
});

describe("loopback MACHINE_API_URL (wrangler dev against a local gateway)", () => {
  it("fetches the gateway directly and leaves the [not connected] binding alone", async () => {
    const api = fakeApi(() => Response.json({ error: "binding must not be used" }, { status: 503 }));
    const seen: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      seen.push(request);
      return machineApi(request);
    });
    const { message } = await callTool(envWith(api.api, "http://localhost:8081"), "afixo_health");
    expect(message?.result.structuredContent).toMatchObject({ ok: true, http_status: 200 });
    expect(api.calls).toHaveLength(0);
    expect(seen.map((r) => r.url)).toEqual(["http://localhost:8081/v1/health"]);
  });
});
