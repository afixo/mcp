/**
 * afixo-mcp — the remote MCP server at https://mcp.afixo.io/mcp (Streamable HTTP, stateless).
 *
 *   MCP client ─ Authorization: Bearer <requester token> ─► this Worker ─ /mcp ─► createMcpHandler
 *        tools ─► src/upstream.ts ─ API binding ─► afixo-api (machine mode, api.afixo.io) ─► gateway :8081
 *
 * No Durable Object, no KV: every MCP request builds a fresh McpServer (src/server.ts) around an
 * Upstream that forwards that request's Authorization header unchanged. Plain HTTP besides /mcp:
 * GET / (service card) and GET /healthz; everything else is 404 JSON.
 */
import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { log } from "./log";
import { createServer } from "./server";
import { createUpstream } from "./upstream";

const MCP_ROUTE = "/mcp";
const DOCS_URL = "https://docs.afixo.io";

/** One stateless handler per `env` object: one per isolate in production, one per fake env in tests. */
const handlers = new WeakMap<object, StatelessMcpHandler>();

function mcpHandler(env: Env): StatelessMcpHandler {
  let handler = handlers.get(env);
  if (handler) return handler;
  handler = createMcpHandler(
    // The factory runs once per MCP request; `requestInfo` is that request. The header goes into
    // the Upstream as an opaque value and nowhere else.
    (mcp) => createServer(createUpstream(env, mcp.requestInfo?.headers.get("authorization") ?? null)),
    {
      route: MCP_ROUTE,
      onerror: (error) => log("mcp_error", { message: error.message }),
    },
  );
  handlers.set(env, handler);
  return handler;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    let response: Response;
    try {
      response = await route(request, url, env, ctx);
    } catch (error) {
      log("unhandled", {
        method: request.method,
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
      response = json({ error: "internal" }, 500);
    }
    log("http", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      ms: Date.now() - started,
      // 2026-07-28 clients name the MCP method and tool in headers; 2025 clients carry them in the body.
      mcp_method: request.headers.get("mcp-method"),
      mcp_name: request.headers.get("mcp-name"),
    });
    return response;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname === MCP_ROUTE) {
    const response = await mcpHandler(env)(request, env, ctx);
    // Disclosed fields travel in these responses: nothing between here and the client may cache them.
    return withHeader(response, "cache-control", "no-store");
  }
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not_found" }, 404);
  if (url.pathname === "/") return json({ name: "afixo-mcp", mcp: MCP_ROUTE, docs: DOCS_URL });
  if (url.pathname === "/healthz") return json({ ok: true });
  return json({ error: "not_found" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function withHeader(response: Response, name: string, value: string): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(name, value);
  return copy;
}
