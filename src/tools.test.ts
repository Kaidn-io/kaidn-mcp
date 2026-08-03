import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import { QuotaGuard } from "./quota.js";

/**
 * Stands in for the Kaidn API. `pages` is the full event feed; the stub honours
 * limit/offset so paging behaviour is exercised for real rather than assumed.
 */
function stubApi(events: unknown[]): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/v1/events") {
      const limit = Number(url.searchParams.get("limit") ?? 200);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return new Response(
        JSON.stringify({ events: events.slice(offset, offset + limit) }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function connect(events: unknown[]) {
  const restore = stubApi(events);
  const server = buildServer(
    {
      apiKey: "k_test",
      allowWrites: false,
      maxQuotaCalls: 100,
      transport: "stdio",
      host: "127.0.0.1",
      port: 8765,
    },
    new QuotaGuard(100),
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, restore };
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { text: r.content[0]?.text ?? "", isError: r.isError === true };
};

/** Quota-spending tools append a human-readable footer after the JSON body. */
const body = (text: string): string => text.slice(0, text.lastIndexOf("}") + 1);

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const event = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `evt-${i}`,
  event: "signup",
  userId: `u${i}`,
  verdict: "allow",
  score: 0,
  reasons: [],
  checks: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  ...extra,
});

describe("explain_event", () => {
  it("finds an event that sits beyond the first page", async () => {
    // 287 events is the real tenant size that exposed this: a single 200-event
    // page left the older 87 permanently unexplainable.
    const events = Array.from({ length: 287 }, (_, i) => event(i));
    const { client, restore } = await connect(events);
    cleanup = restore;

    const { text, isError } = await call(client, "explain_event", { event_id: "evt-250" });
    expect(isError).toBe(false);
    expect(JSON.parse(text).id).toBe("evt-250");
  });

  it("still reports a genuinely absent id as an error", async () => {
    const { client, restore } = await connect([event(1)]);
    cleanup = restore;

    const { text, isError } = await call(client, "explain_event", { event_id: "nope" });
    expect(isError).toBe(true);
    expect(text).toContain("nope");
  });
});

describe("investigate_entity", () => {
  const ring = [
    event(1, { emailHash: "HASH_A", emailDomain: "gmail.com", userId: "ring-1" }),
    event(2, { emailHash: "HASH_A", emailDomain: "gmail.com", userId: "ring-2" }),
    event(3, { emailHash: "HASH_B", emailDomain: "gmail.com", userId: "stranger" }),
  ];

  it("matches the same mailbox exactly on email_hash", async () => {
    const { client, restore } = await connect(ring);
    cleanup = restore;

    const { text } = await call(client, "investigate_entity", { email_hash: "HASH_A" });
    const out = JSON.parse(text);
    expect(out.related_event_count).toBe(2);
    expect(out.match_basis).toContain("exact");
    expect(out.related_events.map((e: { userId: string }) => e.userId)).toEqual([
      "ring-1",
      "ring-2",
    ]);
  });

  it("does not spend quota on an email_hash pivot", async () => {
    const { client, restore } = await connect(ring);
    cleanup = restore;

    const { text } = await call(client, "investigate_entity", { email_hash: "HASH_A" });
    expect(text).not.toContain("quota");
  });

  it("flags a plaintext email pivot as a weak domain match, not a ring", async () => {
    const { client, restore } = await connect(ring);
    cleanup = restore;

    const { text } = await call(client, "investigate_entity", {
      email: "someone@gmail.com",
    });
    const out = JSON.parse(body(text));
    // All three share the domain, which is exactly why it must not read as a ring.
    expect(out.related_event_count).toBe(3);
    expect(out.match_basis).toContain("WEAK");
    expect(out.note).toContain("DOMAIN");
  });

  it("finds a ring sitting deeper than one page of events", async () => {
    // The real miss: two accounts sharing a mailbox sat 229 events back, past
    // the old hard cap of 200, so the pivot reported no ring at all.
    const deep = [
      ...Array.from({ length: 228 }, (_, i) => event(i, { emailHash: "OTHER" })),
      event(900, { emailHash: "HASH_DEEP", userId: "deep-1" }),
      event(901, { emailHash: "HASH_DEEP", userId: "deep-2" }),
    ];
    const { client, restore } = await connect(deep);
    cleanup = restore;

    const { text } = await call(client, "investigate_entity", {
      email_hash: "HASH_DEEP",
    });
    const out = JSON.parse(text);
    expect(out.events_scanned).toBeGreaterThan(200);
    expect(out.related_event_count).toBe(2);
  });

  it("still refuses more than one entity", async () => {
    const { client, restore } = await connect(ring);
    cleanup = restore;

    const { isError } = await call(client, "investigate_entity", {
      email_hash: "HASH_A",
      ip: "8.8.8.8",
    });
    expect(isError).toBe(true);
  });
});

describe("packaging", () => {
  it("reports the published version in the handshake", () => {
    // serverInfo.version drifted to 0.1.0 for three releases because nothing
    // tied it to package.json.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("runs when launched through a .bin symlink", () => {
    // npx launches the bin through a symlink, so argv[1] is the link while
    // import.meta.url is the real file. A naive comparison of the two made the
    // server exit 0 in silence — shipped broken in 0.2.1 and 0.2.2.
    const entry = resolve(__dirname, "../dist/index.js");
    const link = join(mkdtempSync(join(tmpdir(), "kaidn-bin-")), "kaidn-mcp");
    symlinkSync(entry, link);

    const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe(SERVER_VERSION);
  });
});
