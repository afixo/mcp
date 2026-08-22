---
title: Machine API
description: The requester surface at api.afixo.io — token, disclose, purposes and health.
url: https://docs.afixo.io/api/machine/
---

Base URL **`https://api.afixo.io`**. Exactly four routes exist on this host, plus
`OPTIONS` preflights on them. Everything else — the whole console surface and
`/api/*` included — is `404 {"error":"not_found"}` from the edge Worker, before the
request reaches the cluster.

> **Status: skeleton (2026-08-22)**
>
> `GET /v1/health` and `GET /v1/purposes` work end to end. `POST /oauth/token` and
> `GET /v1/disclose/…` are routed by the gateway to the `auth` and `disclosure`
> services, which are skeletons answering `501 not_implemented`.

## `GET /v1/health`

No authentication. Liveness of the gateway.

```json
{ "status": "…", "service": "…", "version": "…" }
```

## `GET /v1/purposes`

No authentication. The [purpose vocabulary](https://docs.afixo.io/concepts/purposes/), published so that a
client can be written against it.

```sh
curl -s https://api.afixo.io/v1/purposes
```

```json
[
  { "name": "social_display", "description": "Show this person in a social or community context" },
  { "name": "professional", "description": "Represent this person in a professional or workplace context" },
  { "name": "shipping", "description": "Deliver physical goods to this person" },
  { "name": "billing", "description": "Invoice or charge this person" },
  { "name": "age_verification", "description": "Confirm this person meets an age requirement" },
  { "name": "legal_kyc", "description": "Satisfy a legal know-your-customer obligation" },
  { "name": "support", "description": "Provide customer support to this person" }
]
```

## `POST /oauth/token`

OAuth 2.0 client-credentials grant. The body is form-encoded with
`grant_type=client_credentials`; the client authenticates with HTTP Basic **or** with
`client_id` / `client_secret` form fields.

**HTTP Basic**

```sh
curl -s https://api.afixo.io/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials
```

**Form fields**

```sh
curl -s https://api.afixo.io/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=client_credentials \
  -d client_id="$CLIENT_ID" \
  -d client_secret="$CLIENT_SECRET"
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{ "access_token": "…", "token_type": "Bearer", "expires_in": 3600 }
```

The token is opaque, bound to the requester, and valid for one hour. There is no
refresh token: request a new one when it expires.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid_request` | malformed body, missing credentials |
| 400 | `unsupported_grant_type` | anything but `client_credentials` |
| 401 | `invalid_client` | unknown `client_id` or wrong secret; carries `WWW-Authenticate` |
| 429 | | Cloudflare rate limit on this path |

## `GET /v1/disclose/{handle}`

The product endpoint. Requires `Authorization: Bearer <requester token>` and the
`purpose` query parameter.

```sh
curl -s "https://api.afixo.io/v1/disclose/alice?purpose=shipping" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

**Allow** — exactly one persona, filtered by the winning rule's ceiling and allow-list;
withheld fields are reported by key name only:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{
  "decision": "allow",
  "decision_id": "019…",
  "persona": "legal",
  "fields": { "full_name": "…", "email": "…" },
  "withheld": ["dob", "postal_address"]
}
```

**Deny** — identical for "no rule", "unknown handle" and "persona gone", so handles
cannot be enumerated:

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json

{ "decision": "deny", "decision_id": "…", "reason": "no_matching_rule" }
```

Both outcomes are written to the subject's audit log before the response is sent;
`decision_id` is the audit row's `event_id`.

| Status | `error` / `reason` | When |
|---|---|---|
| 400 | `invalid_request` | `purpose` missing |
| 400 | `invalid_purpose` | `purpose` not in the vocabulary |
| 401 | `invalid_token` | no bearer, or an expired or revoked one; carries `WWW-Authenticate` |
| 403 | `wrong_principal` | a subject (dashboard) token on this host |
| 403 | `no_matching_rule` | the uniform deny above |
| 429 | | Cloudflare rate limit on this path |
| 503 | `upstream_unavailable` | a service, including `audit`, is unreachable; the disclosure fails closed |

## CORS

The machine listener answers CORS for the origin `https://afixo.io` — the dashboard's
[Explorer](https://docs.afixo.io/dashboard/explorer/) acts as a requester from the browser. Preflights are
forwarded unchanged by the Workers. No other origin is allowed; server-to-server
clients do not need one.
