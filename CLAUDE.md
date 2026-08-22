# afixo-mcp

Remote MCP server for Afixo: the Cloudflare Worker `afixo-mcp` on **mcp.afixo.io**, Streamable HTTP at `/mcp`.
It lets an AI agent act as an Afixo *requester*: list the purpose vocabulary, call the disclosure endpoint (one
purpose or many), search and read the bundled documentation, get the integration playbook as a prompt.
Single environment — a push to `master` deploys production.

```
MCP client ─ Authorization: Bearer <requester token> ─► afixo-mcp ─ /mcp ─► createMcpHandler (stateless)
     tools ─► src/upstream.ts ─ API binding ─► afixo-api (machine mode, host api.afixo.io) ─► gateway :8081
     docs  ─► src/docs.ts ─ docs/*.md bundled as text modules (no I/O)
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
- The documentation pages in `docs/` are imported as text modules (`wrangler.jsonc` `rules` → `Text` for `**/*.md`,
  `declare module "*.md"` in the generated `worker-configuration.d.ts`) and parsed once per isolate (`src/docs.ts`).

## Auth model

- The MCP client configures `Authorization: Bearer <afixo requester token>` on its connection. The factory reads
  it from `requestInfo` and the Upstream forwards it **unchanged** on every upstream call — never parsed,
  stored or logged.
- No header → tools that need auth return an MCP *tool error* (`isError: true`) that explains
  `POST https://api.afixo.io/oauth/token` (client credentials from the dashboard's API clients page). A 401 from
  the API gives the same guidance. Never a thrown exception, never a crash.
- `POST /oauth/token` is **not** a tool: secrets never flow through tool calls.
- **Decided: header-based auth only. No MCP OAuth** — no authorization server, no protected-resource metadata
  (`/.well-known/oauth-protected-resource`), no `WWW-Authenticate` challenge on `/mcp`. Advertising any of it makes
  MCP hosts start an interactive OAuth flow that Afixo does not offer (requesters are machines with client
  credentials, not users in a browser). Do not add it.

## Hard rules

1. **Secrets never through tools; bearer passthrough only.** No token exchange, caching, rewriting or logging.
2. **Upstream only via the machine API**: `GET /v1/health`, `GET /v1/purposes`, `GET /v1/disclose/{handle}?purpose=`.
   Never the console API, never `origin*.afixo.io`, never the cluster. New paths need afixo-api's allowlist first.
3. Upstream requests are `new Request(MACHINE_API_URL + path)` → `env.API.fetch`: the hostname (`api.afixo.io`) is
   what selects machine mode in afixo-api. A loopback `MACHINE_API_URL` (or no binding) means a direct `fetch`
   (local dev only — under `wrangler dev` the binding exists but is "[not connected]" and answers 503).
4. **No DO, no KV, no D1** unless documented here with the reason. Nothing auto-provisions on deploy.
5. A deny (`403 {decision:"deny"}`) is a normal tool result. Only "cannot answer" is a tool error. In
   `afixo_disclose_many` a purpose the API could not decide is an `error` row, the others are still answered; a 401
   is one tool error for the whole call (the token is the same for every purpose); no token → nothing goes upstream.
6. Logs are one JSON line: method, path, tool, outcome, status, ms (prompt name and language for prompts). Never
   headers, tokens, disclosed values, search queries, bodies or prompt text (`test/mcp.test.ts` asserts it). Every
   `/mcp` response is `Cache-Control: no-store`.
7. Tool names and schemas are the contract: `afixo_list_purposes`, `afixo_disclose {handle, purpose}`,
   `afixo_disclose_many {handle, purposes?}`, `afixo_search_docs {query, limit?}`, `afixo_health`; resources
   `afixo://docs` (index) and `afixo://docs/<slug>`; prompt `integrate_afixo {language?}`. Changing them breaks
   every configured agent.
8. **`docs/*.md` are generated copies — never edit them by hand.** Refresh with `scripts/sync-docs.sh` (reads
   `../documents/src/content/docs`, converts MDX to plain markdown through `scripts/mdx-to-md.mjs`, adds `url:` to the
   front-matter) and commit the result. Adding a page: the `PAGES` list in the script, an import and an entry in
   `DOCS` in `src/docs.ts`, the README resources table. `test/docs.test.ts` fails on MDX leftovers.
9. The `integrate_afixo` samples follow `afixo-services/docs/api.md`; when that contract changes, change
   `src/prompt.ts` and `test/prompt.test.ts` with it.

## Commands

```sh
pnpm install                 # node 24, pnpm 11 (packageManager); lockfile committed
pnpm dev                     # wrangler dev on :8787, reads .dev.vars (cp .dev.vars.example .dev.vars)
pnpm check                   # typecheck + test — run before handing work back
pnpm typecheck | pnpm test   # tsc --noEmit; vitest inside workerd (vitest-pool-workers), `pnpm test:watch` to iterate
pnpm types                   # regenerate worker-configuration.d.ts after editing wrangler.jsonc; commit it (CI runs --check)
pnpm wrangler deploy --dry-run --outdir dist   # bundle without credentials (what CI does)
pnpm run deploy              # wrangler deploy (production) — CI does this on every push to master
scripts/sync-docs.sh [src]   # refresh docs/*.md from ../documents (or the given src/content/docs path); commit the copies
```

## Layout

```
src/index.ts        fetch entry: GET / and /healthz (JSON), /mcp → one cached createMcpHandler per env, request log
src/server.ts       McpServer factory: the five tools (shared discloseOne helper), docs resources, the prompt, instructions, tool outcome log
src/docs.ts         the bundled pages: imports docs/*.md, front-matter → {slug, title, description, url}, paragraphs, searchDocs
src/prompt.ts       integrate_afixo: the playbook text, language aliases, the curl / TypeScript / Python / Rust samples
src/upstream.ts     machine API client: binding vs direct fetch, Authorization passthrough, JSON parsing
src/errors.ts       tool-error builders: not authenticated, token rejected, invalid purpose, upstream failure…
src/log.ts          JSON line logger
docs/*.md           generated copies of six docs.afixo.io pages (scripts/sync-docs.sh) — afixo://docs/<slug>
scripts/            sync-docs.sh (the page list) · mdx-to-md.mjs (Starlight MDX → plain markdown)
test/helpers.ts     same-isolate fake `API` binding, 2025-era JSON-RPC helper, canned machine API (docs/api.md shapes)
test/mcp.test.ts    handshake, each tool for 200/403/401/400, disclose_many (parallel, rows, 401), search, resources, prompts, "never logs a token"
test/modern.test.ts the official SDK v2 client (2026-07-28 lane)   test/http.test.ts plain routes   test/upstream.test.ts URL rules
test/docs.test.ts   bundled pages are plain markdown, front-matter parsing, search ranking and snippets
test/prompt.test.ts language resolution, what every playbook variant must say, the samples' calls
wrangler.jsonc      name, custom domain, vars.MACHINE_API_URL, services.API → afixo-api, rules (Text **/*.md); worker-configuration.d.ts is generated
.github/workflows   ci.yml (types --check, typecheck, test, deploy --dry-run) · deploy.yml (master / dispatch → production)
```

## Local dev

`.dev.vars` → `MACHINE_API_URL=http://localhost:8081`: the gateway's machine listener from afixo-services (`make dev`),
fetched directly. To go through a local afixo-api instead: `wrangler dev -c wrangler.jsonc -c ../afixo-api/wrangler.jsonc`
with `MACHINE_API_URL=http://api.localhost` (a hostname in afixo-api's local `MACHINE_HOSTS`).

## Cross-repo

- `afixo-api`: machine-mode allowlist and bearer passthrough; its `MACHINE_HOSTS` must contain the hostname of our
  `MACHINE_API_URL`. Deploy it before this Worker on a fresh account (the service binding needs a target).
- `afixo-services/docs/api.md`: the REST contract this server maps — disclose shapes, error envelope `{error, message}`,
  what the `integrate_afixo` samples must match.
- `afixo-web`: the dashboard (API clients at `/app/clients`).
- `documents` → docs.afixo.io. Six of its pages are mirrored in `docs/` by `scripts/sync-docs.sh` (rule 8); everything
  else is linked, never copied.
- GitHub: secret `CLOUDFLARE_API_TOKEN`, variable `CLOUDFLARE_ACCOUNT_ID` for deploy.

## Git

Default branch `master`; remote `git@github.com:afixo/afixo-mcp.git`. **Never `git push`. Always ask before `git commit`.**
