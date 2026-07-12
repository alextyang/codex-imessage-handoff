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

## iMessage interface (v0.3.7)

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
projectless tasks appear in a final `Other tasks` section. Every row includes
the latest user-message preview plus a Working, Pending, Idle, or Error label.
Numbered menus are stable for ten minutes.

The interface is intentionally content-first. There is no universal masthead,
line rule, or active-context footer. Markdown markers are preserved literally
in the Sendblue body so clients can render them in the future; today they remain
readable plain text. Emoji are used only for identity and speaker roles.

Every real project and task receives a pseudo-random, deterministic object
emoji. Task emoji are seeded from the normalized task name and canonical
creation date; project emoji are seeded from the normalized project name and
earliest known task start date. This keeps an identity recognizable wherever it
appears without storing an additional visual preference. `Other tasks` is a
synthetic group, so it does not receive a project emoji.

`/help` is short and contains only available commands:

```text
**Browse**
/threads · Tasks by project
/refresh · Refresh the task list
/search (query) · Find a task
/projects · Browse all projects

**Active task**
/thread · Status and latest response
/turn · Show current or last turn
/history (length) · Completed turn history
/reasoning (level/none) · View or change reasoning
/cancel · Stop iMessage-started work in current thread
```

The recent-thread directory groups qualifying tasks by project, marks the
selection, and gives each task just enough status and request context to identify
it:

```text
▾  ⚙️ **iMessage handoff** · 2 tasks

**Selected**
1️⃣  🧪 **Polish message formatting**
   ◷ Working for 4m
   “Show a full example set of every message type.”

2️⃣  ✏️ Fix duplicate fork history
   ◷ Working for 8m · 2 queued
   “Prevent inherited history from replaying.”

▾ **Other tasks** · 1 task

3️⃣  🧲 Compare messaging providers
   ○ 3h ago · 50 turns
   “Which provider supports richer iMessage interactions?”

Reply with a number to open that thread. Add “1 (message)” to directly message the thread.
“/projects” - See all projects
“/search” - Show threads with specific text
```

Opening a task sends one compact acknowledgement and its relevant controls:

```text
Opened  🧪 **Polish message formatting**
/reasoning (level/none) · /turn · /history · /cancel
```

After that acknowledgement, the selected task is a content-only live
subscription. Local user messages carry a small speaker marker; visible Codex
commentary and final responses are sent without repeated task chrome.
Consecutive reasoning/commentary updates are grouped with blank lines for
readability:

```text
👤 Please rerun the tests after that change.
```

```text
I found the duplicate import path.

I’m checking its callers now.
```

Hidden reasoning, tool output, hook prompts, and system/developer messages are
never mirrored. An iMessage-origin prompt is suppressed from the live feed
because it is already visible in Messages. Native typing remains active while
work is running; structured progress events update typing instead of creating
progress bubbles.

`/turn` and `/history` return one long role-marked transcript without a heading,
timestamps, or command footer:

```text
👤 Normalize all album fields.


☁️ I updated the parser and started the tests.


👤 Also preserve unknown fields.


☁️ Done. All tests pass.
```

`/reasoning none` removes the task-specific override and returns the task to its
normal default. `/reasoning` shows the available levels with `●` on the current
choice; the exact levels follow the task's model capabilities.

When Codex moves the selected task into a locally created active fork, the
service follows that descendant with a compare-and-swap that cannot overwrite a
manual Messages selection. It emits the same single `Opened` acknowledgement
and a current-turn snapshot, then continues the content-only live feed. Existing
fork history is baselined, so inherited parent turns are not replayed as new
messages or task completions.

When the paired user has texted Codex within the previous 24 hours, the service
also watches visible top-level tasks that finish locally and sends their exact
final response. Results from any task other than the selected one name their
source first:

```text
✏️ **Fix duplicate fork history**

All tests pass.
```

Selected-task results contain only the result body. A background notification
never changes where the next ordinary message will go.

Existing task history is baselined silently on first start, and iMessage-started
turns are deduplicated so their requested reply is never followed by a second
completion notice. The same 24-hour activity window applies to debounced
`● Codex is online.` and `○ Codex is offline. New messages will wait until it
reconnects.` notices. Inbound prompts, commands, menu choices, media, and pairing
all refresh the window; outbound notices do not.

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
6. A private cursor tails only canonical local user messages and visible Codex
   commentary for the task currently selected in Messages. Selection changes
   baseline the new rollout; same-selection restarts resume the cursor.
7. Structured lifecycle events drive typing while visible commentary is
   mirrored as content.
8. The final response is sent through Sendblue without adding transport text to
   Codex history.
9. A separate private incremental watcher detects locally completed top-level
   tasks without reinstalling Codex Stop hooks.
10. The Codex child process exits; the small service returns to idle. A heartbeat
   keeps relay presence accurate across sleep and network loss.

## Self-hosting

See [relay/README.md](relay/README.md). Existing self-hosted deployments keep
their Cloudflare Worker/D1 database, Sendblue credentials, webhook, phone
number, domain, install token, and phone pairing. Apply the included migrations
and redeploy the Worker before starting the service.

## Security model

- Prompt and response bodies are not stored in D1.
- D1 stores only the paired phone's last inbound timestamp plus opaque
  completion IDs and multipart counters for idempotent delivery; it never
  stores task content. Retryable completion output remains only in the local
  mode-`0600` service state until it is sent or intentionally suppressed.
- Inbound content lives in the relay only until the connected service
  immediately claims it into its mode-`0600` local queue.
- Thread history, full local paths, and git remotes stay local. Directory
  previews are read locally only when requested, sent transiently to Sendblue,
  and never written to D1 or menu snapshots.
- The live cursor is mode `0600` local state and contains offsets, opaque IDs,
  and one-shot body hashes—not conversation text. The relay persists only
  opaque live-delivery IDs and multipart counters for idempotency.
- A fork context awaiting provider acknowledgement is kept as an exact,
  mode-`0600` local retry record and removed after a terminal delivery result;
  its text is never stored by the relay.
- Tokens, media, logs, and service state are owner-readable only.
- User text is passed through stdin, not process arguments.
- Raw JSONL reasoning, tool output, hooks, system/developer records, and secrets
  are never sent as progress or live conversation.
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
