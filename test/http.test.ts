import { describe, expect, it } from "vitest";
import { ORIGIN, call, envWith } from "./helpers";

describe("plain HTTP", () => {
  const env = envWith();

  it("GET / is the service card", async () => {
    const res = await call(env, new Request(`${ORIGIN}/`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ name: "afixo-mcp", mcp: "/mcp", docs: "https://docs.afixo.io" });
  });

  it("GET /healthz", async () => {
    const res = await call(env, new Request(`${ORIGIN}/healthz`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers 404 JSON for everything else", async () => {
    for (const path of ["/nope", "/mcp/extra", "/v1/purposes", "/oauth/token", "/healthz/"]) {
      const res = await call(env, new Request(`${ORIGIN}${path}`));
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await call(env, new Request(`${ORIGIN}/`, { method }));
      expect(res.status, method).toBe(404);
    }
  });

  it("never caches: every response is no-store", async () => {
    for (const path of ["/", "/healthz", "/nope"]) {
      const res = await call(env, new Request(`${ORIGIN}${path}`));
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });
});
