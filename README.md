# @kaidn/mcp

**Model Context Protocol server for the [Kaidn](https://kaidn.io) fraud-scoring API.**

Investigate fraud in plain English — *"why was this signup blocked?"*, *"what else
has this device touched?"*, *"what's in the review queue this morning?"*

MCP is an open protocol, so this works with **any MCP-compatible client** —
Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Continue, VS Code, Zed,
LibreChat, your own agent — over stdio locally, or **Streamable HTTP** for
remote and hosted agents.

**Read-only by default.** Mutating tools are opt-in.

---

## Quick start

```bash
npx @kaidn/mcp
```

Get an API key from your [Kaidn dashboard](https://kaidn.io). It is read from
the environment only — never a tool argument, never echoed in a response.

---

## Connect a client

Almost every MCP client takes the same three things: a **command**, its
**args**, and an **env** block. If yours is not listed, use the generic form.

### Generic (works anywhere)

```json
{
  "command": "npx",
  "args": ["-y", "@kaidn/mcp"],
  "env": { "KAIDN_API_KEY": "your_key" }
}
```

### Claude Code

```bash
claude mcp add kaidn --env KAIDN_API_KEY=your_key -- npx -y @kaidn/mcp
```

### Claude Desktop · Cursor · Windsurf · Cline · Continue

Add to the client's MCP config file (`claude_desktop_config.json`,
`.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `cline_mcp_settings.json`
respectively):

```json
{
  "mcpServers": {
    "kaidn": {
      "command": "npx",
      "args": ["-y", "@kaidn/mcp"],
      "env": { "KAIDN_API_KEY": "your_key" }
    }
  }
}
```

### VS Code

```bash
code --add-mcp '{"name":"kaidn","command":"npx","args":["-y","@kaidn/mcp"],"env":{"KAIDN_API_KEY":"your_key"}}'
```

### Remote / hosted agents

Anything that cannot spawn a local process — a hosted agent, a serverless
function, another machine — connects over HTTP instead. See
[Streamable HTTP](#streamable-http) below.

---

## Transports

| Transport | Use it for | Endpoint |
|---|---|---|
| **stdio** *(default)* | local clients that spawn a subprocess | — |
| **Streamable HTTP** | remote agents, containers, anything off-machine | `POST /mcp` |

`HTTP+SSE` is deliberately not implemented: it was deprecated in the 2025-03-26
spec and sunset in June 2026. Streamable HTTP is the current standard.

### Streamable HTTP

```bash
npx @kaidn/mcp --http --port 8765
```

Runs **stateless** — a fresh server per request, nothing shared between callers —
so it sits behind a load balancer without surprises. There is also an
unauthenticated `GET /health` for container orchestrators.

**It binds `127.0.0.1` by default, and refuses to bind anything wider without a
token.** This process holds your API key, so an open port lets a stranger spend
your quota:

```bash
# fails fast, on purpose
npx @kaidn/mcp --http --host 0.0.0.0

# fine — requires Authorization: Bearer <token>
KAIDN_MCP_HTTP_TOKEN=your_token npx @kaidn/mcp --http --host 0.0.0.0
```

---

## Docker

```bash
docker build -t kaidn-mcp .

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

```bash
npx @kaidn/mcp --allow-writes
```

### Two tools deliberately not exposed

`set_config` would let an agent change scoring weights and thresholds, silently
altering the verdict on **every future event** rather than the one being looked
at. `forget_subject` is irreversible GDPR erasure.

Both belong in the dashboard, in front of a human. They are absent whether or
not `--allow-writes` is set.

---

## Quota protection

Scoring and enrichment each spend a row of your monthly quota, and an agent in a
loop can spend a great many unattended. The server enforces a ceiling per
process and reports remaining budget on every costing response, so the model can
pace itself. A reservation that would overshoot is refused outright rather than
partially spent. Free tools never count.

```bash
KAIDN_MCP_MAX_QUOTA_CALLS=500 npx @kaidn/mcp
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KAIDN_API_KEY` | *required* | Your secret API key |
| `KAIDN_API_URL` | `https://api.kaidn.io` | Override the API base URL |
| `KAIDN_MCP_ALLOW_WRITES` | unset | `1` is equivalent to `--allow-writes` |
| `KAIDN_MCP_MAX_QUOTA_CALLS` | `100` | Quota ceiling per process |
| `KAIDN_MCP_TRANSPORT` | `stdio` | `http` is equivalent to `--http` |
| `KAIDN_MCP_HOST` | `127.0.0.1` | HTTP bind address |
| `KAIDN_MCP_PORT` | `8765` | HTTP port |
| `KAIDN_MCP_HTTP_TOKEN` | unset | Require `Authorization: Bearer` on HTTP |

Flags: `--allow-writes`, `--http`, `--host <addr>`, `--port <n>`.

---

## Run from source

```bash
git clone https://github.com/Kaidn-io/kaidn-mcp.git
cd kaidn-mcp
npm install
npm run build
npm test
```

Point a client at the built entrypoint with an absolute path:

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
