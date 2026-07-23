import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpConfig } from "./config.js";
import type { QuotaGuard } from "./quota.js";
import { buildServer } from "./server.js";

/**
 * Streamable HTTP transport — the MCP standard for remote servers, and what any
 * agent that is not running on this machine needs. (HTTP+SSE was deprecated in
 * the 2025-03-26 spec and sunset in June 2026, so it is deliberately not here.)
 *
 * Runs stateless: a fresh server and transport per request, so nothing leaks
 * between callers and the process can sit behind a load balancer. The quota
 * guard is the one thing shared across requests — a per-request guard would
 * reset the ceiling on every call and enforce nothing.
 */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** JSON-RPC shaped error, so a client surfaces something useful rather than a bare status. */
function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32600, message },
    id: null,
  });
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value === token;
}

export async function startHttpServer(
  config: McpConfig,
  quota: QuotaGuard,
): Promise<void> {
  const http = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];

      // Unauthenticated so a container orchestrator can check liveness without
      // holding the token. Reveals nothing about the tenant.
      if (path === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true, transport: "http" });
        return;
      }

      if (path !== "/mcp") {
        rpcError(res, 404, "Not found. The MCP endpoint is POST /mcp.");
        return;
      }

      if (!authorized(req, config.httpToken)) {
        res.setHeader("www-authenticate", "Bearer");
        rpcError(res, 401, "Missing or invalid bearer token.");
        return;
      }

      if (req.method !== "POST") {
        // Stateless mode has no server-initiated stream to resume, so GET and
        // DELETE have nothing to do.
        res.setHeader("allow", "POST");
        rpcError(res, 405, "Only POST is supported in stateless mode.");
        return;
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (err) {
        rpcError(res, 400, err instanceof Error ? err.message : "bad request");
        return;
      }

      const server = buildServer(config, quota);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      // Tie both lifetimes to the response so a dropped connection cannot leak
      // a transport or a server instance.
      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          rpcError(res, 500, err instanceof Error ? err.message : "internal error");
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });

  process.stderr.write(
    `kaidn-mcp: listening on http://${config.host}:${config.port}/mcp ` +
      `(${config.httpToken ? "bearer auth ON" : "no auth, loopback only"})\n`,
  );
}
