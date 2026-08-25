import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Kaidn } from "@kaidn/sdk";
import { z } from "zod";
import type { McpConfig } from "./config.js";
import type { QuotaGuard } from "./quota.js";

/** MCP tool results are content arrays; everything here returns text. */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** Errors must never leak the API key, so we surface only the message. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wraps a handler so a thrown error becomes a tool error rather than a crash. */
function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return fn().catch((err: unknown) => fail(`Kaidn error: ${describeError(err)}`));
}

/** Reported in the MCP handshake; kept in step with package.json on release. */
export const SERVER_VERSION = "0.3.0";

/**
 * Tool annotations. Every tool declares all four hints explicitly rather than
 * leaning on the SDK defaults: a host can only warn a user about a call it can
 * classify, and directory reviews reject a server where any hint is missing or
 * non-boolean.
 *
 * `openWorldHint` is true on all of them because every handler talks to the
 * Kaidn API over the network, so the answer depends on state this process does
 * not own.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  // Idempotence is only meaningful for a tool that writes; declared anyway so
  // the annotation set is complete. The check_* tools do spend a row of monthly
  // quota per call, which is billing, not a change to any fraud state.
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Scores AND records an event, so a second identical call is not a no-op. */
const RECORDS_EVENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Additive list write: adding the same entry twice leaves the tenant in the
 * same state, and an entry can be removed again from the dashboard, so this
 * is a non-destructive update even though it changes live verdicts at once.
 */
const ADDITIVE_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Each label appends another outcome record, so twice differs from once. */
const APPENDS_LABEL = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const VERDICTS = ["allow", "review", "block"] as const;
const ENTITY_TYPES = ["ip", "email", "device", "user"] as const;

/** Page size and ceiling for the paged event scan behind explain_event. */
const EVENT_PAGE_SIZE = 200;
const EXPLAIN_MAX_PAGES = 25;

/**
 * Events carry a peppered HMAC of the address as `emailHash`. It is not in the
 * SDK's EventRecord type but the API returns it, and it is the only exact join
 * key for "same inbox" — the plaintext address is deliberately unrecoverable.
 */
function emailHashOf(event: unknown): string | undefined {
  const h = (event as { emailHash?: unknown }).emailHash;
  return typeof h === "string" ? h : undefined;
}

/**
 * Builds a server instance. The quota guard is passed in rather than created
 * here: in HTTP mode a fresh server is built per request, and a per-request
 * guard would reset the ceiling every time and enforce nothing.
 */
export function buildServer(config: McpConfig, quota: QuotaGuard): McpServer {
  const kaidn = new Kaidn({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });

  const server = new McpServer({
    name: "kaidn",
    version: SERVER_VERSION,
  });

  // ── Tier 1: read-only primitives ──────────────────────────────────────────

  server.registerTool(
    "check_email",
    {
      title: "Check an email address",
      annotations: READ_ONLY,
      description:
        "Enrichment and in-network reputation for one email address: disposable/ " +
        "throwaway domain, deliverability, fraud score, plus how often the address " +
        "has been seen abusing other operators. " +
        "Also returns `canonical`, the identity key: every alias that reaches one " +
        "mailbox (+tags, gmail dot tricks, googlemail.com) collapses to the same " +
        "string, so compare THAT across accounts to tell whether two signups are " +
        "one person. `is_aliased` and `alias_tricks` say which trick was used, and " +
        "`reject_reason` says why an address is unusable. " +
        "Consumes one row of monthly quota.",
      inputSchema: { email: z.string().describe("The email address to check") },
    },
    async ({ email }) =>
      guard(async () => {
        quota.spend();
        const r = await kaidn.check.email(email);
        return ok(json(r) + quota.footer());
      }),
  );

  server.registerTool(
    "check_ip",
    {
      title: "Check an IP address",
      annotations: READ_ONLY,
      description:
        "Enrichment and in-network reputation for one IP: proxy/VPN/Tor, datacenter " +
        "ASN, geo, fraud score, and cross-operator abuse history. Consumes one row " +
        "of monthly quota.",
      inputSchema: { ip: z.string().describe("The IPv4 or IPv6 address to check") },
    },
    async ({ ip }) =>
      guard(async () => {
        quota.spend();
        const r = await kaidn.check.ip(ip);
        return ok(json(r) + quota.footer());
      }),
  );

  server.registerTool(
    "check_phone",
    {
      title: "Check a phone number",
      annotations: READ_ONLY,
      description:
        "Validity, line type, carrier and fraud score for one phone number. " +
        "Consumes one row of monthly quota.",
      inputSchema: {
        phone: z.string().describe("The phone number, E.164 or national"),
        country: z
          .string()
          .optional()
          .describe("ISO country code to parse a national number against, e.g. 'US'"),
      },
    },
    async ({ phone, country }) =>
      guard(async () => {
        quota.spend();
        const r = await kaidn.check.phone(phone, country);
        return ok(json(r) + quota.footer());
      }),
  );

  server.registerTool(
    "list_events",
    {
      title: "List scored events",
      annotations: READ_ONLY,
      description:
        "Scored events for this tenant, newest first. Free — does not consume quota. " +
        "Filter by verdict or event type to narrow an investigation.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Default 25"),
        offset: z.number().int().min(0).optional(),
        verdict: z.enum(VERDICTS).optional(),
        event: z
          .string()
          .optional()
          .describe("Event type, e.g. 'signup', 'cashout', 'trial_start'"),
      },
    },
    async ({ limit, offset, verdict, event }) =>
      guard(async () => {
        const r = await kaidn.events({
          limit: limit ?? 25,
          ...(offset !== undefined ? { offset } : {}),
          ...(verdict ? { verdict } : {}),
          ...(event ? { event } : {}),
        });
        return ok(json(r.events));
      }),
  );

  server.registerTool(
    "get_stats",
    {
      title: "Verdict and reason rollups",
      annotations: READ_ONLY,
      description:
        "Aggregate view over a rolling window: totals by verdict, average score and " +
        "the most common reasons. Free — does not consume quota. Start here to see " +
        "what changed before drilling into individual events.",
      inputSchema: {
        window_hours: z.number().int().min(1).max(720).optional().describe("Default 24"),
      },
    },
    async ({ window_hours }) =>
      guard(async () => {
        const r = await kaidn.stats(window_hours ?? 24);
        return ok(json(r));
      }),
  );

  server.registerTool(
    "get_config",
    {
      title: "Get scoring configuration",
      annotations: READ_ONLY,
      description:
        "This tenant's weight and threshold overrides plus the effective merged " +
        "engine config. Free. Useful for explaining why a score landed where it did.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const r = await kaidn.config.get();
        return ok(json(r));
      }),
  );

  // ── Tier 2: composed investigation workflows ──────────────────────────────

  server.registerTool(
    "explain_event",
    {
      title: "Explain why an event scored the way it did",
      annotations: READ_ONLY,
      description:
        "The 'why was this blocked?' tool. Returns the event with every check that " +
        "fired, its weight, and the raw evidence behind it, so the reasoning can be " +
        "narrated with receipts rather than guessed at. Free.",
      inputSchema: {
        event_id: z.string().describe("The event id, as returned by list_events"),
      },
    },
    async ({ event_id }) =>
      guard(async () => {
        // The events feed is the source of truth; page back through it for the id
        // rather than re-scoring, which would cost quota and create a new event.
        // A single page is not enough: any tenant with more events than one page
        // would have its older history become permanently unexplainable.
        let hit: Awaited<ReturnType<typeof kaidn.events>>["events"][number] | undefined;
        let scanned = 0;
        for (let page = 0; page < EXPLAIN_MAX_PAGES; page++) {
          const { events } = await kaidn.events({
            limit: EVENT_PAGE_SIZE,
            offset: page * EVENT_PAGE_SIZE,
          });
          if (events.length === 0) break;
          scanned += events.length;
          hit = events.find((e) => e.id === event_id);
          if (hit || events.length < EVENT_PAGE_SIZE) break;
        }
        if (!hit) {
          return fail(
            `No event ${event_id} found in the ${scanned} most recent events. Check the ` +
              `id, or if this tenant has more than ${EXPLAIN_MAX_PAGES * EVENT_PAGE_SIZE} ` +
              `events the record may be older than the search window.`,
          );
        }
        return ok(json(hit));
      }),
  );

  server.registerTool(
    "investigate_entity",
    {
      title: "Investigate an entity and the ring around it",
      annotations: READ_ONLY,
      description:
        "One call for what a fraud analyst actually wants. Returns enrichment for the " +
        "entity, its reputation across the CROSS-OPERATOR abuse network (whether this " +
        "email, IP or device has already burned other businesses, not just yours), and " +
        "every recent event it appears in — which is how you get from one suspicious " +
        "signup to the whole ring of accounts sharing its device, IP or inbox. Supply " +
        "exactly one of email, email_hash, ip or device_id. To pivot on the inbox of an " +
        "event you are already looking at, pass its `emailHash` as email_hash: that is " +
        "an exact match on the same mailbox and is free. Passing a plaintext `email` " +
        "can only match on its DOMAIN, so on a consumer domain like gmail.com it returns " +
        "unrelated accounts and is not a ring — check `match_basis` in the response " +
        "before calling anything a ring. Enrichment consumes one row of monthly quota " +
        "(device_id and email_hash lookups are free).",
      inputSchema: {
        email: z.string().optional(),
        email_hash: z
          .string()
          .optional()
          .describe("An event's `emailHash` — exact same-inbox match, free"),
        ip: z.string().optional(),
        device_id: z.string().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(EVENT_PAGE_SIZE * EXPLAIN_MAX_PAGES)
          .optional()
          .describe(
            "How many recent events to scan, paged behind the scenes. Default 500 — " +
              "raise it if a ring member may be older than that",
          ),
      },
    },
    async ({ email, email_hash, ip, device_id, limit }) =>
      guard(async () => {
        const given = [email, email_hash, ip, device_id].filter(Boolean);
        if (given.length !== 1) {
          return fail(
            "Supply exactly one of email, email_hash, ip or device_id — investigating " +
              "more than one entity at a time hides which one carries the risk.",
          );
        }

        let enrichment: unknown = null;
        if (email) {
          quota.spend();
          enrichment = await kaidn.check.email(email);
        } else if (ip) {
          quota.spend();
          enrichment = await kaidn.check.ip(ip);
        }

        // Page the scan. A single 200-event request silently hid real rings:
        // two accounts sharing a mailbox sat 229 events back and were invisible.
        const scanDepth = limit ?? 500;
        const events: Awaited<ReturnType<typeof kaidn.events>>["events"] = [];
        while (events.length < scanDepth) {
          const { events: page } = await kaidn.events({
            limit: Math.min(EVENT_PAGE_SIZE, scanDepth - events.length),
            offset: events.length,
          });
          if (page.length === 0) break;
          events.push(...page);
          if (page.length < EVENT_PAGE_SIZE) break;
        }

        const related = events.filter((e) =>
          device_id
            ? e.deviceId === device_id
            : ip
              ? e.ip === ip
              : email_hash
                ? emailHashOf(e) === email_hash
                : typeof email === "string" &&
                  typeof e.emailDomain === "string" &&
                  email.toLowerCase().endsWith(`@${e.emailDomain.toLowerCase()}`),
        );

        // An email pivot can only match on domain, so it is NOT a ring. Say so in
        // the payload rather than letting the caller read it as one.
        const matchBasis = device_id
          ? "device_id (exact)"
          : ip
            ? "ip (exact)"
            : email_hash
              ? "email_hash (exact — same mailbox)"
              : "email_domain (WEAK — not a ring)";

        const body = json({
          entity: device_id
            ? { device_id }
            : ip
              ? { ip }
              : email_hash
                ? { email_hash }
                : { email },
          match_basis: matchBasis,
          events_scanned: events.length,
          enrichment,
          related_event_count: related.length,
          related_events: related,
          note: email
            ? "Events store a peppered hash of the address, never the address itself, " +
              "so a plaintext email can only be matched on its DOMAIN. These accounts " +
              "share a mail provider and nothing more — on a consumer domain that is " +
              "meaningless. To pivot on the actual inbox, take the `emailHash` off one " +
              "of these events and pass it as email_hash."
            : undefined,
        });
        return ok(enrichment ? body + quota.footer() : body);
      }),
  );

  server.registerTool(
    "triage_queue",
    {
      title: "Review queue, highest risk first",
      annotations: READ_ONLY,
      description:
        "Every event sitting on the 'review' verdict, sorted by score descending — " +
        "the daily triage job. Free.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
    },
    async ({ limit }) =>
      guard(async () => {
        const { events } = await kaidn.events({
          verdict: "review",
          limit: limit ?? 50,
        });
        const ranked = [...events].sort((a, b) => b.score - a.score);
        return ok(json(ranked));
      }),
  );

  server.registerTool(
    "score_event",
    {
      title: "Score an event",
      annotations: RECORDS_EVENT,
      description:
        "Run an event through the scoring engine and get {score, verdict, reasons, " +
        "checks}. When the event carries an email, the response also has an " +
        "`identity` block whose `email_canonical` is the dedupe key for that " +
        "address — so one call both scores the event and tells you whether the " +
        "mailbox is one you have already seen. " +
        "Consumes one row of monthly quota AND records an event — prefer " +
        "the read-only tools when investigating history rather than testing new input.",
      inputSchema: {
        event: z
          .string()
          .describe("Event type, e.g. 'signup', 'cashout', 'trial_start'"),
        user_id: z.string().optional(),
        ip: z.string().optional(),
        email: z.string().optional(),
        device_id: z.string().optional(),
        phone: z.string().optional(),
        timezone: z.string().optional().describe("IANA browser timezone"),
      },
    },
    async (args) =>
      guard(async () => {
        quota.spend();
        const r = await kaidn.score(args);
        return ok(json(r) + quota.footer());
      }),
  );

  // ── Tier 3: mutations, registered only with --allow-writes ────────────────
  //
  // Deliberately excluded from v1 even behind the flag:
  //   set_config     — silently changes verdicts for the whole tenant
  //   forget_subject — destructive GDPR erasure, no undo
  // Both belong in the dashboard where a human sees what they are doing.

  if (config.allowWrites) {
    server.registerTool(
      "add_to_list",
      {
        title: "Add an entry to the allow or block list",
        annotations: ADDITIVE_WRITE,
        description:
          "Add one entity to this tenant's allow or block list. Blocklist entries " +
          "short-circuit scoring, so this changes live decisions immediately.",
        inputSchema: {
          list: z.enum(["allow", "block"]),
          type: z.enum(ENTITY_TYPES),
          value: z.string().describe("The IP, email, device id or user id"),
        },
      },
      async ({ list, type, value }) =>
        guard(async () => {
          const r = await kaidn.lists.add(list, type, value);
          return ok(json(r));
        }),
    );

    server.registerTool(
      "label_outcome",
      {
        title: "Label a confirmed outcome",
        annotations: APPENDS_LABEL,
        description:
          "Report what actually happened — fraud, chargeback or legit — to sharpen " +
          "the scoring engine and the cross-operator graph. Reference an event_id " +
          "where possible; a label tied to an observed event is the only kind that " +
          "contributes a confirmed cross-tenant flag.",
        inputSchema: {
          label: z.enum(["fraud", "chargeback", "legit"]),
          event_id: z.string().optional(),
          ip: z.string().optional(),
          email: z.string().optional(),
          device_id: z.string().optional(),
          note: z.string().optional(),
        },
      },
      async ({ label, event_id, ip, email, device_id, note }) =>
        guard(async () => {
          const entities =
            ip || email || device_id
              ? {
                  ...(ip ? { ip } : {}),
                  ...(email ? { email } : {}),
                  ...(device_id ? { device_id } : {}),
                }
              : undefined;
          if (!event_id && !entities) {
            return fail("Supply an event_id or at least one of ip, email, device_id.");
          }
          const r = await kaidn.label({
            label,
            ...(event_id ? { event_id } : {}),
            ...(entities ? { entities } : {}),
            ...(note ? { note } : {}),
          } as Parameters<typeof kaidn.label>[0]);
          return ok(json(r));
        }),
    );
  }

  return server;
}
