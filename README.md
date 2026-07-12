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
/refresh
/search words
/projects
/thread
/request
/turn
/history 3
/reasoning high
/status
/retry
/dismiss
/cancel
/help
```

The local service builds `/threads` on demand. Under each project it shows all
tasks with pending work first, followed by every task with a turn in the last
48 hours. Projects with no matching tasks are omitted, and Codex's explicitly
projectless tasks appear in a final `OTHER TASKS` section. Every row includes
the latest user-message preview plus a Working, Pending, Idle, or Error label.
Numbered menus are stable for ten minutes.

Thread replies and service controls use separate visual namespaces:

```text
CODEX THREAD · MUSIC CRAWLER
Fix album metadata

All tests pass.
```

```text
CODEX CONTROL · THREADS
3 tasks · pending + activity in last 48h · refreshed now

MUSIC CRAWLER
1. Retry failed imports
   Pending · 12m ago
   “Rerun the failed import without creating duplicate IDs.”
2. Fix album metadata
   Selected · Idle · 5m ago
   “Normalize album dates, then rerun the tests.”

OTHER TASKS
3. Compare messaging providers
   Idle · 3h ago
   “Which provider supports richer iMessage interactions?”

Reply with a number to open.
Use “2: message” to open and send.

/refresh · /search · /projects · /help
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

1. The service reads the local Codex thread catalog in read-only mode and
   removes automated/subagent sessions using Codex's canonical metadata.
   Same-lineage forks and unrelated same-title sessions remain independently
   reachable and receive stable `Fork N` or `Session N` display labels.
2. It synchronizes bounded title/project routing metadata to the relay.
3. One authenticated installation WebSocket receives pending thread/reply IDs.
4. The service immediately claims each notified message into a private local
   queue so Cloudflare hibernation cannot lose it. Other tasks are marked
   Pending and distinct tasks run concurrently within a small bound. Claimed
   work and completed-but-undelivered output survive a service restart.
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
- Inbound content lives in the relay only until the connected service
  immediately claims it into its mode-`0600` local queue.
- Thread history, full local paths, and git remotes stay local. Directory
  previews are read locally only when requested, sent transiently to Sendblue,
  and never written to D1 or menu snapshots.
- Tokens, media, logs, and service state are owner-readable only.
- User text is passed through stdin, not process arguments.
- Raw JSONL tool output and secrets are never sent as progress.
- Per-task reasoning overrides are stored only in the private local service
  directory and applied to the next iMessage-started turn. The service does not
  remotely change approval, sandbox, deletion, or archival settings.

Keep `~/.codex/imessage-handoff/config.json` private. Resetting the install token
revokes the paired phone.

## Development

```bash
pnpm test
pnpm typecheck
```
