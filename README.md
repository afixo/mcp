# afixo-mcp

Remote [MCP](https://modelcontextprotocol.io) server for [Afixo](https://afixo.io). It lets an AI agent act as an
Afixo *requester*: look up the purpose vocabulary and ask for a subject's data for a stated purpose — Afixo's
policy decides what is disclosed, and every decision is audited.

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

Without a token the tools still answer — with an error that explains how to get one. Nothing crashes.

## Tools

| Tool | Input | Answer |
|---|---|---|
| `afixo_list_purposes` | — | the purpose vocabulary `[{name, description}]`; no token needed |
| `afixo_disclose` | `{handle, purpose}` | allow: `{decision:"allow", persona, fields, withheld, decision_id}` · deny: `{decision:"deny", reason, decision_id}` — a deny is a normal answer, not an error |
| `afixo_health` | — | `{ok, http_status, status, service, version}` |

Resource `afixo://docs` points at the documentation. Tool errors you can act on: no or expired token
(how to authenticate), unknown purpose (the valid purposes are listed).

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
```

Deployed, every upstream call goes over the `API` service binding to the `afixo-api` Worker — the machine
API at `api.afixo.io`. Locally a loopback `MACHINE_API_URL` is fetched directly. See `CLAUDE.md` for the
rules of the repo.

## Deploy

Push to `master` → GitHub Actions (`deploy.yml`) → `wrangler deploy` to the custom domain `mcp.afixo.io`.
Needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; deploy `afixo-api` first
on a fresh account so the service binding has a target.
