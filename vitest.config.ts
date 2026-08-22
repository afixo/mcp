import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests run inside workerd (Miniflare) with the real wrangler.jsonc, so the same Request/Response,
 * streams and fetch semantics as production apply.
 *
 * The `API` service binding targets afixo-api, which is not running here: Miniflare gets a stub in
 * its place so the config loads. Tests never rely on that stub — they call the Worker's `fetch` with
 * their own `env` (test/helpers.ts) whose `API` is a same-isolate fake they can inspect.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { MACHINE_API_URL: "https://api.afixo.io" },
        serviceBindings: {
          API: () => Response.json({ error: "not_found", message: "no afixo-api in tests" }, { status: 404 }),
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
