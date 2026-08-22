<!-- kaidn-header -->
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kaidn-io/kaidn-mcp/main/.github/kaidn-banner-dark.png">
    <img src="https://raw.githubusercontent.com/Kaidn-io/kaidn-mcp/main/.github/kaidn-banner-light.png" alt="Kaidn" width="520">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kaidn/mcp"><img src="https://img.shields.io/npm/v/@kaidn/mcp?logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://registry.modelcontextprotocol.io/v0/servers?search=io.kaidn/kaidn-mcp"><img src="https://img.shields.io/badge/MCP%20registry-io.kaidn%2Fkaidn--mcp-6f42c1" alt="MCP registry"></a>
  <a href="https://github.com/Kaidn-io/kaidn-mcp/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@kaidn/mcp?color=blue" alt="license MIT"></a>
  <a href="https://kaidn.io/docs"><img src="https://img.shields.io/badge/docs-kaidn.io-FF4D00" alt="docs"></a>
</p>
<!-- /kaidn-header -->

# Kaidn MCP

**Model Context Protocol server for the [Kaidn](https://kaidn.io) fraud-scoring API.**

Investigate fraud in plain English — *"why was this signup blocked?"*, *"what
else has this device touched?"*, *"what's in the review queue this morning?"*

- **Evidence, not just a score.** Every reason carries the raw numbers behind
  it, so a model can explain a verdict rather than guess at it.
- **Read-only by default.** Nothing changes your tenant unless you opt in.
- **Quota-guarded.** An agent in a loop cannot spend your month in ten minutes.
- **Any client.** MCP is an open protocol — stdio locally, Streamable HTTP for
  remote and hosted agents.

### Requirements

Node.js 18 or newer, and an API key from your [Kaidn dashboard](https://kaidn.io).

---

## Getting started

First, install the Kaidn MCP server with your client. Standard config works in
most of the tools:

```json
{
  "mcpServers": {
    "kaidn": {
      "command": "npx",
      "args": ["@kaidn/mcp@latest"],
      "env": { "KAIDN_API_KEY": "your_key" }
    }
  }
}
```

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add kaidn --env KAIDN_API_KEY=your_key -- npx @kaidn/mcp@latest
```
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Add the standard config to `claude_desktop_config.json`, then restart Claude.
Settings → Developer → Edit Config opens the file.
</details>

<details>
<summary><b>Cursor</b></summary>

Settings → MCP → Add new MCP Server, or add the standard config to
`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project).
</details>

<details>
<summary><b>VS Code</b></summary>

```bash
code --add-mcp '{"name":"kaidn","command":"npx","args":["@kaidn/mcp@latest"],"env":{"KAIDN_API_KEY":"your_key"}}'
```
</details>

<details>
<summary><b>Windsurf</b></summary>

Add the standard config to `~/.codeium/windsurf/mcp_config.json`.
</details>

<details>
<summary><b>Cline</b></summary>

Add the standard config to `cline_mcp_settings.json` via the MCP Servers icon →
Configure MCP Servers.
</details>

<details>
<summary><b>Zed</b></summary>

Add to `settings.json` under `context_servers`, using the same command, args and
env as the standard config.
</details>

<details>
<summary><b>Anything else</b></summary>

Any MCP client takes a **command**, **args** and an **env** block. Use the
standard config above. If the client can only reach the server over the network
rather than spawning a process, see [Streamable HTTP](#streamable-http).
</details>

---

## Configuration

| Option | Environment variable | Default | Purpose |
|---|---|---|---|
| | `KAIDN_API_KEY` | *required* | Your secret key. Environment only — never a flag, never a tool argument. |
| | `KAIDN_API_URL` | `https://api.kaidn.io` | API base URL |
| `--allow-writes` | `KAIDN_MCP_ALLOW_WRITES=1` | off | Register the mutating tools |
| | `KAIDN_MCP_MAX_QUOTA_CALLS` | `100` | Quota ceiling per process |
| `--http` | `KAIDN_MCP_TRANSPORT=http` | `stdio` | Serve Streamable HTTP |
| `--host <addr>` | `KAIDN_MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `--port <n>` | `KAIDN_MCP_PORT` | `8765` | HTTP port |
| | `KAIDN_MCP_HTTP_TOKEN` | unset | Require `Authorization: Bearer` on HTTP |
| `--help` | | | Show usage |
| `--version` | | | Show the version |

**Precedence:** CLI flags override environment variables.

The API key is deliberately env-only. A key passed as a flag leaks into process
listings and shell history.

---

## Transports

| Transport | Use it for | Endpoint |
|---|---|---|
| **stdio** *(default)* | local clients that spawn a subprocess | — |
| **Streamable HTTP** | remote agents, containers, anything off-machine | `POST /mcp` |

`HTTP+SSE` is deliberately absent: deprecated in the 2025-03-26 spec and sunset
in June 2026.

### Streamable HTTP

```bash
npx @kaidn/mcp@latest --http --port 8765
```

Stateless — a fresh server per request, nothing shared between callers — so it
sits behind a load balancer without surprises. `GET /health` is unauthenticated
so an orchestrator can check liveness without holding the token.

---

## Docker

```bash
docker build -t kaidn-mcp .
```

```bash
# stdio — behaves like the npx invocation
docker run -i --rm -e KAIDN_API_KEY=your_key kaidn-mcp

# HTTP — for remote agents
docker run --rm -p 8765:8765 \
  -e KAIDN_API_KEY=your_key \
  -e KAIDN_MCP_TRANSPORT=http \
  -e KAIDN_MCP_HOST=0.0.0.0 \
  -e KAIDN_MCP_HTTP_TOKEN=your_token \
  kaidn-mcp
```

Multi-stage build, runs as the unprivileged `node` user, with a healthcheck.

---

## Security

**The server holds your API key.** Whoever can reach it can spend your quota, so
the defaults are conservative and the guards fail closed rather than warning.

- **Binds `127.0.0.1`, and refuses to start on a wider interface** unless
  `KAIDN_MCP_HTTP_TOKEN` is set. It stops with an explanation rather than
  quietly exposing your account.
- **Read-only by default.** `add_to_list` and `label_outcome` exist only with
  `--allow-writes`.
- **`set_config` and `forget_subject` are never exposed**, in any mode. One
  silently changes the verdict on every future event; the other is irreversible
  GDPR erasure. Both belong in the dashboard, in front of a human.
- **Quota ceiling per process**, with remaining budget reported on every costing
  response. A reservation that would overshoot is refused outright rather than
  partially spent.
- **The key never crosses the tool boundary** — not as a parameter, not in
  output, not in an error.

---

## Tools

Two things govern every tool: whether it **spends quota**, and whether it
**changes anything**.

### Read-only — available by default

| Tool | Cost | What it does |
|---|---|---|
| `get_stats` | free | Verdict, score and reason rollups over a rolling window. Start here. |
| `list_events` | free | Scored events, newest first, filterable by verdict or type |
| `explain_event` | free | Every check that fired on one event, with the raw evidence |
| `triage_queue` | free | Everything on `review`, highest score first |
| `get_config` | free | Effective weights and thresholds for this tenant |
| `investigate_entity` | 1 row¹ | Enrichment, network reputation and related events for one entity |
| `check_email` | 1 row | Disposable domain, deliverability, fraud score, abuse history |
| `check_ip` | 1 row | Proxy, VPN, Tor, datacenter ASN, geo, abuse history |
| `check_phone` | 1 row | Validity, line type, carrier, fraud score |
| `score_event` | 1 row | Score a new event (also records it) |

¹ Free when the entity is a `device_id`; enrichment only costs on email or IP.

### Mutating — require `--allow-writes`

| Tool | What it does |
|---|---|
| `add_to_list` | Add an entity to the allow or block list |
| `label_outcome` | Report a confirmed fraud / chargeback / legit outcome |

---

## Worked examples

The tools are designed to be chained. These are the flows they were built for.

### Morning triage

> **You:** What happened overnight, and what needs me?

The model calls `get_stats` for the shape of the last 24 hours, then
`triage_queue` for the events sitting on `review`, then `explain_event` on the
worst one. You get a ranked list with the reasoning attached, rather than a
dashboard you still have to read.

### "Why was this customer blocked?"

> **You:** Event `evt_8f21c` — a customer says they were wrongly blocked.

`explain_event` returns every check that fired with its raw evidence — the
datacenter ASN it matched, how many accounts shared the device, the velocity
count. Enough to answer the customer, or to conclude the rule was wrong and
needs tuning.

### Working outward from one signal

> **You:** Is `194.x.x.x` a one-off or part of a ring?

`investigate_entity` returns enrichment and network reputation for the IP plus
every recent event it appears in. If the same device ids keep recurring, that is
a ring rather than a coincidence.

### Checking a rule change before making it

> **You:** If I dropped the velocity weight, what would stop being blocked?

`get_config` reads the current weights; `list_events` with `verdict: "block"`
shows what is currently caught. The model can tell you which of those hang on
the check you are about to weaken.

---

## Error handling

Failures come back as tool errors with a readable message, not exceptions — the
model can act on them.

| You see | Meaning | Fix |
|---|---|---|
| `KAIDN_API_KEY is not set` | Server started without a key | Set it in the client's `env` block |
| `Kaidn error: 401 …` | Key rejected | Rotate or re-copy it from the dashboard |
| `Kaidn error: 429 …` | Rate limited | Slow down; per-key throttling is by the minute |
| `Session quota ceiling reached (100/100 …)` | The guard stopped an expensive run | Raise `KAIDN_MCP_MAX_QUOTA_CALLS` deliberately, or restart |
| `No event <id> in the most recent 200 events` | Event is older than the scan window | Page back with `list_events` using `offset` |
| `Supply exactly one of email, ip or device_id` | Ambiguous investigation | Ask about one entity at a time |
| `Refusing to bind <host> without authentication` | Non-loopback HTTP with no token | Set `KAIDN_MCP_HTTP_TOKEN`, or bind `127.0.0.1` |

Errors never contain your API key.

---

## Troubleshooting

**The client shows no tools.**
Check the client's MCP log for the startup line. `kaidn-mcp: ready (stdio, …)`
on stderr means the server is up and the problem is on the client side. Nothing
at all usually means `npx` could not resolve the package or Node is older than 18.

**It starts, then exits immediately.**
Almost always a missing `KAIDN_API_KEY`. The message says so on stderr; some
clients hide stderr, so run it in a terminal to see it.

**`add_to_list` and `label_outcome` are missing.**
Working as designed. They need `--allow-writes`.

**`set_config` and `forget_subject` are missing.**
Also by design, and they are not available in any mode. See
[SECURITY.md](SECURITY.md).

**HTTP mode refuses to start.**
You bound something other than loopback without a bearer token. That is the
guard working — the process holds your API key.

**Everything is slow.**
The enrichment checks make live upstream calls. `get_stats`, `list_events`,
`explain_event` and `triage_queue` are free and fast; prefer them when reading
history.

**Check the server independently of the client:**

```bash
node dist/index.js --help                 # no key required
KAIDN_API_KEY=your_key npm start          # should print a ready line
```

---

## Support

- **Bugs and feature requests:** [GitHub issues](https://github.com/Kaidn-io/kaidn-mcp/issues)
- **Security:** security@kaidn.io — see [SECURITY.md](SECURITY.md)
- **Privacy and data handling:** [PRIVACY.md](PRIVACY.md)
- **The API itself:** [kaidn.io](https://kaidn.io)

---

## Run from source

```bash
git clone https://github.com/Kaidn-io/kaidn-mcp.git
cd kaidn-mcp
npm install
npm run build
npm test
```

```bash
claude mcp add kaidn --env KAIDN_API_KEY=your_key -- node /absolute/path/to/kaidn-mcp/dist/index.js
```

To check it starts without a client:

```bash
KAIDN_API_KEY=your_key npm start
```

It prints `kaidn-mcp: ready (stdio, read-only, quota ceiling 100)` to stderr and
then waits on stdin — that is the MCP transport, so the silence is correct.

---

## Why the evidence matters

Kaidn's engine is rules-first and explainable: every reason carries the raw
numbers behind it. A bare score gives a model nothing to reason about, while
`checks[]` with evidence attached gives it something to explain. That is the
difference between `explain_event` being useful and being decorative.

**Rules decide. The model narrates.**

---

## Project

- [CONTRIBUTING.md](CONTRIBUTING.md) — what belongs here, and the guarantees a change must not break
- [SECURITY.md](SECURITY.md) — reporting, threat model, known limitations
- [PRIVACY.md](PRIVACY.md) — what passes through, what is stored, what is not
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Licence

MIT
