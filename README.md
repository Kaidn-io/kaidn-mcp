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

## Licence

MIT
