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

async function connect(events: unknown[], allowWrites = false) {
  const restore = stubApi(events);
  const server = buildServer(
    {
      apiKey: "k_test",
      allowWrites,
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

/**
 * The full tool catalogue with the hints each one must declare. Kept as data so
 * a new tool that ships without annotations fails here rather than in a
 * directory review: hosts can only warn a user about a call they can classify,
 * and a missing or non-boolean hint is grounds for rejection.
 */
const TOOL_HINTS = {
  check_email: { readOnly: true, destructive: false, idempotent: true },
  check_ip: { readOnly: true, destructive: false, idempotent: true },
  check_phone: { readOnly: true, destructive: false, idempotent: true },
  list_events: { readOnly: true, destructive: false, idempotent: true },
  get_stats: { readOnly: true, destructive: false, idempotent: true },
  get_config: { readOnly: true, destructive: false, idempotent: true },
  explain_event: { readOnly: true, destructive: false, idempotent: true },
  investigate_entity: { readOnly: true, destructive: false, idempotent: true },
  triage_queue: { readOnly: true, destructive: false, idempotent: true },
  score_event: { readOnly: false, destructive: false, idempotent: false },
  add_to_list: { readOnly: false, destructive: false, idempotent: true },
  label_outcome: { readOnly: false, destructive: false, idempotent: false },
} as const;

/** The two mutations only exist when the server is started with --allow-writes. */
const WRITE_GATED = ["add_to_list", "label_outcome"] as const;

type Listed = {
  name: string;
  annotations?: {
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
    idempotentHint?: unknown;
    openWorldHint?: unknown;
  };
};

const listed = async (allowWrites: boolean) => {
  const { client, restore } = await connect([], allowWrites);
  cleanup = restore;
  const { tools } = (await client.listTools()) as { tools: Listed[] };
  return { client, tools };
};

describe("tool annotations", () => {
  it("registers exactly the documented catalogue", async () => {
    const { tools } = await listed(true);
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_HINTS).sort());
  });

  it("keeps the mutations out of the default read-only server", async () => {
    const { tools } = await listed(false);
    const names = tools.map((t) => t.name);
    for (const gated of WRITE_GATED) expect(names).not.toContain(gated);
    expect(names).toHaveLength(Object.keys(TOOL_HINTS).length - WRITE_GATED.length);
  });

  it("declares all four hints, as booleans, on every tool", async () => {
    const { tools } = await listed(true);
    for (const tool of tools) {
      const a = tool.annotations ?? {};
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof a[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("gives each tool the hints its handler actually earns", async () => {
    const { tools } = await listed(true);
    for (const tool of tools) {
      const want = TOOL_HINTS[tool.name as keyof typeof TOOL_HINTS];
      const a = tool.annotations ?? {};
      expect(a.readOnlyHint, `${tool.name}.readOnlyHint`).toBe(want.readOnly);
      expect(a.destructiveHint, `${tool.name}.destructiveHint`).toBe(want.destructive);
      expect(a.idempotentHint, `${tool.name}.idempotentHint`).toBe(want.idempotent);
      // Every handler calls the Kaidn API, so none of them is a closed world.
      expect(a.openWorldHint, `${tool.name}.openWorldHint`).toBe(true);
    }
  });
});

describe("tool smoke", () => {
  // One call per tool, so every name in the catalogue is exercised and not just
  // declared. The stubbed API answers 200 with an empty body, which is enough to
  // prove the handler wires arguments through and does not throw.
  const ARGS: Record<keyof typeof TOOL_HINTS, Record<string, unknown>> = {
    check_email: { email: "someone@mailinator.com" },
    check_ip: { ip: "185.220.101.1" },
    check_phone: { phone: "+14155551234", country: "US" },
    list_events: { limit: 5 },
    get_stats: { window_hours: 24 },
    get_config: {},
    explain_event: { event_id: "evt-1" },
    investigate_entity: { email_hash: "HASH_A" },
    triage_queue: { limit: 5 },
    score_event: { event: "signup", email: "someone@mailinator.com" },
    add_to_list: { list: "block", type: "ip", value: "185.220.101.1" },
    label_outcome: { label: "fraud", event_id: "evt-1" },
  };

  for (const name of Object.keys(ARGS) as (keyof typeof ARGS)[]) {
    it(`answers a ${name} call`, async () => {
      const { client, restore } = await connect([event(1)], true);
      cleanup = restore;
      const { isError } = await call(client, name, ARGS[name]);
      expect(isError).toBe(false);
    });
  }
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
