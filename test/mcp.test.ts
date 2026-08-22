/**
 * The MCP surface through the real handler, as a 2025-era client speaks it (one JSON-RPC POST per
 * request, no session). The machine API is a same-isolate fake of the `API` binding (helpers.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCS, SNIPPET_MAX } from "../src/docs";
import { ALLOW, DENY, INIT_PARAMS, PURPOSES, TOKEN, callTool, envWith, fakeApi, machineApi, rpc } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const TOOL_NAMES = ["afixo_disclose", "afixo_disclose_many", "afixo_health", "afixo_list_purposes", "afixo_search_docs"];
const DOC_URIS = DOCS.map((doc) => doc.uri);
const DOC_SLUGS = ["getting-started", "api-overview", "api-machine", "purposes", "disclosure-rules", "decision-algorithm"];

/** Captures every console line while `run` executes (the logger writes JSON lines to console.log). */
async function captureLogs(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  for (const method of ["log", "error", "warn"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  await run();
  return lines.join("\n");
}

describe("handshake", () => {
  it("initialize answers with the server identity and its capabilities", async () => {
    const { response, message } = await rpc(envWith(fakeApi(machineApi).api), "initialize", INIT_PARAMS);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(message?.error).toBeUndefined();
    expect(message?.result.serverInfo).toMatchObject({ name: "afixo-mcp" });
    expect(message?.result.capabilities).toHaveProperty("tools");
    expect(message?.result.capabilities).toHaveProperty("resources");
    expect(message?.result.capabilities).toHaveProperty("prompts");
    expect(message?.result.instructions).toContain("afixo_list_purposes");
    expect(message?.result.instructions).toContain("afixo_disclose_many");
    expect(message?.result.instructions).toContain("afixo_search_docs");
    expect(message?.result.instructions).toContain("integrate_afixo");
  });

  it("tools/list exposes exactly the five tools with the fixed schemas", async () => {
    const { message } = await rpc(envWith(fakeApi(machineApi).api), "tools/list");
    const tools = message?.result.tools as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);

    const disclose = tools.find((t) => t.name === "afixo_disclose")!;
    expect(disclose.inputSchema["type"]).toBe("object");
    expect(Object.keys(disclose.inputSchema["properties"] as object).sort()).toEqual(["handle", "purpose"]);
    expect((disclose.inputSchema["required"] as string[]).sort()).toEqual(["handle", "purpose"]);

    const many = tools.find((t) => t.name === "afixo_disclose_many")!;
    expect(Object.keys(many.inputSchema["properties"] as object).sort()).toEqual(["handle", "purposes"]);
    expect(many.inputSchema["required"]).toEqual(["handle"]);

    const search = tools.find((t) => t.name === "afixo_search_docs")!;
    expect(Object.keys(search.inputSchema["properties"] as object).sort()).toEqual(["limit", "query"]);
    expect(search.inputSchema["required"]).toEqual(["query"]);

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

describe("afixo_disclose_many", () => {
  /** Per purpose: legal → allow, shipping → deny, anything else → 400 invalid_purpose; 401 for any other token. */
  function byPurpose(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/v1/purposes") return Response.json(PURPOSES);
    if (request.headers.get("authorization") !== TOKEN) {
      return Response.json({ error: "invalid_token", message: "token invalid or expired" }, { status: 401 });
    }
    const purpose = url.searchParams.get("purpose");
    if (purpose === "legal") return Response.json(ALLOW);
    if (purpose === "shipping") return Response.json(DENY, { status: 403 });
    return Response.json({ error: "invalid_purpose", message: `unknown purpose ${purpose}` }, { status: 400 });
  }

  it("calls the disclose endpoint once per purpose, in parallel, and answers one row per purpose", async () => {
    // The fake only answers once every expected request has arrived: a sequential caller would never finish.
    const waiting: { request: Request; resolve: (response: Response) => void }[] = [];
    const api = fakeApi(
      (request) =>
        new Promise<Response>((resolve) => {
          waiting.push({ request, resolve });
          if (waiting.length === 2) for (const entry of waiting.splice(0)) entry.resolve(byPurpose(entry.request));
        }),
    );
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: ["legal", "shipping"] }, { authorization: TOKEN });
    expect(message?.error).toBeUndefined();
    expect(message?.result.isError).toBeFalsy();
    expect(message?.result.structuredContent).toEqual({
      handle: "alice",
      results: [
        { purpose: "legal", decision: "allow", persona: ALLOW.persona, fields: ALLOW.fields, withheld: ALLOW.withheld, decision_id: ALLOW.decision_id },
        { purpose: "shipping", decision: "deny", reason: DENY.reason, decision_id: DENY.decision_id },
      ],
    });

    const text = message?.result.content[0].text as string;
    expect(text).toContain('Disclosure of "alice" for 2 purposes: 1 allow, 1 deny, 0 error');
    expect(text).toMatch(/^purpose\s+decision\s+persona\s+decision_id\s+detail$/m);
    expect(text).toMatch(/^legal\s+allow\s+legal\s+0190d3f0-0000-7000-8000-000000000001\s+fields: full_name="Alice Example", email="alice@example.test"; withheld: dob, postal_address$/m);
    expect(text).toMatch(/^shipping\s+deny\s+-\s+0190d3f0-0000-7000-8000-000000000002\s+no_matching_rule$/m);

    expect(api.calls.map((r) => r.url)).toEqual([
      "https://api.afixo.io/v1/disclose/alice?purpose=legal",
      "https://api.afixo.io/v1/disclose/alice?purpose=shipping",
    ]);
    for (const sent of api.calls) {
      expect(sent.method).toBe("GET");
      expect(sent.redirect).toBe("manual");
      expect(sent.headers.get("authorization")).toBe(TOKEN);
    }
  });

  it("without purposes it asks for every purpose of the vocabulary, fetched once", async () => {
    const api = fakeApi(byPurpose);
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice" }, { authorization: TOKEN });
    expect(message?.result.isError).toBeFalsy();
    const results = message?.result.structuredContent.results as { purpose: string; decision: string }[];
    expect(results.map((r) => [r.purpose, r.decision])).toEqual([
      ["shipping", "deny"],
      ["legal", "allow"],
    ]);
    expect(api.calls.map((r) => new URL(r.url).pathname + new URL(r.url).search)).toEqual([
      "/v1/purposes",
      "/v1/disclose/alice?purpose=shipping",
      "/v1/disclose/alice?purpose=legal",
    ]);
  });

  it("an empty purposes list also means the whole vocabulary", async () => {
    const api = fakeApi(byPurpose);
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: [] }, { authorization: TOKEN });
    expect(message?.result.structuredContent.results).toHaveLength(2);
    expect(api.calls[0]!.url).toBe("https://api.afixo.io/v1/purposes");
  });

  it("asks each purpose once: duplicates and blanks are dropped, the order is kept", async () => {
    const api = fakeApi(byPurpose);
    const { message } = await callTool(
      envWith(api.api),
      "afixo_disclose_many",
      { handle: "alice", purposes: ["shipping", " legal ", "shipping", "legal"] },
      { authorization: TOKEN },
    );
    const results = message?.result.structuredContent.results as { purpose: string }[];
    expect(results.map((r) => r.purpose)).toEqual(["shipping", "legal"]);
    expect(api.calls).toHaveLength(2);
  });

  it("an invalid purpose is an error row for that purpose, the others are still decided", async () => {
    const api = fakeApi(byPurpose);
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: ["legal", "marketing"] }, { authorization: TOKEN });
    expect(message?.result.isError).toBeFalsy();
    const results = message?.result.structuredContent.results as { purpose: string; decision: string; error?: string }[];
    expect(results[0]).toMatchObject({ purpose: "legal", decision: "allow" });
    expect(results[1]).toEqual({ purpose: "marketing", decision: "error", error: "HTTP 400 invalid_purpose — unknown purpose marketing" });
    expect(message?.result.content[0].text).toContain("1 allow, 0 deny, 1 error");
    expect(message?.result.content[0].text).toMatch(/^marketing\s+error\s+-\s+-\s+HTTP 400 invalid_purpose — unknown purpose marketing$/m);
    // unlike afixo_disclose, no extra /v1/purposes round trip: the row names the problem
    expect(api.calls.map((r) => new URL(r.url).pathname)).toEqual(["/v1/disclose/alice", "/v1/disclose/alice"]);
  });

  it("no Authorization header: the same not-authenticated tool error as afixo_disclose, nothing sent upstream", async () => {
    const api = fakeApi(byPurpose);
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: ["legal"] });
    expect(message?.result.isError).toBe(true);
    const text = message?.result.content[0].text as string;
    expect(text).toContain("Not authenticated");
    expect(text).toContain("https://api.afixo.io/oauth/token");
    expect(api.calls).toHaveLength(0);
  });

  it("401 from the API: one not-authenticated tool error for the whole call, not error rows", async () => {
    const api = fakeApi(byPurpose);
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: ["legal", "shipping"] }, { authorization: "Bearer expired" });
    expect(message?.result.isError).toBe(true);
    expect(message?.result.structuredContent).toBeUndefined();
    const text = message?.result.content[0].text as string;
    expect(text).toContain("Not authenticated");
    expect(text).toContain("token invalid or expired");
    expect(text).toContain("client_credentials");
    expect(api.calls[0]!.headers.get("authorization")).toBe("Bearer expired");
  });

  it("an unreachable API is an error row per purpose, not a crash", async () => {
    const api = fakeApi(() => {
      throw new TypeError("connect ECONNREFUSED");
    });
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: ["legal", "shipping"] }, { authorization: TOKEN });
    expect(message?.result.isError).toBeFalsy();
    const results = message?.result.structuredContent.results as { decision: string; error?: string }[];
    expect(results.map((r) => r.decision)).toEqual(["error", "error"]);
    expect(results[0]!.error).toContain("could not be reached");
  });

  it("a failing purposes lookup (no purposes given) is a tool error", async () => {
    const api = fakeApi(() => Response.json({ error: "upstream_unavailable", message: "policy down" }, { status: 503 }));
    const { message } = await callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice" }, { authorization: TOKEN });
    expect(message?.result.isError).toBe(true);
    expect(message?.result.content[0].text).toContain("Listing purposes failed");
    expect(message?.result.content[0].text).toContain("HTTP 503 upstream_unavailable");
  });

  it("validates its input before anything is sent", async () => {
    const api = fakeApi(byPurpose);
    const tooMany = Array.from({ length: 21 }, (_, i) => `p${i}`);
    for (const args of [{ purposes: ["legal"] }, { handle: "", purposes: ["legal"] }, { handle: "alice", purposes: "legal" }, { handle: "alice", purposes: tooMany }]) {
      const { message } = await callTool(envWith(api.api), "afixo_disclose_many", args, { authorization: TOKEN });
      expect(message?.result?.isError ?? message?.error !== undefined, JSON.stringify(args)).toBe(true);
    }
    expect(api.calls).toHaveLength(0);
  });

  it("never logs the token or a disclosed value", async () => {
    const api = fakeApi(byPurpose);
    const joined = await captureLogs(() =>
      callTool(envWith(api.api), "afixo_disclose_many", { handle: "alice", purposes: ["legal", "shipping"] }, { authorization: TOKEN }),
    );
    expect(joined).toContain('"tool":"afixo_disclose_many"');
    expect(joined).toContain('"outcome":"allow=1 deny=1 error=0"');
    expect(joined).not.toContain("secret-token-value");
    expect(joined).not.toContain("alice@example.test");
    expect(joined).not.toContain("Alice Example");
  });
});

describe("afixo_search_docs", () => {
  const env = envWith(fakeApi(machineApi).api);

  it("finds the pages for a term, best paragraph first, without a token and without an upstream call", async () => {
    const api = fakeApi(machineApi);
    const { message } = await callTool(envWith(api.api), "afixo_search_docs", { query: "specificity" });
    expect(message?.result.isError).toBeFalsy();
    const { query, results } = message?.result.structuredContent as { query: string; results: { slug: string; title: string; uri: string; snippet: string }[] };
    expect(query).toBe("specificity");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.slug)).toContain("disclosure-rules");
    expect(results.map((r) => r.slug)).toContain("decision-algorithm");
    for (const hit of results) {
      expect(hit.uri).toBe(`afixo://docs/${hit.slug}`);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.snippet.toLowerCase()).toContain("specificity");
      expect(hit.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
      expect(hit.snippet).not.toContain("\n");
    }
    expect(message?.result.content[0].text).toContain("afixo://docs/disclosure-rules");
    expect(api.calls).toHaveLength(0);
  });

  it("is case-insensitive", async () => {
    const lower = await callTool(env, "afixo_search_docs", { query: "invalid_token" });
    const upper = await callTool(env, "afixo_search_docs", { query: "INVALID_TOKEN" });
    const slugs = (m: typeof lower) => (m.message?.result.structuredContent.results as { slug: string }[]).map((r) => r.slug);
    expect(slugs(lower).length).toBeGreaterThan(0);
    expect(slugs(upper)).toEqual(slugs(lower));
  });

  it("ranks a page that contains the whole phrase first", async () => {
    const { message } = await callTool(env, "afixo_search_docs", { query: "rate limit" });
    const results = message?.result.structuredContent.results as { slug: string; snippet: string }[];
    expect(results[0]!.snippet.toLowerCase()).toContain("rate limit");
  });

  it("honours limit and validates it", async () => {
    const one = await callTool(env, "afixo_search_docs", { query: "purpose", limit: 1 });
    expect(one.message?.result.structuredContent.results).toHaveLength(1);
    const five = await callTool(env, "afixo_search_docs", { query: "purpose" });
    expect(five.message?.result.structuredContent.results).toHaveLength(5);
    for (const limit of [0, 11, 1.5, "3"]) {
      const { message } = await callTool(env, "afixo_search_docs", { query: "purpose", limit });
      expect(message?.result?.isError ?? message?.error !== undefined, String(limit)).toBe(true);
    }
  });

  it("no match is an empty result that names the pages, not an error", async () => {
    const { message } = await callTool(env, "afixo_search_docs", { query: "zebra unicorn" });
    expect(message?.result.isError).toBeFalsy();
    expect(message?.result.structuredContent).toEqual({ query: "zebra unicorn", results: [] });
    const text = message?.result.content[0].text as string;
    expect(text).toContain("No bundled documentation page matches");
    for (const slug of DOC_SLUGS) expect(text).toContain(slug);
  });
});

describe("resources", () => {
  const env = envWith(fakeApi(machineApi).api);

  it("lists the index and one text/markdown resource per bundled page", async () => {
    const list = await rpc(env, "resources/list");
    const resources = list.message?.result.resources as { uri: string; name: string; title?: string; mimeType?: string }[];
    expect(resources.map((r) => r.uri)).toEqual(["afixo://docs", ...DOC_URIS]);
    expect(DOC_URIS).toEqual(DOC_SLUGS.map((slug) => `afixo://docs/${slug}`));
    for (const doc of DOCS) {
      const listed = resources.find((r) => r.uri === doc.uri)!;
      expect(listed.mimeType).toBe("text/markdown");
      expect(listed.title).toBe(doc.title);
      expect(listed.name).toBe(doc.slug);
    }
    expect(resources.find((r) => r.name === "purposes")!.title).toBe("Purposes");
    expect(resources.find((r) => r.name === "api-machine")!.title).toBe("Machine API");
  });

  it("reads afixo://docs: the index that lists the bundled pages", async () => {
    const read = await rpc(env, "resources/read", { uri: "afixo://docs" });
    const text = read.message?.result.contents[0].text as string;
    expect(read.message?.result.contents[0].uri).toBe("afixo://docs");
    expect(text).toContain("https://docs.afixo.io");
    expect(text).toContain("https://docs.afixo.io/api/overview/");
    expect(text).toContain("Authorization: Bearer");
    expect(text).toContain("afixo_disclose_many");
    expect(text).toContain("afixo_search_docs");
    expect(text).toContain("integrate_afixo");
    for (const uri of DOC_URIS) expect(text).toContain(uri);
  });

  it("reads a page as markdown: the title as heading, no front-matter, no MDX", async () => {
    const read = await rpc(env, "resources/read", { uri: "afixo://docs/purposes" });
    const content = read.message?.result.contents[0] as { uri: string; mimeType: string; text: string };
    expect(content.uri).toBe("afixo://docs/purposes");
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text.startsWith("# Purposes\n")).toBe(true);
    expect(content.text).toContain("social_display");
    expect(content.text).toContain("https://docs.afixo.io/concepts/disclosure-rules/");
    expect(content.text).not.toContain("\n---\n");
    expect(content.text).not.toContain(":::");

    const machine = await rpc(env, "resources/read", { uri: "afixo://docs/api-machine" });
    const text = machine.message?.result.contents[0].text as string;
    expect(text).toContain("POST /oauth/token");
    expect(text).not.toMatch(/<\/?(Aside|Tabs|TabItem|Steps)\b/);
    expect(text).not.toContain("@astrojs");
  });

  it("an unknown page is an error", async () => {
    const read = await rpc(env, "resources/read", { uri: "afixo://docs/nope" });
    expect(read.message?.error).toBeDefined();
    expect(read.message?.result).toBeUndefined();
  });
});

describe("prompts", () => {
  const env = envWith(fakeApi(machineApi).api);

  it("prompts/list exposes integrate_afixo with an optional language argument", async () => {
    const { message } = await rpc(env, "prompts/list");
    const prompts = message?.result.prompts as { name: string; arguments?: { name: string; required?: boolean }[] }[];
    expect(prompts.map((p) => p.name)).toEqual(["integrate_afixo"]);
    expect(prompts[0]!.arguments).toEqual([expect.objectContaining({ name: "language", required: false })]);
  });

  it("prompts/get without a language is the playbook with a curl sample", async () => {
    const { message } = await rpc(env, "prompts/get", { name: "integrate_afixo", arguments: {} });
    expect(message?.error).toBeUndefined();
    const messages = message?.result.messages as { role: string; content: { type: string; text: string } }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    const text = messages[0]!.content.text;
    expect(text).toContain("https://afixo.io/app/clients");
    expect(text).toContain("POST https://api.afixo.io/oauth/token");
    expect(text).toContain("grant_type=client_credentials");
    expect(text).toContain("GET https://api.afixo.io/v1/disclose/{handle}?purpose={purpose}");
    expect(text).toContain("A deny is final");
    expect(text).toContain("Cache nothing");
    expect(text).toContain("decision_id");
    expect(text).toContain("```sh\n");
    expect(text).toContain('-u "$AFIXO_CLIENT_ID:$AFIXO_CLIENT_SECRET"');
  });

  it("prompts/get renders the sample in the requested language, aliases included", async () => {
    const cases: [string, string][] = [
      ["python", "```python\n"],
      ["py", "```python\n"],
      ["typescript", "```ts\n"],
      ["TypeScript", "```ts\n"],
      ["node", "```ts\n"],
      ["rust", "```rust\n"],
      ["curl", "```sh\n"],
    ];
    for (const [language, fence] of cases) {
      const { message } = await rpc(env, "prompts/get", { name: "integrate_afixo", arguments: { language } });
      const text = message?.result.messages[0].content.text as string;
      expect(text, language).toContain(fence);
      expect(text, language).not.toContain("No sample for");
    }
    const rust = await rpc(env, "prompts/get", { name: "integrate_afixo", arguments: { language: "rust" } });
    expect(rust.message?.result.messages[0].content.text).toContain("reqwest::Client::new()");
  });

  it("an unsupported language falls back to curl and says so", async () => {
    const { message } = await rpc(env, "prompts/get", { name: "integrate_afixo", arguments: { language: "cobol" } });
    const text = message?.result.messages[0].content.text as string;
    expect(text).toContain('No sample for "cobol"');
    expect(text).toContain("```sh\n");
  });

  it("completes the language argument", async () => {
    const { message } = await rpc(env, "completion/complete", {
      ref: { type: "ref/prompt", name: "integrate_afixo" },
      argument: { name: "language", value: "p" },
    });
    expect(message?.error).toBeUndefined();
    expect(message?.result.completion.values).toEqual(["python"]);
  });

  it("never logs the prompt text", async () => {
    const joined = await captureLogs(() => rpc(env, "prompts/get", { name: "integrate_afixo", arguments: { language: "python" } }));
    expect(joined).toContain('"prompt":"integrate_afixo"');
    expect(joined).not.toContain("client_credentials");
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
