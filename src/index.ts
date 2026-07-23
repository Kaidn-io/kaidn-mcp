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

import { SERVER_VERSION as VERSION } from "./server.js";
export { SERVER_VERSION } from "./server.js";

const HELP = `kaidn-mcp — Model Context Protocol server for the Kaidn fraud-scoring API

Usage
  kaidn-mcp [options]

Options
  --http                 Serve Streamable HTTP instead of stdio  [KAIDN_MCP_TRANSPORT=http]
  --host <addr>          HTTP bind address (default 127.0.0.1)   [KAIDN_MCP_HOST]
  --port <n>             HTTP port (default 8765)                [KAIDN_MCP_PORT]
  --allow-writes         Register the mutating tools             [KAIDN_MCP_ALLOW_WRITES=1]
  --help, -h             Show this help
  --version, -v          Show the version

Environment
  KAIDN_API_KEY              Required. Your secret key from https://kaidn.io.
                             Read from the environment only — never a CLI flag,
                             never a tool argument.
  KAIDN_API_URL              API base URL (default https://api.kaidn.io)
  KAIDN_MCP_MAX_QUOTA_CALLS  Quota ceiling per process (default 100)
  KAIDN_MCP_HTTP_TOKEN       Require 'Authorization: Bearer <token>' on HTTP

Precedence: CLI flags override environment variables.

Docs: https://github.com/Kaidn-io/kaidn-mcp
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

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
