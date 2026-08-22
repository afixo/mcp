import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

export const ORIGIN = "https://mcp.afixo.io";
export const MCP = `${ORIGIN}/mcp`;
/** A requester token as an MCP client would configure it. The value must never appear in a log. */
export const TOKEN = "Bearer req_abc.secret-token-value";

export interface FakeApi {
  /** every request the Worker sent over the binding, in order */
  calls: Request[];
  api: Fetcher;
}

/** A same-isolate stand-in for the `API` service binding (afixo-api): records what it receives. */
export function fakeApi(handler: (request: Request) => Response | Promise<Response>): FakeApi {
  const calls: Request[] = [];
  const api = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      calls.push(request);
      return handler(request);
    },
  } as unknown as Fetcher;
  return { calls, api };
}

/** An `env` for the Worker: the binding is optional so the plain-fetch fallback can be exercised. */
export function envWith(api?: Fetcher, machineApiUrl = "https://api.afixo.io"): Env {
  return { MACHINE_API_URL: machineApiUrl, ...(api ? { API: api } : {}) } as Env;
}

export async function call(env: Env, request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcOptions {
  /** the Authorization header value; omitted = no header at all */
  authorization?: string;
  id?: number;
}

/** One 2025-era JSON-RPC request to /mcp (served by the stateless legacy lane), SSE or JSON answer decoded. */
export async function rpc(env: Env, method: string, params: unknown = {}, opts: RpcOptions = {}) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (opts.authorization !== undefined) headers.set("authorization", opts.authorization);
  const body = JSON.stringify({ jsonrpc: "2.0", id: opts.id ?? 1, method, params });
  const response = await call(env, new Request(MCP, { method: "POST", headers, body }));
  return { response, message: await decode(response) };
}

export const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "afixo-mcp-test", version: "0" },
};

export function callTool(env: Env, name: string, args: Record<string, unknown> = {}, opts: RpcOptions = {}) {
  return rpc(env, "tools/call", { name, arguments: args }, opts);
}

/** The first JSON-RPC message of a JSON or SSE response body. */
export async function decode(response: Response): Promise<JsonRpcResponse | undefined> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (type.includes("application/json")) return JSON.parse(text) as JsonRpcResponse;
  if (type.includes("text/event-stream")) {
    for (const chunk of text.split("\n\n")) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) return JSON.parse(data) as JsonRpcResponse;
    }
  }
  return undefined;
}

/** The canned machine API: the contract from afixo-services/docs/api.md, keyed by path and token. */
export const PURPOSES = [
  { name: "shipping", description: "Deliver a parcel" },
  { name: "legal", description: "Legal correspondence" },
];
export const ALLOW = {
  decision: "allow",
  decision_id: "0190d3f0-0000-7000-8000-000000000001",
  persona: "legal",
  fields: { full_name: "Alice Example", email: "alice@example.test" },
  withheld: ["dob", "postal_address"],
};
export const DENY = { decision: "deny", decision_id: "0190d3f0-0000-7000-8000-000000000002", reason: "no_matching_rule" };

export function machineApi(request: Request): Response {
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  if (url.pathname === "/v1/health") return Response.json({ status: "ok", service: "gateway", version: "0.1.0" });
  if (url.pathname === "/v1/purposes") return Response.json(PURPOSES);
  if (url.pathname.startsWith("/v1/disclose/")) {
    if (auth !== TOKEN) return Response.json({ error: "invalid_token", message: "token invalid or expired" }, { status: 401 });
    const purpose = url.searchParams.get("purpose");
    if (!PURPOSES.some((p) => p.name === purpose)) {
      return Response.json({ error: "invalid_purpose", message: `unknown purpose ${purpose}` }, { status: 400 });
    }
    const handle = decodeURIComponent(url.pathname.slice("/v1/disclose/".length));
    if (handle === "alice") return Response.json(ALLOW);
    return Response.json(DENY, { status: 403 });
  }
  return Response.json({ error: "not_found", message: "no such route" }, { status: 404 });
}
