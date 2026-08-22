import { describe, expect, it } from "vitest";
import { DEFAULT_MACHINE_API_URL, isLoopback, machineApiUrl } from "../src/upstream";

describe("machineApiUrl", () => {
  it("defaults to the production machine API and strips trailing slashes", () => {
    expect(machineApiUrl({})).toBe(DEFAULT_MACHINE_API_URL);
    expect(machineApiUrl({ MACHINE_API_URL: "" })).toBe("https://api.afixo.io");
    expect(machineApiUrl({ MACHINE_API_URL: "   " })).toBe("https://api.afixo.io");
    expect(machineApiUrl({ MACHINE_API_URL: " http://localhost:8081/ " })).toBe("http://localhost:8081");
    expect(machineApiUrl({ MACHINE_API_URL: "https://api-staging.afixo.io//" })).toBe("https://api-staging.afixo.io");
  });
});

describe("isLoopback", () => {
  it("recognises loopback hosts and nothing else", () => {
    for (const url of ["http://localhost:8081", "http://127.0.0.1:8081", "http://[::1]:8081", "https://localhost"]) {
      expect(isLoopback(url), url).toBe(true);
    }
    for (const url of ["https://api.afixo.io", "http://api.localhost", "http://localhost.evil.test", "not a url", ""]) {
      expect(isLoopback(url), url).toBe(false);
    }
  });
});
