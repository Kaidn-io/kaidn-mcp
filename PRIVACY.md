# Privacy

This covers the **MCP server in this repository**. It is a client: it forwards
your requests to the Kaidn API and returns the answers. Kaidn's own handling of
that data is governed by the [Kaidn privacy policy](https://kaidn.io/privacy),
which is the authoritative document — this one only describes the hop in
between.

## What passes through it

Investigating fraud means handling personal data. Depending on the tool called,
that can include **email addresses, IP addresses, phone numbers, device
identifiers, user identifiers and browser timezones**.

Treat this server as processing personal data, because it does.

## What this server stores

**Nothing.** It has no database, no cache and no request log. Data exists in
process memory for the duration of a call and is gone when the response is
returned.

The only thing it writes is a single startup line to stderr — transport mode,
whether writes are enabled, and the quota ceiling. It contains no request data
and no credentials.

The quota counter held in memory is a count, not a record of what was asked.

## What the Kaidn API stores

This is the part that matters, and it is **not** "nothing" — any claim otherwise
would be false:

- **`score_event` creates an event record.** That is the point of it: scored
  events are retained so they can be listed, explained and triaged later. The
  read-only tools in this server exist to read exactly those records.
- **The enrichment checks are metered.** Each consumes a row of your monthly
  quota, so the call is accounted for.
- **Cross-operator signals are keyed, not raw.** Entities contributed to Kaidn's
  fraud graph are HMAC-hashed rather than shared in the clear.

Retention periods, deletion rights and erasure are defined by the
[Kaidn privacy policy](https://kaidn.io/privacy) and apply to your tenant
whether or not you use this server. Nothing here changes them.

## Credentials

`KAIDN_API_KEY` is read from the environment only. It is never a tool argument,
never included in a response, and never written to output — including error
messages.

In HTTP mode the process holds that key on behalf of every caller that reaches
it, which is why it binds loopback by default and refuses a wider bind without a
bearer token. See [SECURITY.md](SECURITY.md).

## Sending data to a model

Whatever a tool returns is handed to whichever model you connected. If you are
using a hosted assistant, personal data in a response reaches that provider
under **their** terms, not Kaidn's.

That is inherent to MCP rather than specific to this server, but it is worth
being deliberate about: `investigate_entity` on a real customer sends that
customer's data to your model provider.

## Erasure

`forget_subject` — Kaidn's GDPR erasure call — is deliberately **not exposed**
by this server, in any mode. Erasure is irreversible and should not sit behind a
natural-language interface where a misread instruction can trigger it. Use the
dashboard or the API directly.

## Questions

privacy@kaidn.io
