#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { buildServer } from "./server.js";
import { QuotaGuard } from "./quota.js";
import { startHttpServer } from "./http.js";

export { buildServer } from "./server.js";
export { loadConfig, ConfigError } from "./config.js";
export { QuotaGuard, QuotaExceededError } from "./quota.js";
export { startHttpServer } from "./http.js";
export type { McpConfig, TransportKind } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const quota = new QuotaGuard(config.maxQuotaCalls);
  const mode = config.allowWrites ? "writes ENABLED" : "read-only";

  if (config.transport === "http") {
    process.stderr.write(
      `kaidn-mcp: starting (http, ${mode}, quota ceiling ${config.maxQuotaCalls})\n`,
    );
    await startHttpServer(config, quota);
    return;
  }

  // stdout is the MCP transport in stdio mode — every human-readable line must
  // go to stderr or it corrupts the protocol stream.
  process.stderr.write(
    `kaidn-mcp: ready (stdio, ${mode}, quota ceiling ${config.maxQuotaCalls})\n`,
  );
  await buildServer(config, quota).connect(new StdioServerTransport());
}

// Only run when executed as a binary, so the module stays importable in tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      err instanceof ConfigError
        ? `kaidn-mcp: ${message}\n`
        : `kaidn-mcp: fatal: ${message}\n`,
    );
    process.exit(1);
  });
}
