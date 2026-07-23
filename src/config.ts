/** Runtime configuration, resolved once at startup from env + argv.
 *
 *  Design rule: the API key is read from the environment and never crosses the
 *  tool boundary — it is never a tool parameter and never echoed in a response.
 */

export type TransportKind = "stdio" | "http";

export interface McpConfig {
  apiKey: string;
  baseUrl?: string;
  /** Tier-3 mutating tools are registered only when this is true. */
  allowWrites: boolean;
  /** Hard ceiling on quota-consuming calls for the lifetime of this process. */
  maxQuotaCalls: number;
  /** stdio for a local client; http for remote agents and containers. */
  transport: TransportKind;
  /** http only */
  host: string;
  /** http only */
  port: number;
  /** http only: require `Authorization: Bearer <token>` when set. */
  httpToken?: string;
}

export class ConfigError extends Error {}

const DEFAULT_MAX_QUOTA_CALLS = 100;
const DEFAULT_PORT = 8765;
const DEFAULT_HOST = "127.0.0.1";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * An agent can loop. Every scored row and every enrichment check consumes a
 * row of the tenant's monthly quota, so an unattended loop can burn a paying
 * customer's plan in minutes. The ceiling is the guard against that; it is
 * deliberately low by default and must be raised on purpose.
 */
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Reads `--flag value` or `--flag=value`. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) return next;
  }
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): McpConfig {
  const apiKey = env.KAIDN_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "KAIDN_API_KEY is not set. Create a key at https://kaidn.io and export it " +
        "as KAIDN_API_KEY (never pass it as a tool argument).",
    );
  }

  const baseUrl = env.KAIDN_API_URL?.trim() || undefined;

  // Writes are opt-in. Default read-only means an agent cannot silently change a
  // tenant's blocklists or scoring behaviour.
  const allowWrites =
    argv.includes("--allow-writes") || env.KAIDN_MCP_ALLOW_WRITES === "1";

  const transport: TransportKind =
    argv.includes("--http") || env.KAIDN_MCP_TRANSPORT === "http" ? "http" : "stdio";

  const host = flagValue(argv, "--host") ?? env.KAIDN_MCP_HOST?.trim() ?? DEFAULT_HOST;
  const port = parsePositiveInt(
    flagValue(argv, "--port") ?? env.KAIDN_MCP_PORT,
    DEFAULT_PORT,
    "port",
  );
  const httpToken = env.KAIDN_MCP_HTTP_TOKEN?.trim() || undefined;

  // In HTTP mode this process holds the tenant's API key, so whoever reaches the
  // port can spend that tenant's quota. Binding beyond loopback with no bearer
  // token publishes exactly that — refuse outright rather than warn and proceed.
  if (transport === "http" && !LOOPBACK.has(host) && !httpToken) {
    throw new ConfigError(
      `Refusing to bind ${host} without authentication. This server holds your ` +
        `Kaidn API key, so an open port lets anyone spend your quota. Either set ` +
        `KAIDN_MCP_HTTP_TOKEN to require a bearer token, or bind ${DEFAULT_HOST} ` +
        `and put a reverse proxy in front.`,
    );
  }

  return {
    apiKey,
    baseUrl,
    allowWrites,
    maxQuotaCalls: parsePositiveInt(
      env.KAIDN_MCP_MAX_QUOTA_CALLS,
      DEFAULT_MAX_QUOTA_CALLS,
      "KAIDN_MCP_MAX_QUOTA_CALLS",
    ),
    transport,
    host,
    port,
    ...(httpToken ? { httpToken } : {}),
  };
}
