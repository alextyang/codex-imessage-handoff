# Codex iMessage Service

Continue any visible local Codex thread from iMessage or SMS through one small
user-level service. Codex threads run only while handling a message; no Stop hook
or per-thread skill activation is required.

The system has two components:

- `service`: discovers local Codex threads and runs finite `codex exec resume`
  turns.
- `relay`: connects the service to Messages through
  [Sendblue](https://sendblue.com).

The complete product and implementation contract is in
[docs/PERSISTENT_SERVICE_PLAN.md](docs/PERSISTENT_SERVICE_PLAN.md).

## Install

From this repository:

```bash
pnpm install
node bin/imessage-handoff.mjs install
```

An existing iMessage Handoff relay URL, install token, and phone pairing are
imported automatically. For a fresh self-hosted installation:

```bash
node bin/imessage-handoff.mjs install --relay=https://imessage-handoff.example.com
```

The installer starts a macOS user LaunchAgent. It removes the legacy iMessage
Stop hook only after the new service registers successfully with the relay.

If pairing is required, inspect the service log for the six-character code and
text it to the displayed Sendblue number within 15 minutes:

```bash
tail -f ~/.codex/imessage-handoff/service.log
```

## iMessage interface

Normal text goes unchanged to the selected Codex thread. Service commands use a
slash prefix:

```text
/threads
/recent
/search words
/projects
/status
/cancel
/help
```

Thread replies and service controls are visually distinct:

```text
CODEX · Music crawler

All tests pass.
```

```text
CODEX · SWITCHED

Portfolio refresh

Send a message to continue this thread.
```

The service uses native typing indicators for ordinary work and sends bounded,
deterministic progress only for longer runs.

## Service commands

```bash
node bin/imessage-handoff.mjs service status
node bin/imessage-handoff.mjs service stop
node bin/imessage-handoff.mjs service start
node bin/imessage-handoff.mjs service restart
node bin/imessage-handoff.mjs service pause
node bin/imessage-handoff.mjs service run
node bin/imessage-handoff.mjs service uninstall
```

`service run` keeps the daemon in the foreground for development or platforms
without LaunchAgent support.

## How it works

1. The service reads the local Codex thread catalog in read-only mode.
2. It synchronizes bounded title/project routing metadata to the relay.
3. One authenticated installation WebSocket receives pending thread/reply IDs.
4. The service claims a message only when it can process it.
5. It passes the exact message through stdin to `codex exec resume --json`.
6. Structured lifecycle events drive typing and safe progress.
7. The final response is labeled outside Codex history and sent through
   Sendblue.
8. The Codex child process exits; the small service returns to idle.

## Self-hosting

See [relay/README.md](relay/README.md). Existing self-hosted deployments keep
their Cloudflare Worker/D1 database, Sendblue credentials, webhook, phone
number, domain, install token, and phone pairing. Apply the included migrations
and redeploy the Worker before starting the service.

## Security model

- Prompt and response bodies are not stored in D1.
- Pending inbound content lives only in the relay Durable Object until claimed.
- Thread history, previews, full local paths, and git remotes stay local.
- Tokens, media, logs, and service state are owner-readable only.
- User text is passed through stdin, not process arguments.
- Raw JSONL tool output and secrets are never sent as progress.
- The initial service does not expose remote model, reasoning, approval,
  sandbox, deletion, or archival controls.

Keep `~/.codex/imessage-handoff/config.json` private. Resetting the install token
revokes the paired phone.

## Development

```bash
pnpm test
pnpm typecheck
```
