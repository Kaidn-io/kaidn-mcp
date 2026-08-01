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
export const SERVER_VERSION = "0.1.0";

const VERDICTS = ["allow", "review", "block"] as const;
const ENTITY_TYPES = ["ip", "email", "device", "user"] as const;

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
        // The events feed is the source of truth; scan recent pages for the id
        // rather than re-scoring, which would cost quota and create a new event.
        const { events } = await kaidn.events({ limit: 200 });
        const hit = events.find((e) => e.id === event_id);
        if (!hit) {
          return fail(
            `No event ${event_id} in the most recent 200 events. It may be older — ` +
              `page back with list_events(offset) to locate it.`,
          );
        }
        return ok(json(hit));
      }),
  );

  server.registerTool(
    "investigate_entity",
    {
      title: "Investigate an entity and the ring around it",
      description:
        "One call for what a fraud analyst actually wants. Returns enrichment for the " +
        "entity, its reputation across the CROSS-OPERATOR abuse network (whether this " +
        "email, IP or device has already burned other businesses, not just yours), and " +
        "every recent event it appears in — which is how you get from one suspicious " +
        "signup to the whole ring of accounts sharing its device, IP or inbox. Supply " +
        "exactly one of email, ip or device_id. Enrichment consumes one row of monthly " +
        "quota (device_id lookups are free).",
      inputSchema: {
        email: z.string().optional(),
        ip: z.string().optional(),
        device_id: z.string().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many recent events to scan. Default 100"),
      },
    },
    async ({ email, ip, device_id, limit }) =>
      guard(async () => {
        const given = [email, ip, device_id].filter(Boolean);
        if (given.length !== 1) {
          return fail(
            "Supply exactly one of email, ip or device_id — investigating more than " +
              "one entity at a time hides which one carries the risk.",
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

        const { events } = await kaidn.events({ limit: limit ?? 100 });
        const related = events.filter((e) =>
          device_id
            ? e.deviceId === device_id
            : ip
              ? e.ip === ip
              : typeof email === "string" &&
                typeof e.emailDomain === "string" &&
                email.toLowerCase().endsWith(`@${e.emailDomain.toLowerCase()}`),
        );

        const body = json({
          entity: device_id
            ? { device_id }
            : ip
              ? { ip }
              : { email },
          enrichment,
          related_event_count: related.length,
          related_events: related,
          note: email
            ? "Events store the email domain, not the full address, so related_events " +
              "matches on domain and may include other addresses at that domain."
            : undefined,
        });
        return ok(enrichment ? body + quota.footer() : body);
      }),
  );

  server.registerTool(
    "triage_queue",
    {
      title: "Review queue, highest risk first",
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
