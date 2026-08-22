---
title: API overview
description: Hosts, authentication, error shape and status codes shared by both API surfaces.
url: https://docs.afixo.io/api/overview/
---

Afixo exposes two HTTP surfaces. Both are served by the same gateway and are reached
only through Cloudflare Workers; nothing public resolves to the cluster.

| Surface | Base URL | Caller | Authentication |
|---|---|---|---|
| [Machine API](https://docs.afixo.io/api/machine/) | `https://api.afixo.io` | requesters (API clients) | `Authorization: Bearer <requester token>` from `POST /oauth/token` |
| [Console API](https://docs.afixo.io/api/console/) | `https://afixo.io/api/v1` | the dashboard, in a browser | the session cookie; the edge swaps it for a bearer |

The console API is the dashboard's own API. It is documented so the contract is
explicit; it is not a surface for third parties, and its session cannot be obtained
outside a browser.

## Conventions

- Paths are versioned under `/v1/`; `/oauth/token` is the one exception.
- Ids are UUIDs; timestamps are RFC 3339; `sensitivity` is an integer `0..3`.
- Lists are bare JSON arrays.
- Responses that carry tokens or personal data are `Cache-Control: no-store`.
- The machine listener answers CORS for `https://afixo.io`, so the dashboard's
  Explorer can act as a requester from the browser.

## Errors

Every error, on both surfaces, has the same shape:

```json
{ "error": "<snake_code>", "message": "<human readable>" }
```

Where the OAuth 2.0 specification applies, the codes are the OAuth ones:
`invalid_request`, `invalid_client`, `invalid_token`, `unsupported_grant_type`. `401`
responses carry a `WWW-Authenticate` header. Internal details are logged, never
returned.

## Status codes

The gateway maps gRPC status from the services to HTTP:

| gRPC | HTTP | `error` |
|---|---|---|
| INVALID_ARGUMENT | 400 | `invalid_request`; `invalid_purpose` on disclose |
| UNAUTHENTICATED | 401 | `invalid_token` |
| PERMISSION_DENIED | 403 | `forbidden` |
| NOT_FOUND | 404 | `not_found` |
| ALREADY_EXISTS, FAILED_PRECONDITION | 409 | |
| RESOURCE_EXHAUSTED | 429 | |
| UNIMPLEMENTED | 501 | `not_implemented` — skeleton services |
| UNAVAILABLE, DEADLINE_EXCEEDED | 503 | `upstream_unavailable` — also when the audit service is down and a disclosure fails closed |
| anything else | 500 | `internal` |

Two deliberate exceptions to "not found is `404`": a disclosure for an unknown handle
is a `403 deny` like every other deny, and any console path requested on
`api.afixo.io` is a `404` from the edge before it reaches the cluster.

## Rate limits

Rate limiting is a Cloudflare WAF rule on `api.afixo.io`, not application code
(indicatively `/oauth/token` at 10/min and `/v1/disclose/*` at 120/min per IP). There
is no cache anywhere in the path.
