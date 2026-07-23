import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "./config.js";
import { QuotaGuard, QuotaExceededError } from "./quota.js";

const KEY = { KAIDN_API_KEY: "k_test" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("requires an API key", () => {
    expect(() => loadConfig([], {})).toThrow(ConfigError);
  });

  it("never accepts the key from argv", () => {
    // The key must come from the environment only — a key passed on the command
    // line leaks into process listings and shell history.
    expect(() => loadConfig(["--api-key", "k_leaked"], {})).toThrow(ConfigError);
  });

  it("is read-only by default", () => {
    expect(loadConfig([], KEY).allowWrites).toBe(false);
  });

  it("enables writes only when asked", () => {
    expect(loadConfig(["--allow-writes"], KEY).allowWrites).toBe(true);
    expect(loadConfig([], { ...KEY, KAIDN_MCP_ALLOW_WRITES: "1" }).allowWrites).toBe(true);
  });

  it("defaults to a conservative quota ceiling", () => {
    expect(loadConfig([], KEY).maxQuotaCalls).toBe(100);
  });

  it("rejects a nonsense ceiling rather than silently ignoring it", () => {
    expect(() => loadConfig([], { ...KEY, KAIDN_MCP_MAX_QUOTA_CALLS: "0" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig([], { ...KEY, KAIDN_MCP_MAX_QUOTA_CALLS: "lots" })).toThrow(
      ConfigError,
    );
  });
});

describe("QuotaGuard", () => {
  it("stops an agent loop at the ceiling", () => {
    const q = new QuotaGuard(3);
    q.spend();
    q.spend();
    q.spend();
    expect(() => q.spend()).toThrow(QuotaExceededError);
    expect(q.remaining).toBe(0);
  });

  it("refuses a batch that would overshoot, rather than partially spending", () => {
    const q = new QuotaGuard(5);
    q.spend(4);
    expect(() => q.spend(2)).toThrow(QuotaExceededError);
    expect(q.remaining).toBe(1);
  });

  it("reports remaining budget so the agent can self-pace", () => {
    const q = new QuotaGuard(10);
    q.spend(4);
    expect(q.remaining).toBe(6);
    expect(q.footer()).toContain("4/10");
  });
});
