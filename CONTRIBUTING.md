# Contributing

Thanks for looking. This is a small, deliberately narrow package — a client for
the Kaidn API and nothing more — so the bar for what belongs here is high.

## Getting set up

```bash
git clone https://github.com/Kaidn-io/kaidn-mcp.git
cd kaidn-mcp
npm install
npm test          # no API key needed — the tests do not hit the network
npm run typecheck
npm run build
```

To exercise it for real you need a key from [kaidn.io](https://kaidn.io):

```bash
KAIDN_API_KEY=your_key npm start
```

## What belongs here

- New tools over **existing** API endpoints.
- Composed workflows that save an analyst several round trips.
- Client compatibility fixes, transport fixes, docs.

## What does not

- **Scoring logic.** No thresholds, weights or verdict rules. This package must
  stay a client; the judgment layer is not open.
- **Anything that widens the write surface by default.** New mutating tools go
  behind `--allow-writes`.
- **`set_config` or `forget_subject`.** These are excluded on purpose — see
  [SECURITY.md](SECURITY.md). A PR adding them will be declined.

## The rules that are not negotiable

These are guarantees, not preferences. A change that breaks one will not be
merged:

1. The API key stays environment-only — never a tool parameter, never a CLI
   flag, never in output or an error.
2. Read-only is the default. Mutating tools require an explicit opt-in.
3. Quota-consuming calls go through the `QuotaGuard`, and the guard is shared
   across HTTP requests. A per-request guard enforces nothing.
4. HTTP fails closed: no non-loopback bind without a bearer token.
5. In stdio mode nothing but protocol traffic touches stdout. Human-readable
   output goes to stderr or it corrupts the stream.

## Adding a tool

Register it in `src/server.ts` and say in the description whether it **spends
quota** and whether it **changes anything** — the model uses that to decide
what to call. If it consumes quota, call `quota.spend()` *before* the request
and append `quota.footer()` to the result.

Prefer a composed tool over a thin wrapper. `explain_event` earns its place
because it answers a question an analyst actually asks; a one-to-one mirror of
a REST route mostly does not.

## Pull requests

Keep them small. Include tests for anything with logic in it. Conventional
commit subjects (`feat:`, `fix:`, `docs:`).

Say plainly in the description what you verified and what you did not — an
honest "I could not test the Docker build" is far more useful than silence.
