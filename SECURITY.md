# Security Policy

## Reporting a vulnerability

Report security issues privately to **security@kaidn.io**. Please do not open a
public issue for anything exploitable.

Include what you can — affected version, reproduction steps, and what an
attacker could achieve. We aim to acknowledge within 3 working days and to
agree a disclosure timeline with you once the issue is confirmed.

You may also use GitHub's
[private vulnerability reporting](https://github.com/Kaidn-io/kaidn-mcp/security/advisories/new)
on this repository.

## Scope

This repository is the **MCP server only** — a client of the Kaidn API. It holds
credentials and forwards requests; it contains no scoring logic, thresholds or
weights.

Vulnerabilities in the Kaidn API itself, the dashboard, or the browser
fingerprint library belong elsewhere; mail the same address and we will route
them.

## What this server is designed to protect against

These are deliberate guarantees. A break in any of them is a vulnerability, so
report it:

| Guarantee | Why |
|---|---|
| The API key never crosses the tool boundary | Not a tool parameter, not in output, not in an error message. A model that can read the key can exfiltrate it. |
| The API key is never accepted as a CLI flag | Flags leak into process listings and shell history. |
| Read-only unless `--allow-writes` | An agent must not be able to silently change a tenant's blocklists or scoring. |
| `set_config` and `forget_subject` are never exposed | One changes verdicts for every future event; the other is irreversible erasure. Neither belongs behind a natural-language interface. |
| HTTP refuses a non-loopback bind without a bearer token | An open port on a process holding your key lets a stranger spend your quota. It fails closed. |
| The quota ceiling holds across HTTP requests | A per-request counter would reset every call and enforce nothing. |

## Known limitations

Stated plainly, because pretending otherwise is worse than the limitation:

- **Bearer auth is a single shared secret.** It gates access; it does not
  identify callers or support rotation without a restart. For anything
  multi-tenant, terminate auth at a reverse proxy.
- **HTTP mode is single-tenant.** The process holds one API key and every caller
  spends that tenant's quota. Run one process per tenant.
- **The quota ceiling is per process, not per tenant.** Restarting resets it.
  It is a guard against runaway agents, not a billing control.
- **stdio mode inherits the trust of whoever launched it.** Any client that can
  spawn the process can use every registered tool.

## Supported versions

Pre-1.0. Security fixes land on the latest minor release only.
