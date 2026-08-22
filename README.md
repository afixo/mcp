# afixo-mcp

Remote [MCP](https://modelcontextprotocol.io) server for [Afixo](https://afixo.io). It lets an AI agent act as an
Afixo *requester*: look up the purpose vocabulary and ask for a subject's data for a stated purpose — Afixo's
policy decides what is disclosed, and every decision is audited. It also carries the documentation an agent needs
to integrate Afixo: the key pages as resources, a search tool and an integration prompt.

- **Endpoint:** `https://mcp.afixo.io/mcp` (Streamable HTTP)
- **Auth:** the HTTP header `Authorization: Bearer <requester token>` on the MCP connection
- **Docs:** https://docs.afixo.io — API reference: https://docs.afixo.io/api/overview/

## Connect

### 1. Get a requester token

Create an API client on the dashboard (https://afixo.io/app/clients), then exchange its credentials:

```sh
curl -s -X POST https://api.afixo.io/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials
# {"access_token":"…","token_type":"Bearer","expires_in":3600}
```

Tokens last one hour. The MCP server never sees your client secret — it only forwards the bearer you give it.

### 2. Point your MCP client at the server

Claude Code:

```sh
claude mcp add --transport http afixo https://mcp.afixo.io/mcp \
  --header "Authorization: Bearer $AFIXO_TOKEN"
```

Generic JSON configuration (Claude Desktop, Cursor, Windsurf, …):

```json
{
  "mcpServers": {
    "afixo": {
      "type": "http",
      "url": "https://mcp.afixo.io/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Clients that only speak stdio can bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
`npx mcp-remote https://mcp.afixo.io/mcp --header "Authorization: Bearer <token>"`.

Without a token the tools still answer — with an error that explains how to get one. Nothing crashes. The server
does not run an OAuth flow of its own (no authorization server, no protected-resource metadata): the header is the
whole auth model, so hosts never try to open a browser for it.

## Tools

| Tool | Input | Answer |
|---|---|---|
| `afixo_list_purposes` | — | the purpose vocabulary `[{name, description}]`; no token needed |
| `afixo_disclose` | `{handle, purpose}` | allow: `{decision:"allow", persona, fields, withheld, decision_id}` · deny: `{decision:"deny", reason, decision_id}` — a deny is a normal answer, not an error |
| `afixo_disclose_many` | `{handle, purposes?}` | one disclosure per purpose, in parallel — every purpose of the vocabulary when `purposes` is omitted: `{handle, results:[{purpose, decision:"allow"\|"deny"\|"error", persona?, fields?, withheld?, decision_id?, reason?, error?}]}` plus a text table |
| `afixo_search_docs` | `{query, limit?}` | case-insensitive search over the bundled documentation: `[{slug, title, uri, snippet}]` (`limit` 1..10, default 5); no token needed |
| `afixo_health` | — | `{ok, http_status, status, service, version}` |

Tool errors you can act on: no or expired token (how to authenticate), unknown purpose (the valid purposes are
listed). `afixo_disclose_many` reports a purpose the API could not decide — an invalid name, an outage — as an
`error` row and still decides the others; a rejected token is one tool error for the whole call.

## Prompt

`integrate_afixo` (argument `language`, optional: `curl` by default, `typescript`, `python`, `rust`) returns the
integration playbook as a user message: client credentials from the dashboard, `POST /oauth/token`, the purpose
vocabulary, `GET /v1/disclose/{handle}?purpose=`, what allow / deny / each error mean, the rules (a deny is final —
never retry other purposes to get around it; cache nothing; quote the `decision_id` in logs) and a short code sample
in the requested language. Clients that support argument completion get the language names offered.

## Resources

| URI | Content |
|---|---|
| `afixo://docs` | `text/plain` index: where the docs live, how to authenticate, the bundled pages below |
| `afixo://docs/getting-started` | Getting started |
| `afixo://docs/api-overview` | API overview — hosts, error shape, status codes |
| `afixo://docs/api-machine` | Machine API — `/oauth/token`, `/v1/disclose`, `/v1/purposes`, `/v1/health` |
| `afixo://docs/purposes` | Purposes — the closed vocabulary |
| `afixo://docs/disclosure-rules` | Disclosure rules — grants, specificity, ceiling and allow-list |
| `afixo://docs/decision-algorithm` | The decision algorithm — steps, invariants, failure modes |

The pages are `text/markdown` copies of https://docs.afixo.io, bundled into the Worker (`docs/`), refreshed with
`scripts/sync-docs.sh`; `afixo_search_docs` searches exactly these.

## Try it with curl

```sh
MCP=https://mcp.afixo.io/mcp
curl -s -X POST $MCP -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
curl -s -X POST $MCP -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
curl -s -X POST $MCP -H "authorization: Bearer $AFIXO_TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"afixo_disclose","arguments":{"handle":"alice","purpose":"shipping"}}}'
curl -s -X POST $MCP -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"afixo_search_docs","arguments":{"query":"invalid_token"}}}'
curl -s -X POST $MCP -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":5,"method":"prompts/get","params":{"name":"integrate_afixo","arguments":{"language":"python"}}}'
```

`GET https://mcp.afixo.io/` returns `{"name":"afixo-mcp","mcp":"/mcp","docs":"https://docs.afixo.io"}`;
`GET /healthz` returns `{"ok":true}`.

## Development

```sh
pnpm install                      # node 24, pnpm 11
cp .dev.vars.example .dev.vars    # MACHINE_API_URL=http://localhost:8081 (the local gateway from afixo-services)
pnpm dev                          # http://localhost:8787/mcp
pnpm check                        # typecheck + tests (vitest inside workerd)
pnpm wrangler deploy --dry-run --outdir dist
scripts/sync-docs.sh              # refresh docs/*.md from ../documents (then commit the copies)
```

Deployed, every upstream call goes over the `API` service binding to the `afixo-api` Worker — the machine
API at `api.afixo.io`. Locally a loopback `MACHINE_API_URL` is fetched directly. See `CLAUDE.md` for the
rules of the repo.

## Deploy

Push to `master` → GitHub Actions (`deploy.yml`) → `wrangler deploy` to the custom domain `mcp.afixo.io`.
Needs the repository secret `CLOUDFLARE_API_TOKEN` and the variable `CLOUDFLARE_ACCOUNT_ID`; deploy `afixo-api`
first on a fresh account so the service binding has a target.
