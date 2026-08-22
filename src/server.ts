/**
 * The MCP surface: three tools and one resource.
 *
 * `createMcpHandler` (src/index.ts) calls `createServer` for every MCP request — stateless: no
 * session, no Durable Object — with an Upstream that carries that request's Authorization header.
 * Tools only ever see outcomes, never the header. A deny is a normal result; only "cannot answer"
 * (no token, bad token, unknown purpose, upstream failure) is a tool error.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  API_DOCS_URL,
  CLIENTS_PAGE,
  DOCS_URL,
  MCP_URL,
  TOKEN_ENDPOINT,
  errorFields,
  invalidPurpose,
  notAuthenticated,
  tokenRejected,
  toolError,
  unexpected,
  unreachable,
  upstreamFailure,
} from "./errors";
import { log } from "./log";
import { type Upstream, type UpstreamResult, UpstreamUnreachable } from "./upstream";

export const SERVER_INFO = { name: "afixo-mcp", version: "0.1.0" };

export const INSTRUCTIONS = [
  "Afixo is a selective-disclosure identity API. A subject publishes personas under a handle; a requester asks for",
  "that subject's data for a stated purpose and Afixo's policy decides which fields are disclosed.",
  "Call afixo_list_purposes to learn the purpose vocabulary, then afixo_disclose(handle, purpose).",
  "A deny is a normal, final answer: do not probe other purposes to get around it.",
  "afixo_disclose needs the MCP connection to carry an Afixo requester token (HTTP header `Authorization: Bearer <token>`).",
].join(" ");

export const DOCS_TEXT = [
  `Afixo documentation: ${DOCS_URL}`,
  `API reference (the machine API this server calls): ${API_DOCS_URL}`,
  `MCP endpoint: ${MCP_URL} (Streamable HTTP). Send the header "Authorization: Bearer <requester token>" on the connection.`,
  `Tokens: POST ${TOKEN_ENDPOINT} with grant_type=client_credentials; client id/secret from ${CLIENTS_PAGE}.`,
  "Tools: afixo_list_purposes (no input), afixo_disclose {handle, purpose}, afixo_health.",
].join("\n");

export interface Purpose {
  name: string;
  description: string;
}

interface Outcome {
  result: CallToolResult;
  /** what gets logged: allow, deny, no_token, invalid_purpose, http_503, unreachable … */
  outcome: string;
}

export function createServer(upstream: Upstream): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "afixo_list_purposes",
    {
      title: "List Afixo purposes",
      description:
        "The purpose vocabulary: every purpose a requester may state when asking for a disclosure, " +
        "as [{name, description}]. No input; no token needed.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    () => timed("afixo_list_purposes", () => listPurposes(upstream)),
  );

  server.registerTool(
    "afixo_disclose",
    {
      title: "Disclose a subject's data for a purpose",
      description:
        "Ask Afixo for a subject's data (by handle) for one purpose. Returns the disclosure decision: " +
        'on allow {decision:"allow", persona, fields, withheld, decision_id}; on deny ' +
        '{decision:"deny", reason, decision_id} (a deny is a valid answer, not an error). ' +
        "Every call is recorded in the subject's audit log. Needs a requester token on the MCP connection.",
      inputSchema: z.object({
        handle: z.string().min(1).describe('The subject\'s Afixo handle, e.g. "alice".'),
        purpose: z.string().min(1).describe('A purpose name from afixo_list_purposes, e.g. "shipping".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ handle, purpose }) => timed("afixo_disclose", () => disclose(upstream, handle, purpose)),
  );

  server.registerTool(
    "afixo_health",
    {
      title: "Afixo API health",
      description: "Calls the machine API's /v1/health and reports {ok, http_status, status, service, version}.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    () => timed("afixo_health", () => health(upstream)),
  );

  server.registerResource(
    "docs",
    "afixo://docs",
    {
      title: "Afixo documentation",
      description: "Where the Afixo docs and API reference live, and how to authenticate this MCP connection.",
      mimeType: "text/plain",
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: DOCS_TEXT }] }),
  );

  return server;
}

/** Runs a tool, logs `{tool, outcome, ms}` — never arguments, never results — and never throws. */
async function timed(tool: string, run: () => Promise<Outcome>): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const { result, outcome } = await run();
    log("tool", { tool, outcome, ms: Date.now() - started });
    return result;
  } catch (error) {
    log("tool", {
      tool,
      outcome: "exception",
      ms: Date.now() - started,
      message: error instanceof Error ? error.message : String(error),
    });
    return toolError(`${tool} failed with an internal error.`);
  }
}

async function listPurposes(upstream: Upstream): Promise<Outcome> {
  const what = "Listing purposes";
  let res: UpstreamResult;
  try {
    res = await upstream.get("/v1/purposes");
  } catch (error) {
    return unreachableOutcome(error, what);
  }
  if (res.status !== 200) return { result: upstreamFailure(what, res.status, res.body), outcome: `http_${res.status}` };
  if (!Array.isArray(res.body)) return { result: unexpected(what), outcome: "unexpected_body" };
  const purposes = res.body as Purpose[];
  return { result: jsonResult(purposes, { purposes }), outcome: "ok" };
}

async function disclose(upstream: Upstream, handle: string, purpose: string): Promise<Outcome> {
  const what = "Disclosure";
  // Nothing goes upstream without a token: the answer would be a 401 and the guidance is the same.
  if (!upstream.authenticated) return { result: notAuthenticated(), outcome: "no_token" };

  let res: UpstreamResult;
  try {
    res = await upstream.get(`/v1/disclose/${encodeURIComponent(handle)}`, { purpose });
  } catch (error) {
    return unreachableOutcome(error, what);
  }

  const decision = decisionOf(res.body);
  if (res.status === 200 && decision === "allow") {
    return { result: jsonResult(res.body, res.body as Record<string, unknown>), outcome: "allow" };
  }
  if (res.status === 403 && decision === "deny") {
    return { result: jsonResult(res.body, res.body as Record<string, unknown>), outcome: "deny" };
  }
  if (res.status === 200) return { result: unexpected(what), outcome: "unexpected_body" };
  if (res.status === 401) return { result: tokenRejected(res.body), outcome: "unauthenticated" };
  if (res.status === 400 && errorFields(res.body).error === "invalid_purpose") {
    return { result: invalidPurpose(purpose, await purposeNames(upstream)), outcome: "invalid_purpose" };
  }
  // 403 wrong_principal (a subject token), 404, 429, 5xx …: the API's own {error, message}.
  return { result: upstreamFailure(what, res.status, res.body), outcome: `http_${res.status}` };
}

async function health(upstream: Upstream): Promise<Outcome> {
  let res: UpstreamResult;
  try {
    res = await upstream.get("/v1/health");
  } catch (error) {
    if (!(error instanceof UpstreamUnreachable)) throw error;
    const report = { ok: false, error: "upstream_unreachable" };
    return { result: jsonResult(report, report), outcome: "unreachable" };
  }
  const body = isRecord(res.body) ? res.body : {};
  const report = { ...body, ok: res.status === 200, http_status: res.status };
  return { result: jsonResult(report, report), outcome: res.status === 200 ? "ok" : `http_${res.status}` };
}

/** The purpose names for an invalid_purpose message; best effort, never throws. */
async function purposeNames(upstream: Upstream): Promise<string[]> {
  try {
    const res = await upstream.get("/v1/purposes");
    if (res.status !== 200 || !Array.isArray(res.body)) return [];
    return res.body.flatMap((entry: unknown) => (isRecord(entry) && typeof entry["name"] === "string" ? [entry["name"]] : []));
  } catch {
    return [];
  }
}

function unreachableOutcome(error: unknown, what: string): Outcome {
  if (error instanceof UpstreamUnreachable) return { result: unreachable(what), outcome: "unreachable" };
  throw error;
}

function decisionOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const decision = body["decision"];
  return typeof decision === "string" ? decision : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text for every client plus `structuredContent` (an object, by the spec) for clients that read it. */
function jsonResult(text: unknown, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(text, null, 2) }], structuredContent: structured };
}
