/**
 * Tool errors. An MCP *tool error* is an ordinary result flagged `isError: true`: the agent
 * reads the message and can recover (get a token, pick a valid purpose). Nothing here throws;
 * a thrown exception would surface as an opaque JSON-RPC error instead of guidance.
 *
 * Messages may name endpoints and purpose names. They never echo a token or upstream field values.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";

export const MCP_URL = "https://mcp.afixo.io/mcp";
export const TOKEN_ENDPOINT = "https://api.afixo.io/oauth/token";
export const CLIENTS_PAGE = "https://afixo.io/app/clients";
export const DOCS_URL = "https://docs.afixo.io";
export const API_DOCS_URL = "https://docs.afixo.io/api/overview/";

export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** How to get and configure a requester token — the one message every unauthenticated call gets. */
export const HOW_TO_AUTHENTICATE = [
  `Configure the MCP client with the HTTP header \`Authorization: Bearer <token>\` on its connection to ${MCP_URL}.`,
  `Obtain a token with OAuth2 client credentials: POST ${TOKEN_ENDPOINT} with grant_type=client_credentials,`,
  `using the client_id / client_secret of an API client created on the dashboard (${CLIENTS_PAGE}).`,
  `Tokens expire after one hour. Secrets are never passed through tool calls. Docs: ${API_DOCS_URL}`,
].join("\n");

/** The MCP connection carries no Authorization header at all — nothing was sent upstream. */
export function notAuthenticated(): CallToolResult {
  return toolError(`Not authenticated: this MCP connection has no Afixo requester token.\n${HOW_TO_AUTHENTICATE}`);
}

/** The machine API answered 401: a token was sent but is invalid or expired. */
export function tokenRejected(body: unknown): CallToolResult {
  const { error, message } = errorFields(body);
  const detail = message ?? error ?? "invalid_token";
  return toolError(`Not authenticated: the Afixo API rejected the token (${detail}).\n${HOW_TO_AUTHENTICATE}`);
}

export function invalidPurpose(purpose: string, valid: readonly string[]): CallToolResult {
  const list =
    valid.length > 0
      ? valid.map((name) => `- ${name}`).join("\n")
      : "(the purpose vocabulary could not be loaded — call afixo_list_purposes)";
  return toolError(`Invalid purpose ${JSON.stringify(purpose)}. Valid purposes:\n${list}`);
}

/** Any other non-success answer: surface the status and the API's own `{error, message}`. */
export function upstreamFailure(what: string, status: number, body: unknown): CallToolResult {
  return toolError(`${what} failed: the Afixo API answered ${httpSummary(status, body)}.`);
}

/** `HTTP 503 upstream_unavailable — policy down`: the status plus the API's own envelope, for messages and result rows. */
export function httpSummary(status: number, body: unknown): string {
  const { error, message } = errorFields(body);
  return `HTTP ${status}${error ? ` ${error}` : ""}${message ? ` — ${message}` : ""}`;
}

export function unreachable(what: string): CallToolResult {
  return toolError(`${what} failed: the Afixo API could not be reached. Retry; if it persists see ${DOCS_URL}.`);
}

/** The API's error envelope is `{"error":"<snake_code>","message":"<human>"}`; read it defensively. */
export function errorFields(body: unknown): { error?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  const out: { error?: string; message?: string } = {};
  if (typeof record["error"] === "string") out.error = record["error"];
  if (typeof record["message"] === "string") out.message = record["message"];
  return out;
}

/** A success status with a body that is not what the contract promises (docs/api.md in afixo-services). */
export function unexpected(what: string): CallToolResult {
  return toolError(`${what} failed: the Afixo API answered with an unexpected response shape.`);
}
