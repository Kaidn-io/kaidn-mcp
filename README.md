# @kaidn/mcp

Model Context Protocol server for the [Kaidn](https://kaidn.io) fraud-scoring API.

Point Claude Code, Claude Desktop, Cursor or any MCP client at your Kaidn tenant
and investigate fraud in plain English — *"why was this signup blocked?"*,
*"what else has this device touched?"*, *"what's in the review queue this morning?"*

**Read-only by default.** Mutating tools are opt-in.

## Install

No install needed:

```bash
npx @kaidn/mcp
```

## Run it from source

Before it is on npm, or to work on it:

```bash
git clone https://github.com/Kaidn-io/kaidn-mcp.git
cd kaidn-mcp
npm install
npm run build
```

Point a client at the built entrypoint with an absolute path:

```bash
claude mcp add kaidn --env KAIDN_API_KEY=your_key -- node /absolute/path/to/kaidn-mcp/dist/index.js
```

To check it starts and lists its tools without a client:

```bash
KAIDN_API_KEY=your_key npm start
```

It should print `kaidn-mcp: ready (read-only, quota ceiling 100)` to stderr and
then wait on stdin — that is the MCP transport, so the silence is correct.

## Configure

Get an API key from your [Kaidn dashboard](https://kaidn.io). The key is read
from the environment and is never accepted as a tool argument.

### Claude Code

```bash
claude mcp add kaidn --env KAIDN_API_KEY=your_key -- npx -y @kaidn/mcp
```

### Claude Desktop / Cursor

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

## Tools

### Read-only

| Tool | Quota | What it does |
|---|---|---|
| `get_stats` | free | Verdict/score/reason rollups over a rolling window |
| `list_events` | free | Scored events, newest first, filterable by verdict or type |
| `explain_event` | free | Every check that fired on one event, with the raw evidence |
| `triage_queue` | free | The `review` queue, highest score first |
| `get_config` | free | Effective weights and thresholds for this tenant |
| `investigate_entity` | 1 row¹ | Enrichment + network reputation + related events for one entity |
| `check_email` | 1 row | Disposable domain, deliverability, fraud score, abuse history |
| `check_ip` | 1 row | Proxy/VPN/Tor, datacenter ASN, geo, abuse history |
| `check_phone` | 1 row | Validity, line type, carrier, fraud score |
| `score_event` | 1 row | Score a new event (also records it) |

¹ free when investigating a `device_id`.

### Mutating — require `--allow-writes`

| Tool | What it does |
|---|---|
| `add_to_list` | Add an entity to the allow or block list |
| `label_outcome` | Report a confirmed fraud / chargeback / legit outcome |

```bash
npx @kaidn/mcp --allow-writes
```

`set_config` and `forget_subject` are **deliberately not exposed**. Changing
scoring thresholds silently alters verdicts for every future event, and
`forget_subject` is irreversible GDPR erasure. Both belong in the dashboard,
where a human can see what they are about to do.

## Quota protection

Scoring and enrichment each consume a row of your monthly quota, and an agent
in a loop can spend a lot of them quickly. The server enforces a per-process
ceiling — **100 quota-consuming calls by default** — and reports remaining
budget on every such response so the model can pace itself.

```bash
KAIDN_MCP_MAX_QUOTA_CALLS=500 npx @kaidn/mcp
```

Free tools do not count against it.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `KAIDN_API_KEY` | *(required)* | Your secret API key |
| `KAIDN_API_URL` | `https://api.kaidn.io` | Override the API base URL |
| `KAIDN_MCP_ALLOW_WRITES` | unset | `1` is equivalent to `--allow-writes` |
| `KAIDN_MCP_MAX_QUOTA_CALLS` | `100` | Per-process quota ceiling |

## Why the evidence matters

Kaidn's engine is rules-first and explainable: every reason carries the raw
numbers behind it. A score on its own gives a model nothing to reason about —
`checks[]` with evidence gives it something to explain. That is what makes
`explain_event` and `investigate_entity` useful rather than decorative.

Rules decide. The model narrates.

## Licence

MIT
