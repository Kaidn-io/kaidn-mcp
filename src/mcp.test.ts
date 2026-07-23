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

describe("transport selection", () => {
  it("defaults to stdio", () => {
    expect(loadConfig([], KEY).transport).toBe("stdio");
  });

  it("switches to http by flag or env", () => {
    expect(loadConfig(["--http"], KEY).transport).toBe("http");
    expect(loadConfig([], { ...KEY, KAIDN_MCP_TRANSPORT: "http" }).transport).toBe("http");
  });

  it("binds loopback by default", () => {
    const c = loadConfig(["--http"], KEY);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8765);
  });

  it("accepts --port and --host in both spellings", () => {
    expect(loadConfig(["--http", "--port", "9000"], KEY).port).toBe(9000);
    expect(loadConfig(["--http", "--port=9001"], KEY).port).toBe(9001);
  });

  it("refuses to bind a public interface with no auth", () => {
    // The process holds the tenant's API key; an open port spends their quota.
    expect(() => loadConfig(["--http", "--host", "0.0.0.0"], KEY)).toThrow(ConfigError);
  });

  it("allows a public bind once a bearer token is set", () => {
    const c = loadConfig(["--http", "--host", "0.0.0.0"], {
      ...KEY,
      KAIDN_MCP_HTTP_TOKEN: "s3cret",
    });
    expect(c.host).toBe("0.0.0.0");
    expect(c.httpToken).toBe("s3cret");
  });

  it("does not gate stdio on the bind check", () => {
    expect(() => loadConfig(["--host", "0.0.0.0"], KEY)).not.toThrow();
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
