/** Runtime configuration, resolved once at startup from env + argv.
 *
 *  Design rule: the API key is read from the environment and never crosses the
 *  tool boundary — it is never a tool parameter and never echoed in a response.
 */

export interface McpConfig {
  apiKey: string;
  baseUrl?: string;
  /** Tier-3 mutating tools are registered only when this is true. */
  allowWrites: boolean;
  /** Hard ceiling on quota-consuming calls for the lifetime of this process. */
  maxQuotaCalls: number;
}

export class ConfigError extends Error {}

const DEFAULT_MAX_QUOTA_CALLS = 100;

/**
 * An agent can loop. Every scored row and every enrichment check consumes a
 * row of the tenant's monthly quota, so an unattended loop can burn a paying
 * customer's plan in minutes. The ceiling is the guard against that; it is
 * deliberately low by default and must be raised on purpose.
 */
function parseMaxQuotaCalls(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_QUOTA_CALLS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new ConfigError(
      `KAIDN_MCP_MAX_QUOTA_CALLS must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
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

  return {
    apiKey,
    baseUrl,
    allowWrites,
    maxQuotaCalls: parseMaxQuotaCalls(env.KAIDN_MCP_MAX_QUOTA_CALLS),
  };
}
