---
title: Getting started
description: Register an API client, obtain a token and make your first disclosure request.
url: https://docs.afixo.io/getting-started/
---

Afixo answers one question for an API client: *which version of this person may I
see, for this stated reason?* This page takes an integrator from zero to a
disclosure decision.

> **Status: skeleton (2026-08-22)**
>
> The `auth`, `identity`, `disclosure` and `audit` services are skeletons that answer
> `501 not_implemented`; `policy`, the gateway and the decision engine are complete.
> Today `GET /v1/health` and `GET /v1/purposes` work end to end. Sign-in,
> `POST /oauth/token` and `GET /v1/disclose/…` follow the contract below but do not
> yet return real decisions.

1. **Sign in at [afixo.io](https://afixo.io).** Subjects authenticate with GitHub.
   The browser never holds a token: the session is a sealed cookie set by the edge
   (see [the session boundary](https://docs.afixo.io/architecture/session-boundary/)).

2. **Register an API client.** *Dashboard → API clients → Register.* You receive a
   `client_id` and a `client_secret`. The secret is shown **once**; the server keeps
   only a SHA-256 hash. If it is lost, *Rotate secret* issues a new one without
   changing the `client_id`, so rules that name the client keep working.

3. **Get a rule from the subject.** Nothing is disclosed until the subject writes a
   [rule](https://docs.afixo.io/concepts/disclosure-rules/) that matches your client and/or the purpose
   you declare (*Dashboard → Policies*). Without one, every call is a `403 deny`.

4. **Get a bearer token** with the OAuth 2.0 client-credentials grant. Tokens are
   opaque and valid for one hour; there is no refresh token — request a new one.

   **HTTP Basic**

   ```sh
   curl -s https://api.afixo.io/oauth/token \
     -u "$CLIENT_ID:$CLIENT_SECRET" \
     -d grant_type=client_credentials
   ```

   **Form fields**

   ```sh
   curl -s https://api.afixo.io/oauth/token \
     -d grant_type=client_credentials \
     -d client_id="$CLIENT_ID" \
     -d client_secret="$CLIENT_SECRET"
   ```

   ```json
   { "access_token": "…", "token_type": "Bearer", "expires_in": 3600 }
   ```

   Wrong credentials are `401 invalid_client`; a grant type other than
   `client_credentials` is `400 unsupported_grant_type`. Token responses are
   `Cache-Control: no-store`.

5. **Request a disclosure.** Name the subject by handle and declare one of the
   [seven purposes](https://docs.afixo.io/concepts/purposes/). The `purpose` query parameter is required.

   ```sh
   curl -s "https://api.afixo.io/v1/disclose/alice?purpose=shipping" \
     -H "Authorization: Bearer $ACCESS_TOKEN"
   ```

   If a rule matches, you get exactly one persona, filtered by the rule's ceiling
   and allow-list. Withheld fields are reported by **key name only**:

   ```json
   {
     "decision": "allow",
     "decision_id": "019…",
     "persona": "legal",
     "fields": { "full_name": "Alice Example", "postal_address": "1 Example Street, Example Town" },
     "withheld": ["dob"]
   }
   ```

   If nothing matches — no rule, an unknown handle, or a persona the subject has
   since deleted — the answer is the same `403` every time:

   ```json
   { "decision": "deny", "decision_id": "019…", "reason": "no_matching_rule" }
   ```

   Other answers: `400 invalid_purpose` for a name outside the vocabulary,
   `401 invalid_token` for a missing or expired bearer, `403 wrong_principal` for a
   subject token on this host, and `503 upstream_unavailable` when the audit
   service is down — a disclosure that cannot be recorded is refused, never served.

6. **Keep the `decision_id`.** Every decision, allow or deny, is written to the
   subject's [audit log](https://docs.afixo.io/concepts/audit-log/) before the answer is sent, and the
   `decision_id` is that row's id: a subject can find exactly the call you quote.

## Next

- [Machine API reference](https://docs.afixo.io/api/machine/) — every route on `api.afixo.io` with full examples
- [Disclosure rules](https://docs.afixo.io/concepts/disclosure-rules/) — what the subject controls, and how specificity is ranked
- [Explorer](https://docs.afixo.io/dashboard/explorer/) — the dashboard panel that makes these same calls from the browser
