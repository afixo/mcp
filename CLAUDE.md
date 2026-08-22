# afixo-mcp

Remote MCP server for Afixo: the Cloudflare Worker `afixo-mcp` on **mcp.afixo.io**, Streamable HTTP at `/mcp`.
It lets an AI agent act as an Afixo *requester*: list the purpose vocabulary, call the disclosure endpoint.
Single environment — a push to `master` deploys production.

```
MCP client ─ Authorization: Bearer <requester token> ─► afixo-mcp ─ /mcp ─► createMcpHandler (stateless)
     tools ─► src/upstream.ts ─ API binding ─► afixo-api (machine mode, host api.afixo.io) ─► gateway :8081
```

## How it is built

- `createMcpHandler` from `agents/mcp/server` (Agents SDK ≥ 0.20) with MCP SDK v2 `@modelcontextprotocol/server@2.0.0`
  (pinned exactly: the Agents release dictates it). **Stateless**: one fresh `McpServer` per request, **no Durable
  Object, no KV**, nothing to migrate. `McpAgent` is deprecated upstream — do not reintroduce it.
- Serves the 2026-07-28 protocol and, through the handler's default legacy lane, 2025-era clients (`initialize` +
  `tools/call` POSTs). `GET`/`DELETE /mcp` are 405: there are no sessions. Both eras are covered by tests.
- Host/Origin: on the custom domain no Host check (Cloudflare routing is the guarantee), on localhost only localhost.
  Non-browser clients (no `Origin`) always pass; browser Origins are accepted for localhost only. CORS is the
  wrapper's default — if a browser client is ever wanted, set `corsOptions` and `allowedOriginHostnames` together.

## Auth model

- The MCP client configures `Authorization: Bearer <afixo requester token>` on its connection. The factory reads
  it from `requestInfo` and the Upstream forwards it **unchanged** on every upstream call — never parsed,
  stored or logged.
- No header → tools that need auth return an MCP *tool error* (`isError: true`) that explains
  `POST https://api.afixo.io/oauth/token` (client credentials from the dashboard's API clients page). A 401 from
  the API gives the same guidance. Never a thrown exception, never a crash.
- `POST /oauth/token` is **not** a tool: secrets never flow through tool calls.
- TODO: MCP OAuth — this server acting as an OAuth resource server (protected-resource metadata, token
  verification, `authInfo`) — is the follow-up. Until then: bearer passthrough only.

## Hard rules

1. **Secrets never through tools; bearer passthrough only.** No token exchange, caching, rewriting or logging.
2. **Upstream only via the machine API**: `GET /v1/health`, `GET /v1/purposes`, `GET /v1/disclose/{handle}?purpose=`.
   Never the console API, never `origin*.afixo.io`, never the cluster. New paths need afixo-api's allowlist first.
3. Upstream requests are `new Request(MACHINE_API_URL + path)` → `env.API.fetch`: the hostname (`api.afixo.io`) is
   what selects machine mode in afixo-api. A loopback `MACHINE_API_URL` (or no binding) means a direct `fetch`
   (local dev only — under `wrangler dev` the binding exists but is "[not connected]" and answers 503).
4. **No DO, no KV, no D1** unless documented here with the reason. Nothing auto-provisions on deploy.
5. A deny (`403 {decision:"deny"}`) is a normal tool result. Only "cannot answer" is a tool error.
6. Logs are one JSON line: method, path, tool, outcome, status, ms. Never headers, tokens, disclosed values or
   bodies (`test/mcp.test.ts` asserts it). Every `/mcp` response is `Cache-Control: no-store`.
7. Tool names and schemas are the contract: `afixo_list_purposes`, `afixo_disclose {handle, purpose}`,
   `afixo_health`; resource `afixo://docs`. Changing them breaks every configured agent.

## Commands

```sh
pnpm install                 # node 24, pnpm 11 (packageManager); lockfile committed
pnpm dev                     # wrangler dev on :8787, reads .dev.vars (cp .dev.vars.example .dev.vars)
pnpm check                   # typecheck + test — run before handing work back
pnpm typecheck | pnpm test   # tsc --noEmit; vitest inside workerd (vitest-pool-workers), `pnpm test:watch` to iterate
pnpm types                   # regenerate worker-configuration.d.ts after editing wrangler.jsonc; commit it (CI runs --check)
pnpm wrangler deploy --dry-run --outdir dist   # bundle without credentials (what CI does)
pnpm run deploy              # wrangler deploy (production) — CI does this on every push to master
```

## Layout

```
src/index.ts        fetch entry: GET / and /healthz (JSON), /mcp → one cached createMcpHandler per env, request log
src/server.ts       McpServer factory: the three tools, the docs resource, server instructions, tool outcome log
src/upstream.ts     machine API client: binding vs direct fetch, Authorization passthrough, JSON parsing
src/errors.ts       tool-error builders: not authenticated, token rejected, invalid purpose, upstream failure…
src/log.ts          JSON line logger
test/helpers.ts     same-isolate fake `API` binding, 2025-era JSON-RPC helper, canned machine API (docs/api.md shapes)
test/mcp.test.ts    handshake, each tool for 200/403/401/400, passthrough, fallback, resources, "never logs a token"
test/modern.test.ts the official SDK v2 client (2026-07-28 lane)   test/http.test.ts plain routes   test/upstream.test.ts URL rules
wrangler.jsonc      name, custom domain, vars.MACHINE_API_URL, services.API → afixo-api; worker-configuration.d.ts is generated
.github/workflows   ci.yml (types --check, typecheck, test, deploy --dry-run) · deploy.yml (master / dispatch → production)
```

## Local dev

`.dev.vars` → `MACHINE_API_URL=http://localhost:8081`: the gateway's machine listener from afixo-services (`make dev`),
fetched directly. To go through a local afixo-api instead: `wrangler dev -c wrangler.jsonc -c ../afixo-api/wrangler.jsonc`
with `MACHINE_API_URL=http://api.localhost` (a hostname in afixo-api's local `MACHINE_HOSTS`).

## Cross-repo

- `afixo-api`: machine-mode allowlist and bearer passthrough; its `MACHINE_HOSTS` must contain the hostname of our
  `MACHINE_API_URL`. Deploy it before this Worker on a fresh account (the service binding needs a target).
- `afixo-services/docs/api.md`: the REST contract this server maps — disclose shapes, error envelope `{error, message}`.
- `afixo-web`: the dashboard (API clients at `/app/clients`). `documents` → docs.afixo.io, linked here, never mirrored.
- GitHub secrets for deploy: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

## Git

Default branch `master`; remote `git@github.com:afixo/afixo-mcp.git`. **Never `git push`. Always ask before `git commit`.**
