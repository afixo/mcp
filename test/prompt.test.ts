/**
 * The integrate_afixo prompt text (src/prompt.ts): language resolution and what every variant
 * of the playbook must say — the contract of afixo-services/docs/api.md.
 */
import { describe, expect, it } from "vitest";
import { LANGUAGES, completeLanguage, integrationPlaybook, resolveLanguage } from "../src/prompt";

describe("resolveLanguage", () => {
  it("defaults to curl, accepts aliases in any case, and falls back to curl for the unknown", () => {
    expect(resolveLanguage(undefined)).toEqual({ language: "curl" });
    expect(resolveLanguage("")).toEqual({ language: "curl" });
    expect(resolveLanguage(" Bash ")).toEqual({ language: "curl" });
    expect(resolveLanguage("TS")).toEqual({ language: "typescript" });
    expect(resolveLanguage("javascript")).toEqual({ language: "typescript" });
    expect(resolveLanguage("py")).toEqual({ language: "python" });
    expect(resolveLanguage("rs")).toEqual({ language: "rust" });
    expect(resolveLanguage("reqwest")).toEqual({ language: "rust" });
    expect(resolveLanguage("Go")).toEqual({ language: "curl", unsupported: "Go" });
  });

  it("completes prefixes", () => {
    expect(completeLanguage("")).toEqual([...LANGUAGES]);
    expect(completeLanguage("T")).toEqual(["typescript"]);
    expect(completeLanguage("zzz")).toEqual([]);
  });
});

describe("integrationPlaybook", () => {
  const RULES = [
    "https://afixo.io/app/clients",
    "POST https://api.afixo.io/oauth/token",
    "grant_type=client_credentials",
    "HTTP Basic",
    "expires_in",
    "GET https://api.afixo.io/v1/purposes",
    "GET https://api.afixo.io/v1/disclose/{handle}?purpose={purpose}",
    '"decision":"allow"',
    '"decision":"deny"',
    "no_matching_rule",
    "A deny is final",
    "Cache nothing",
    "Cache-Control: no-store",
    "decision_id",
    "invalid_purpose",
    "invalid_token",
    "wrong_principal",
    "upstream_unavailable",
  ];

  it("states the playbook for every language", () => {
    for (const language of [undefined, ...LANGUAGES]) {
      const text = integrationPlaybook(language);
      for (const rule of RULES) expect(text, `${language}: ${rule}`).toContain(rule);
      expect(text, language).toMatch(/```(sh|ts|python|rust)\n[\s\S]+\n```/);
    }
  });

  it("each sample makes the two calls of the contract", () => {
    const samples: Record<string, string> = {
      curl: integrationPlaybook("curl"),
      typescript: integrationPlaybook("typescript"),
      python: integrationPlaybook("python"),
      rust: integrationPlaybook("rust"),
    };
    for (const [language, text] of Object.entries(samples)) {
      const code = /```(?:sh|ts|python|rust)\n([\s\S]+?)\n```/.exec(text)![1]!;
      expect(code, language).toContain("/oauth/token");
      expect(code, language).toContain("client_credentials");
      expect(code, language).toContain("/v1/disclose/");
      expect(code, language).toContain("purpose");
      expect(code, language).toContain("decision_id");
      expect(code, language).toContain("403");
      expect(code.split("\n").length, language).toBeLessThan(60);
    }
    expect(samples["curl"]).toContain('-u "$AFIXO_CLIENT_ID:$AFIXO_CLIENT_SECRET"');
    expect(samples["curl"]).toContain('-H "Authorization: Bearer $TOKEN"');
    expect(samples["typescript"]).toContain("authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`");
    expect(samples["typescript"]).toContain("encodeURIComponent(handle)");
    expect(samples["python"]).toContain('auth=(os.environ["AFIXO_CLIENT_ID"], os.environ["AFIXO_CLIENT_SECRET"])');
    expect(samples["python"]).toContain('headers={"Authorization": f"Bearer {token}"}');
    expect(samples["rust"]).toContain(".basic_auth(");
    expect(samples["rust"]).toContain(".bearer_auth(access_token)");
    expect(samples["rust"]).toContain('.form(&[("grant_type", "client_credentials")])');
  });

  it("names the unsupported language and still gives the curl sample", () => {
    const text = integrationPlaybook("Go");
    expect(text).toContain('No sample for "Go"');
    expect(text).toContain("supported: curl, typescript, python, rust");
    expect(text).toContain("```sh\n");
  });
});
