/**
 * The MCP surface: five tools, the bundled documentation as resources, one prompt.
 *
 * `createMcpHandler` (src/index.ts) calls `createServer` for every MCP request — stateless: no
 * session, no Durable Object — with an Upstream that carries that request's Authorization header.
 * Tools only ever see outcomes, never the header. A deny is a normal result; only "cannot answer"
 * (no token, bad token, unknown purpose, upstream failure) is a tool error.
 */
import { McpServer, type CallToolResult, completable } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DOCS, DOCS_URI, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, searchDocs } from "./docs";
import {
  API_DOCS_URL,
  CLIENTS_PAGE,
  DOCS_URL,
  MCP_URL,
  TOKEN_ENDPOINT,
  errorFields,
  httpSummary,
  invalidPurpose,
  notAuthenticated,
  tokenRejected,
  toolError,
  unexpected,
  unreachable,
  upstreamFailure,
} from "./errors";
import { log } from "./log";
import { LANGUAGES, PROMPT_NAME, completeLanguage, integrationPlaybook, resolveLanguage } from "./prompt";
import { type Upstream, type UpstreamResult, UpstreamUnreachable } from "./upstream";

export const SERVER_INFO = { name: "afixo-mcp", version: "0.2.0" };

/** How many purposes one afixo_disclose_many call may ask for (the vocabulary has seven). */
export const DISCLOSE_MANY_MAX = 20;

export const INSTRUCTIONS = [
  "Afixo is a selective-disclosure identity API. A subject publishes personas under a handle; a requester asks for",
  "that subject's data for a stated purpose and Afixo's policy decides which fields are disclosed.",
  "Call afixo_list_purposes to learn the purpose vocabulary, then afixo_disclose(handle, purpose).",
  "afixo_disclose_many(handle, purposes?) asks several purposes in one call (the whole vocabulary by default) — for a",
  "genuine multi-purpose need, never to work around a deny: every purpose asked is audited.",
  "A deny is a normal, final answer: do not probe other purposes to get around it.",
  "afixo_disclose and afixo_disclose_many need the MCP connection to carry an Afixo requester token",
  "(HTTP header `Authorization: Bearer <token>`).",
  "The documentation is bundled: afixo_search_docs(query) finds the page, the resources afixo://docs/<slug> hold the",
  "full text (afixo://docs lists them). The prompt integrate_afixo(language?) is the playbook for writing an integration.",
].join(" ");

export const DOCS_TEXT = [
  `Afixo documentation: ${DOCS_URL}`,
  `API reference (the machine API this server calls): ${API_DOCS_URL}`,
  `MCP endpoint: ${MCP_URL} (Streamable HTTP). Send the header "Authorization: Bearer <requester token>" on the connection.`,
  `Tokens: POST ${TOKEN_ENDPOINT} with grant_type=client_credentials; client id/secret from ${CLIENTS_PAGE}.`,
  "Tools: afixo_list_purposes (no input), afixo_disclose {handle, purpose}, afixo_disclose_many {handle, purposes?},",
  "afixo_search_docs {query, limit?}, afixo_health. Prompt: integrate_afixo {language?}.",
  "Bundled pages (text/markdown resources, searchable with afixo_search_docs):",
  ...DOCS.map((doc) => `- ${doc.uri} — ${doc.title} (${doc.url})`),
].join("\n");

export interface Purpose {
  name: string;
  description: string;
}

/** One row of afixo_disclose_many. `error` is set when the API could not decide for that purpose. */
export interface DiscloseRow {
  purpose: string;
  decision: "allow" | "deny" | "error";
  persona?: string;
  fields?: Record<string, unknown>;
  withheld?: string[];
  decision_id?: string;
  reason?: string;
  error?: string;
}

interface Outcome {
  result: CallToolResult;
  /** what gets logged: allow, deny, no_token, invalid_purpose, http_503, unreachable … */
  outcome: string;
}

/** What one GET /v1/disclose answered, before it is turned into a tool result or a row. */
type Decision =
  | { kind: "allow"; body: Record<string, unknown> }
  | { kind: "deny"; body: Record<string, unknown> }
  | { kind: "unauthenticated"; body: unknown }
  | { kind: "invalid_purpose"; body: unknown }
  | { kind: "unexpected" }
  | { kind: "http"; status: number; body: unknown }
  | { kind: "unreachable" };

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
    "afixo_disclose_many",
    {
      title: "Disclose a subject's data for several purposes",
      description:
        "Ask Afixo for a subject's data (by handle) for several purposes at once — every purpose of the vocabulary " +
        "when `purposes` is omitted. The calls run in parallel and each purpose is decided and audited on its own. " +
        'Returns {handle, results:[{purpose, decision:"allow"|"deny"|"error", persona?, fields?, withheld?, ' +
        "decision_id?, reason?, error?}]}: a deny is a valid answer, an error row means the API could not decide for " +
        "that purpose (e.g. an invalid purpose). Use it for a genuine multi-purpose need, never to work around a deny. " +
        "Needs a requester token on the MCP connection.",
      inputSchema: z.object({
        handle: z.string().min(1).describe('The subject\'s Afixo handle, e.g. "alice".'),
        purposes: z
          .array(z.string().min(1))
          .max(DISCLOSE_MANY_MAX)
          .optional()
          .describe(`Purpose names from afixo_list_purposes; omitted or empty = all of them (at most ${DISCLOSE_MANY_MAX}).`),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ handle, purposes }) => timed("afixo_disclose_many", () => discloseMany(upstream, handle, purposes)),
  );

  server.registerTool(
    "afixo_search_docs",
    {
      title: "Search the Afixo documentation",
      description:
        "Case-insensitive search over the documentation bundled in this server (getting started, API overview, " +
        "machine API, purposes, disclosure rules, decision algorithm). Returns [{slug, title, uri, snippet}] — the " +
        "snippet is the best-matching paragraph; read the whole page with the resource afixo://docs/<slug>. " +
        "No token needed.",
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe('Words or a phrase, e.g. "invalid_token" or "specificity".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .optional()
          .describe(`Maximum number of pages returned, 1..${SEARCH_LIMIT_MAX} (default ${SEARCH_LIMIT_DEFAULT}).`),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ query, limit }) => timed("afixo_search_docs", async () => searchOutcome(query, limit ?? SEARCH_LIMIT_DEFAULT)),
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
    DOCS_URI,
    {
      title: "Afixo documentation",
      description:
        "Where the Afixo docs and API reference live, how to authenticate this MCP connection, " +
        "and the list of the documentation pages bundled as afixo://docs/<slug> resources.",
      mimeType: "text/plain",
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: DOCS_TEXT }] }),
  );

  for (const doc of DOCS) {
    server.registerResource(
      doc.slug,
      doc.uri,
      {
        title: doc.title,
        description: `${doc.description} Source: ${doc.url}`,
        mimeType: "text/markdown",
      },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: doc.text }] }),
    );
  }

  server.registerPrompt(
    PROMPT_NAME,
    {
      title: "Integrate Afixo as a requester",
      description:
        "The integration playbook: API client credentials, the client-credentials token, the purpose vocabulary, " +
        "the disclose call, how to treat allow / deny / errors, and the rules (a deny is final, cache nothing, quote " +
        `the decision_id) — with a short code sample in the requested language (${LANGUAGES.join(", ")}; default curl).`,
      argsSchema: z.object({
        language: completable(
          z.string().describe(`Language of the code sample: ${LANGUAGES.join(", ")} (default curl).`),
          completeLanguage,
        ).optional(),
      }),
    },
    ({ language }) => {
      const resolved = resolveLanguage(language);
      log("prompt", { prompt: PROMPT_NAME, language: resolved.language, fallback: resolved.unsupported !== undefined });
      return {
        description: `How to integrate Afixo as a requester, with a ${resolved.language} sample.`,
        messages: [{ role: "user", content: { type: "text", text: integrationPlaybook(language) } }],
      };
    },
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

/** One GET /v1/disclose/{handle}?purpose= — shared by afixo_disclose and afixo_disclose_many. */
async function discloseOne(upstream: Upstream, handle: string, purpose: string): Promise<Decision> {
  let res: UpstreamResult;
  try {
    res = await upstream.get(`/v1/disclose/${encodeURIComponent(handle)}`, { purpose });
  } catch (error) {
    if (error instanceof UpstreamUnreachable) return { kind: "unreachable" };
    throw error;
  }
  const decision = decisionOf(res.body);
  if (res.status === 200 && decision === "allow") return { kind: "allow", body: res.body as Record<string, unknown> };
  if (res.status === 403 && decision === "deny") return { kind: "deny", body: res.body as Record<string, unknown> };
  if (res.status === 200) return { kind: "unexpected" };
  if (res.status === 401) return { kind: "unauthenticated", body: res.body };
  if (res.status === 400 && errorFields(res.body).error === "invalid_purpose") return { kind: "invalid_purpose", body: res.body };
  // 403 wrong_principal (a subject token), 404, 429, 5xx …: the API's own {error, message}.
  return { kind: "http", status: res.status, body: res.body };
}

async function disclose(upstream: Upstream, handle: string, purpose: string): Promise<Outcome> {
  const what = "Disclosure";
  // Nothing goes upstream without a token: the answer would be a 401 and the guidance is the same.
  if (!upstream.authenticated) return { result: notAuthenticated(), outcome: "no_token" };

  const decision = await discloseOne(upstream, handle, purpose);
  switch (decision.kind) {
    case "allow":
      return { result: jsonResult(decision.body, decision.body), outcome: "allow" };
    case "deny":
      return { result: jsonResult(decision.body, decision.body), outcome: "deny" };
    case "unexpected":
      return { result: unexpected(what), outcome: "unexpected_body" };
    case "unauthenticated":
      return { result: tokenRejected(decision.body), outcome: "unauthenticated" };
    case "invalid_purpose":
      return { result: invalidPurpose(purpose, await purposeNames(upstream)), outcome: "invalid_purpose" };
    case "unreachable":
      return { result: unreachable(what), outcome: "unreachable" };
    case "http":
      return { result: upstreamFailure(what, decision.status, decision.body), outcome: `http_${decision.status}` };
  }
}

async function discloseMany(upstream: Upstream, handle: string, requested: readonly string[] | undefined): Promise<Outcome> {
  if (!upstream.authenticated) return { result: notAuthenticated(), outcome: "no_token" };

  // The purposes to ask, each once, in the order given — or the whole vocabulary, fetched once.
  let purposes = [...new Set((requested ?? []).map((purpose) => purpose.trim()).filter((purpose) => purpose.length > 0))];
  if (purposes.length === 0) {
    const what = "Listing purposes";
    let res: UpstreamResult;
    try {
      res = await upstream.get("/v1/purposes");
    } catch (error) {
      return unreachableOutcome(error, what);
    }
    if (res.status !== 200) return { result: upstreamFailure(what, res.status, res.body), outcome: `http_${res.status}` };
    if (!Array.isArray(res.body)) return { result: unexpected(what), outcome: "unexpected_body" };
    purposes = namesOf(res.body);
    if (purposes.length === 0) return { result: unexpected(what), outcome: "unexpected_body" };
  }

  const decisions = await Promise.all(purposes.map((purpose) => discloseOne(upstream, handle, purpose)));

  // The token is the same on every call: one 401 means all of them, and the guidance is the one afixo_disclose gives.
  const rejected = decisions.find((decision) => decision.kind === "unauthenticated");
  if (rejected) return { result: tokenRejected(rejected.body), outcome: "unauthenticated" };

  const results = purposes.map((purpose, i) => rowOf(purpose, decisions[i]!));
  const counts = { allow: 0, deny: 0, error: 0 };
  for (const row of results) counts[row.decision]++;
  return {
    result: {
      content: [{ type: "text", text: discloseTable(handle, results, counts) }],
      structuredContent: { handle, results },
    },
    outcome: `allow=${counts.allow} deny=${counts.deny} error=${counts.error}`,
  };
}

function rowOf(purpose: string, decision: Decision): DiscloseRow {
  switch (decision.kind) {
    case "allow": {
      const { persona, fields, withheld, decision_id } = decision.body as {
        persona?: unknown;
        fields?: unknown;
        withheld?: unknown;
        decision_id?: unknown;
      };
      return {
        purpose,
        decision: "allow",
        ...(typeof persona === "string" ? { persona } : {}),
        ...(isRecord(fields) ? { fields } : {}),
        ...(Array.isArray(withheld) ? { withheld: withheld.filter((key): key is string => typeof key === "string") } : {}),
        ...(typeof decision_id === "string" ? { decision_id } : {}),
      };
    }
    case "deny": {
      const { reason, decision_id } = decision.body as { reason?: unknown; decision_id?: unknown };
      return {
        purpose,
        decision: "deny",
        ...(typeof reason === "string" ? { reason } : {}),
        ...(typeof decision_id === "string" ? { decision_id } : {}),
      };
    }
    case "invalid_purpose":
      return { purpose, decision: "error", error: httpSummary(400, decision.body) };
    case "unauthenticated":
      return { purpose, decision: "error", error: httpSummary(401, decision.body) };
    case "http":
      return { purpose, decision: "error", error: httpSummary(decision.status, decision.body) };
    case "unexpected":
      return { purpose, decision: "error", error: "the Afixo API answered with an unexpected response shape" };
    case "unreachable":
      return { purpose, decision: "error", error: "the Afixo API could not be reached" };
  }
}

/** A compact, aligned table: one line per purpose; field values on the allow rows (they are the answer). */
function discloseTable(handle: string, rows: readonly DiscloseRow[], counts: { allow: number; deny: number; error: number }): string {
  const header = ["purpose", "decision", "persona", "decision_id", "detail"];
  const cells = rows.map((row) => [row.purpose, row.decision, row.persona ?? "-", row.decision_id ?? "-", detailOf(row)]);
  const widths = header.map((name, i) => Math.max(name.length, ...cells.map((cell) => cell[i]!.length)));
  const line = (cell: readonly string[]) =>
    cell.map((value, i) => (i === cell.length - 1 ? value : value.padEnd(widths[i]!))).join("  ").trimEnd();
  const summary = `Disclosure of ${JSON.stringify(handle)} for ${rows.length} purpose${rows.length === 1 ? "" : "s"}: ${counts.allow} allow, ${counts.deny} deny, ${counts.error} error`;
  return [summary, line(header), ...cells.map(line)].join("\n");
}

function detailOf(row: DiscloseRow): string {
  if (row.decision === "allow") {
    const fields = Object.entries(row.fields ?? {}).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    const withheld = row.withheld ?? [];
    return `fields: ${fields.length > 0 ? fields.join(", ") : "(none)"}; withheld: ${withheld.length > 0 ? withheld.join(", ") : "(none)"}`;
  }
  if (row.decision === "deny") return row.reason ?? "deny";
  return row.error ?? "error";
}

function searchOutcome(query: string, limit: number): Outcome {
  const results = searchDocs(query, limit);
  const text =
    results.length === 0
      ? `No bundled documentation page matches ${JSON.stringify(query)}. Pages: ${DOCS.map((doc) => doc.slug).join(", ")}. Full docs: ${DOCS_URL}`
      : results.map((hit, i) => `${i + 1}. ${hit.title} — ${hit.uri}\n   ${hit.snippet}`).join("\n");
  return { result: { content: [{ type: "text", text }], structuredContent: { query, results } }, outcome: `hits_${results.length}` };
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
    return namesOf(res.body);
  } catch {
    return [];
  }
}

function namesOf(entries: unknown[]): string[] {
  return entries.flatMap((entry) => (isRecord(entry) && typeof entry["name"] === "string" ? [entry["name"]] : []));
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
