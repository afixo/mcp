/**
 * The `integrate_afixo` prompt: the playbook for calling the machine API as a requester — credentials,
 * token, purposes, the disclose call, how to treat allow / deny / errors — with a short code sample
 * in the requested language. Static text: no upstream call, no auth, nothing personal.
 *
 * The samples follow afixo-services/docs/api.md (the REST contract); keep them in step with it.
 */
import { API_DOCS_URL, CLIENTS_PAGE, DOCS_URL, TOKEN_ENDPOINT } from "./errors";

export const PROMPT_NAME = "integrate_afixo";

export const LANGUAGES = ["curl", "typescript", "python", "rust"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "curl";

const ALIASES: Readonly<Record<string, Language>> = {
  curl: "curl",
  sh: "curl",
  shell: "curl",
  bash: "curl",
  http: "curl",
  typescript: "typescript",
  ts: "typescript",
  javascript: "typescript",
  js: "typescript",
  node: "typescript",
  nodejs: "typescript",
  deno: "typescript",
  bun: "typescript",
  python: "python",
  py: "python",
  python3: "python",
  rust: "rust",
  rs: "rust",
  reqwest: "rust",
};

/** Maps what the caller typed to a supported language; unknown names fall back to curl, and say so. */
export function resolveLanguage(requested: string | undefined): { language: Language; unsupported?: string } {
  const wanted = requested?.trim().toLowerCase() ?? "";
  if (wanted.length === 0) return { language: DEFAULT_LANGUAGE };
  const language = ALIASES[wanted];
  return language ? { language } : { language: DEFAULT_LANGUAGE, unsupported: requested!.trim() };
}

export function completeLanguage(prefix: string): Language[] {
  const wanted = prefix.trim().toLowerCase();
  return LANGUAGES.filter((language) => language.startsWith(wanted));
}

const API = "https://api.afixo.io";

/** The prompt's single user message. */
export function integrationPlaybook(requested: string | undefined): string {
  const { language, unsupported } = resolveLanguage(requested);
  const sample = SAMPLES[language];
  const note = unsupported
    ? `\n\n(No sample for ${JSON.stringify(unsupported)}; supported: ${LANGUAGES.join(", ")}. The curl sample below shows the exact requests to port.)`
    : "";
  return `${PLAYBOOK}

## Sample: ${LABELS[language]}${note}

\`\`\`${sample.fence}
${sample.code}
\`\`\`

Documentation: ${DOCS_URL} — API reference: ${API_DOCS_URL} and https://docs.afixo.io/api/machine/. This MCP server bundles
those pages (afixo_search_docs, resources afixo://docs/<slug>) and its afixo_list_purposes / afixo_disclose tools make the
same requests with the token configured on the MCP connection, to try the calls before writing code.`;
}

const PLAYBOOK = `Integrate Afixo as a *requester*. Follow the steps in order and apply the rules at the end to every call.

Afixo is a selective-disclosure identity API: a subject publishes personas under a handle, a requester asks for that
subject's data for a stated purpose, and the subject's own rules decide which persona and which fields are disclosed.
Every decision — allow or deny — is recorded in the subject's audit log.

## 1. Credentials
Create an API client on the dashboard: ${CLIENTS_PAGE}. You receive a \`client_id\` and a \`client_secret\`; the secret is
shown once ("Rotate secret" issues a new one without changing the id). Keep the secret in a secret store or an environment
variable — never in code, never in logs.

## 2. Token
\`POST ${TOKEN_ENDPOINT}\` — OAuth 2.0 client-credentials grant. Form-encoded body \`grant_type=client_credentials\`;
authenticate with HTTP Basic (\`client_id:client_secret\`) **or** with \`client_id\` / \`client_secret\` form fields.
Response: \`{"access_token": "…", "token_type": "Bearer", "expires_in": 3600}\`. The token is opaque and valid for one hour;
there is no refresh token — request a new one when it expires or when a call answers \`401 invalid_token\`.
Errors: \`400 invalid_request\`, \`400 unsupported_grant_type\`, \`401 invalid_client\`, \`429\` (rate limit).

## 3. Purposes
\`GET ${API}/v1/purposes\` (no authentication) returns the closed vocabulary as \`[{name, description}]\`:
social_display, professional, shipping, billing, age_verification, legal_kyc, support. Declare the purpose you actually
have: it is audited, and the subject's rules are keyed on it.

## 4. Disclose
\`GET ${API}/v1/disclose/{handle}?purpose={purpose}\` with \`Authorization: Bearer <access_token>\`; \`purpose\` is required.
- \`200\` — allow: \`{"decision":"allow","decision_id":"…","persona":"legal","fields":{"full_name":"…"},"withheld":["dob"]}\`.
  Exactly one persona, the fields the winning rule releases, and the *names* of the withheld fields (never their values).
- \`403\` with \`{"decision":"deny","decision_id":"…","reason":"no_matching_rule"}\` — deny. It is identical for "no rule",
  "unknown handle" and "persona deleted": you cannot tell them apart, and must not try.
- Anything else is an error \`{"error":"<code>","message":"…"}\`: \`400 invalid_request\` (purpose missing),
  \`400 invalid_purpose\`, \`401 invalid_token\` (get a new token, retry once), \`403 wrong_principal\` (a subject token; use a
  requester token), \`429\` (back off), \`503 upstream_unavailable\` (the decision could not be recorded, so none was made —
  retry later, never assume an answer).

## Rules
- **A deny is final.** Do not retry a denied request with another purpose, another client, or in a loop: every attempt is
  written to the subject's audit log under your client.
- **Cache nothing.** Responses are \`Cache-Control: no-store\`. Ask again each time you need the data; do not persist
  disclosed fields; do not persist the token — hold it in memory until \`expires_in\` and request a new one.
- **Quote the \`decision_id\`** in your logs and support conversations, for allow and deny alike: it is the audit row the
  subject can see. Log nothing else from the response — no field values.
- Only \`${API}\` — no other host, no console API, no browser session. Surface the \`{error, message}\` envelope in your own
  logs; never show internal details to end users.`;

const LABELS: Readonly<Record<Language, string>> = {
  curl: "curl",
  typescript: "TypeScript (fetch — Node 18+, Deno, Bun, Workers)",
  python: "Python (requests)",
  rust: "Rust (reqwest + tokio + serde_json)",
};

interface Sample {
  fence: string;
  code: string;
}

const SAMPLES: Readonly<Record<Language, Sample>> = {
  curl: {
    fence: "sh",
    code: `# 1. Token — HTTP Basic (or, instead of -u: -d client_id="$AFIXO_CLIENT_ID" -d client_secret="$AFIXO_CLIENT_SECRET")
TOKEN=$(curl -s ${API}/oauth/token \\
  -u "$AFIXO_CLIENT_ID:$AFIXO_CLIENT_SECRET" \\
  -d grant_type=client_credentials | jq -r .access_token)

# 2. Disclose — 200 allow and 403 deny are both final answers; anything else is {error, message}
curl -s -w '\\n%{http_code}\\n' "${API}/v1/disclose/alice?purpose=shipping" \\
  -H "Authorization: Bearer $TOKEN"
# → {"decision":"allow","decision_id":"…","persona":"…","fields":{…},"withheld":[…]} or
#   {"decision":"deny","decision_id":"…","reason":"no_matching_rule"}: keep the decision_id in your logs, never the fields`,
  },
  typescript: {
    fence: "ts",
    code: `const API = "${API}";

type Disclosure =
  | { decision: "allow"; decision_id: string; persona: string; fields: Record<string, string>; withheld: string[] }
  | { decision: "deny"; decision_id: string; reason: string };

// 1. Token — client-credentials grant, HTTP Basic. Valid for one hour; there is no refresh token.
async function getToken(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(\`\${API}/oauth/token\`, {
    method: "POST",
    headers: {
      authorization: \`Basic \${btoa(\`\${clientId}:\${clientSecret}\`)}\`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(\`token: HTTP \${res.status}\`); // 401 invalid_client, 400 unsupported_grant_type
  const { access_token } = (await res.json()) as { access_token: string; expires_in: number };
  return access_token;
}

// 2. Disclose — 200 allow and 403 deny are both final answers; anything else is {error, message}.
async function disclose(token: string, handle: string, purpose: string): Promise<Disclosure> {
  const url = \`\${API}/v1/disclose/\${encodeURIComponent(handle)}?purpose=\${encodeURIComponent(purpose)}\`;
  const res = await fetch(url, { headers: { authorization: \`Bearer \${token}\` } });
  const body = (await res.json()) as Disclosure & { error?: string; message?: string };
  if (res.status === 200 || (res.status === 403 && body.decision === "deny")) return body;
  // 400 invalid_purpose, 401 invalid_token (get a new token), 403 wrong_principal, 429, 503 upstream_unavailable
  throw new Error(\`disclose: HTTP \${res.status} \${body.error}: \${body.message}\`);
}

const token = await getToken(process.env.AFIXO_CLIENT_ID!, process.env.AFIXO_CLIENT_SECRET!);
const answer = await disclose(token, "alice", "shipping");
console.log(answer.decision, answer.decision_id); // log the decision_id, never the fields`,
  },
  python: {
    fence: "python",
    code: `import os
from urllib.parse import quote

import requests

API = "${API}"


def get_token() -> str:
    """Client-credentials grant, HTTP Basic. The token lasts one hour; there is no refresh token."""
    r = requests.post(
        f"{API}/oauth/token",
        auth=(os.environ["AFIXO_CLIENT_ID"], os.environ["AFIXO_CLIENT_SECRET"]),
        data={"grant_type": "client_credentials"},
        timeout=10,
    )
    r.raise_for_status()  # 401 invalid_client, 400 unsupported_grant_type
    return r.json()["access_token"]


def disclose(token: str, handle: str, purpose: str) -> dict:
    """200 allow and 403 deny are both final answers; anything else is {error, message}."""
    r = requests.get(
        f"{API}/v1/disclose/{quote(handle, safe='')}",
        params={"purpose": purpose},
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    body = r.json()
    if r.status_code == 200 or (r.status_code == 403 and body.get("decision") == "deny"):
        return body
    # 400 invalid_purpose, 401 invalid_token (get a new token), 403 wrong_principal, 429, 503 upstream_unavailable
    raise RuntimeError(f"disclose: HTTP {r.status_code} {body.get('error')}: {body.get('message')}")


answer = disclose(get_token(), "alice", "shipping")
print(answer["decision"], answer["decision_id"])  # log the decision_id, never the fields`,
  },
  rust: {
    fence: "rust",
    code: `// Cargo.toml: reqwest = { version = "0.12", features = ["json"] }
//             tokio = { version = "1", features = ["macros", "rt-multi-thread"] }, serde_json = "1"
use serde_json::Value;

const API: &str = "${API}";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let http = reqwest::Client::new();

    // 1. Token — client-credentials grant, HTTP Basic. Valid for one hour; there is no refresh token.
    let token: Value = http
        .post(format!("{API}/oauth/token"))
        .basic_auth(std::env::var("AFIXO_CLIENT_ID")?, Some(std::env::var("AFIXO_CLIENT_SECRET")?))
        .form(&[("grant_type", "client_credentials")])
        .send().await?
        .error_for_status()? // 401 invalid_client, 400 unsupported_grant_type
        .json().await?;
    let access_token = token["access_token"].as_str().ok_or("no access_token in the token response")?;

    // 2. Disclose — 200 allow and 403 deny are both final answers; anything else is {error, message}.
    let res = http
        .get(format!("{API}/v1/disclose/{}", "alice"))
        .query(&[("purpose", "shipping")])
        .bearer_auth(access_token)
        .send().await?;
    let status = res.status();
    let body: Value = res.json().await?;
    if status == 200 || (status == 403 && body["decision"] == "deny") {
        println!("{} {}", body["decision"], body["decision_id"]); // log the decision_id, never the fields
    } else {
        // 400 invalid_purpose, 401 invalid_token (get a new token), 403 wrong_principal, 429, 503 upstream_unavailable
        return Err(format!("disclose: HTTP {status} {}: {}", body["error"], body["message"]).into());
    }
    Ok(())
}`,
  },
};
