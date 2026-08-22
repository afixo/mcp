/**
 * Machine API client — the only way this Worker talks to Afixo.
 *
 *   tool ─► createUpstream(env, authorization).get(path)
 *             ├─ binding:  new Request(`${MACHINE_API_URL}${path}`) ─► env.API.fetch ─► afixo-api
 *             │     afixo-api selects *machine mode* from the request's hostname (api.afixo.io) and
 *             │     forwards the requester's own Authorization to the gateway's machine listener.
 *             └─ direct fetch to MACHINE_API_URL when it is a loopback address — `wrangler dev`
 *                   against the local gateway on http://localhost:8081 — or when there is no binding.
 *                   (Under `wrangler dev` the binding exists but is "[not connected]" and answers 503,
 *                   and no service binding can reach a port on this machine: loopback is unambiguous.)
 *
 * Only the machine surface is ever called: GET /v1/health, GET /v1/purposes, GET /v1/disclose/{handle}.
 * POST /oauth/token is deliberately absent — secrets never flow through tool calls.
 * The MCP client's Authorization header is forwarded unchanged; it is never parsed or logged.
 */

export const DEFAULT_MACHINE_API_URL = "https://api.afixo.io";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What this module needs from the bindings; the generated `Env` satisfies it. */
export interface UpstreamEnv {
  API?: Fetcher;
  MACHINE_API_URL?: string;
}

export interface UpstreamResult {
  status: number;
  /** the parsed JSON body, or `null` when the body was empty or not JSON */
  body: unknown;
}

export interface Upstream {
  /** whether the MCP connection carries an Authorization header (forwarded as-is on every call) */
  readonly authenticated: boolean;
  /** `GET ${path}?${query}`; resolves for every HTTP status, rejects with UpstreamUnreachable only */
  get(path: string, query?: Record<string, string>): Promise<UpstreamResult>;
}

export class UpstreamUnreachable extends Error {
  constructor(cause: unknown) {
    super("machine API unreachable", { cause });
    this.name = "UpstreamUnreachable";
  }
}

/** `MACHINE_API_URL` without a trailing slash, defaulting to the production machine API. */
export function machineApiUrl(env: UpstreamEnv): string {
  const raw = env.MACHINE_API_URL?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_MACHINE_API_URL).replace(/\/+$/, "");
}

/** localhost, 127.0.0.1 or [::1] — "a gateway on this machine", which only a direct fetch can reach. */
export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function createUpstream(env: UpstreamEnv, authorization: string | null): Upstream {
  const base = machineApiUrl(env);
  const api = env.API && !isLoopback(base) ? env.API : undefined;
  const send = api ? (request: Request) => api.fetch(request) : (request: Request) => fetch(request);
  const authenticated = authorization !== null && authorization.trim().length > 0;

  return {
    authenticated,
    async get(path, query) {
      const url = new URL(base + path);
      if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

      const headers = new Headers({ accept: "application/json", "user-agent": "afixo-mcp" });
      if (authenticated) headers.set("authorization", authorization as string);

      // Redirects are never followed: a bearer must not leak to wherever a redirect points.
      const request = new Request(url, { method: "GET", headers, redirect: "manual" });

      let response: Response;
      try {
        response = await send(request);
      } catch (cause) {
        throw new UpstreamUnreachable(cause);
      }

      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, body };
    },
  };
}
