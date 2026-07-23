#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, ConfigError } from "./config.js";
import { buildServer } from "./server.js";

export { buildServer } from "./server.js";
export { loadConfig, ConfigError } from "./config.js";
export type { McpConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = buildServer(config);

  // stdout is the MCP transport — every human-readable line must go to stderr
  // or it corrupts the protocol stream.
  process.stderr.write(
    `kaidn-mcp: ready (${config.allowWrites ? "writes ENABLED" : "read-only"}, ` +
      `quota ceiling ${config.maxQuotaCalls})\n`,
  );

  await server.connect(new StdioServerTransport());
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
