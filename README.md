# Codex local iMessage service

A persistent, local macOS service for controlling Codex tasks from Messages.
It uses one dedicated macOS Messages account, an authenticated local `imsg`
helper, and the supervised Codex app-server shared with Codex Desktop.

The service fails closed if its authenticated helper, rich IMCore bridge,
selected chat, or shared Codex backend is unavailable.

## Architecture

```text
Messages on dedicated macOS account
        │ private imsg RPC
        ▼
authenticated split-user helper
        │ mutually authenticated local IPC
        ▼
Codex iMessage service
        │ local WebSocket
        ▼
supervised shared Codex app-server ◀── Codex Desktop
```

The helper is pinned to one exact iMessage chat and one expected sender. IPC is
mutually authenticated. The service account never receives the dedicated
Messages account's database or signing material.

## Requirements

- macOS with a separate standard (non-administrator) account signed into the
  service's iMessage identity.
- `imsg` with the daemon-safe, custom-emoji tapback, and macOS 27 edit patches
  in `docs/`, applied in that order, plus the full IMCore bridge enabled.
- A healthy supervised shared Codex app-server, with Codex Desktop connected
  to it.
- Node.js 22.6 or newer and pnpm 10.26.

The supported messaging profile is fixed: authenticated helper mode, bridge
features, native rich text, native replies, polls, and reactions. Basic,
automatic-downgrade, plain-text, and direct/local CLI profiles are rejected.

## Setup

Install dependencies and verify the source:

```bash
pnpm install
pnpm test
pnpm typecheck
```

Prepare and activate the shared Codex backend:

```bash
node bin/imessage-handoff.mjs desktop-sync prepare
node bin/imessage-handoff.mjs desktop-sync activate
# Quit and reopen Codex Desktop once.
node bin/imessage-handoff.mjs desktop-sync finish
```

Harden an existing dedicated Messages account before staging the helper. This
requests administrator authorization only for account/group changes, removes
administrator and other privileged memberships, creates a two-member private
exchange group, and does not change Messages data or secure-token state:

```bash
node bin/imessage-handoff.mjs transport harden-helper --helper-user=codex
```

Log out of and back into the dedicated Messages account after this command.

Prepare the split-user bundle from the controller account:

```bash
IMSG_RUNTIME=/absolute/path/to/patched/imsg-release
node service/scripts/prepare-split-user-helper.mjs \
  --recipient-config="$HOME/.codex/imessage-handoff/config.json" \
  --daemon-safe-imsg="$IMSG_RUNTIME/imsg" \
  --imsg-runtime="$IMSG_RUNTIME" \
  --dedicated-user=codex \
  --project-root="$PWD"
```

With the dedicated Messages account still logged in, launch the signed installer
from the controller account (macOS asks for administrator approval), then finish
configuration. Keep an existing service running until the installer succeeds;
staging preserves its live exchange socket, and a failed or unanswered approval
must not take the old helper offline.

```bash
node service/scripts/install-prepared-helper.mjs --helper-user=codex
node bin/imessage-handoff.mjs service stop
node bin/imessage-handoff.mjs transport finish-helper --helper-user=codex
node bin/imessage-handoff.mjs service install
node bin/imessage-handoff.mjs transport check
```

If the cross-profile administrator dialog is not visible, switch to the
dedicated Messages account and run
`/Users/Shared/codex-imessage-helper/Install Codex Messages.command` instead.
Stop the service only after either installer reports success, immediately before
`finish-helper`, because the helper permits one authenticated controller at a
time.

`finish-helper` saves only the private helper-client path and the pinned chat
identity. Configuration is owner-only (`0600`). Outdated configuration is
rejected and must be recreated with `finish-helper`.

## Service commands

```bash
node bin/imessage-handoff.mjs service install
node bin/imessage-handoff.mjs service status
node bin/imessage-handoff.mjs service restart
node bin/imessage-handoff.mjs service stop
node bin/imessage-handoff.mjs service uninstall
node bin/imessage-handoff.mjs service run
```

Install and restart wait for truthful readiness. If the helper, watch stream,
or shared backend does not become healthy, startup fails rather than reporting
a false ready state.

Transport diagnostics are intentionally small:

```bash
node bin/imessage-handoff.mjs transport status
node bin/imessage-handoff.mjs transport check
```

Status output redacts the chat GUID, sender identity, and helper-client path.

## Messages interface

Each Codex task owns a durable native Messages reply thread. Replying to a task
message routes to that exact Codex task. An unthreaded message routes to the
task most recently addressed by the user, not the task that most recently sent
a notification. Task commands use that default for five minutes; ordinary new
messages keep using it until the user addresses another task.

Codex Desktop receives the same shared app-server events, but its renderer keeps
conversation state only for tasks it has loaded itself. A task already open in
Desktop shows live progress. A Messages header shows the project first and the
task immediately underneath, followed by a separated status block and task
link. Opening its `codex://threads/<id>` link hydrates a cold task and
reconstructs its active turn. The
shared protocol does not expose a safe cross-client UI-hydration request, so the
service does not force-open or retarget Desktop windows or fabricate UI
notifications.

Directory browsing uses rich project/task polls. New-task project selection
includes every active or recently used project and splits long directories into
bounded native poll parts without dropping choices. Poll selection is task-local,
expires after five minutes, and never pauses unrelated task updates. Expired or
unknown votes produce a fresh directory rather than silently changing context.

Available commands:

```text
/new [message]  Choose a project and reasoning, then create a task
/threads        Browse tasks by project
/refresh        Refresh the directory
/search query   Search every visible task
/projects       Browse projects
/thread         Current status and latest response
/request        Latest user request
/turn           Current or latest turn
/history 3      Completed turn history
/reasoning high View or change reasoning
/defaultreasoning high  View or change the iMessage reasoning default
/listen         Stream the next turn's visible updates
/link           Open the task in Codex
/mute           Mute automatic task updates
/unmute         Resume automatic task updates
/retry          Retry failed iMessage work
/dismiss        Dismiss failed iMessage work
/cancel         Cancel iMessage-started work
/help           Show command help
```

Adding or removing 👍 on a task message enables or disables one-turn live
listening. Adding or removing 👎 mutes or unmutes that task. Adding ❓ shows
its status and recent history. Task-scoped commands sent outside a native reply
thread use the five-minute default before opening a task picker. Notifications
cannot silently retarget them. A `/new` command without a message waits up to
120 seconds for the first unthreaded message and pauses proactive task traffic
during that short handoff. Its first turn listens for live updates by default.

## Delivery and recovery

- Inbound text and imported images are persisted locally before a Codex run is
  queued.
- Every authorized inbound Messages event is marked read, including poll and
  tapback events that intentionally produce no Codex action.
- The service uses one Codex run at a time through the shared app-server.
- Every submitted turn has a durable client message id. If the app-server
  disconnects after accepting `turn/start`, recovery looks up that exact id and
  never blindly submits a replacement turn.
- Text and generated-image acceptance are checkpointed so a restart does not
  replay an already accepted part.
- Native message GUID routing, poll state, mute/listen state, run state, and
  live-mirror offsets are private local files.
- Helper/watch degradation changes service readiness immediately and recovers
  without claiming a healthy state prematurely.
- Helper bundle upgrades preserve the existing mutable exchange directory and
  live Unix socket until the newly authorized helper takes over.
- Codex window focus never suppresses Messages progress or results. A visible
  window does not prove that it owns the app-server connection which started a
  turn; explicit task mute is the only automatic-delivery suppression.
- No operation falls back to another transport or to `imsg send`.

## Privacy and security

- Conversation content, credentials, catalogs, and attachments remain on the
  Mac.
- Exact chat and expected-sender pins are verified on both sides of the helper
  boundary.
- Attachments are copied into owner-only local storage and validated before use.
- The dedicated Messages account should remain a standard user with no admin or
  broad privileged-group membership.
- Never put helper keys, chat handles, or private client configuration in logs,
  shell history, or source control.

## Development

```bash
pnpm test
pnpm typecheck
git diff --check
```

The implementation is in `service/src/`; the shared message grammar is in
`protocol/`. See `docs/PERSISTENT_SERVICE_PLAN.md` for the runtime invariants
and failure model.
