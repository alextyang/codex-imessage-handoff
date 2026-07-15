# Codex local iMessage service

A persistent macOS service for controlling Codex tasks from Messages without
changing how Codex Desktop starts or runs. It combines a dedicated Messages
account, an authenticated local `imsg` helper, and an independent Remote
Control client in the active Codex user's session.

There is no shared app-server daemon. Codex Desktop continues to create, own,
and stop its normal private app-server process. The iMessage service reaches
that process only through OpenAI's Remote Control relay.

## Architecture

```text
Dedicated Messages user                 Active Codex user

Messages / IMCore
        │
        ▼
patched imsg + pinned helper
        │ mutually authenticated local IPC
        └──────────────────────────────► iMessage service
        ▲                                      │
        │ normal-profile user-mirror echo      │ target-locked imsg RPC
        └──────────────────────────── Messages / IMCore
                                               │
                                      (active Codex user)
                                                │
                                      Remote Control client
                                                │ HTTPS + WSS, protocol v3
                                                ▼
                                      OpenAI Remote Control relay
                                                │
                                                ▼
                                  Desktop-owned private app-server
                                                │
                                          Codex Desktop
```

The dedicated Messages user is transport-only: it owns the Messages database,
iMessage identity, and IMCore process, but it never receives Codex credentials
or controls Codex processes. The active Codex user owns the service, Codex
credentials, controller enrollment, and device key.

Codex-authored user messages take one deliberately narrow reverse path: a
normal-profile `imsg rpc` child sends only rich text to the root-proven direct
service conversation. The body travels over the child's stdin, never process
arguments. The shared message GUID and exact native Reply root suppress the
dedicated-account echo without adding hidden Unicode to the message body. A
send is accepted only after the normal profile observes that exact GUID with
the expected native `thread_originator_guid`. The returned GUID is registered
before the slower local-history proof so the receiver can suppress its exact
echo immediately. If the incoming bubble wins that race, an exact-root,
visible-body-hash candidate waits for at most one second by default, with a
hard two-second cap. Body/root correlation never creates a receipt, consumes a
reservation, or discards a message; without exact GUID/root confirmation the
bubble proceeds as genuine user input. Ambiguous writes are reconciled without
resending; after 15 minutes, a content-free task notice unblocks later output.
This sender cannot select recipients, send files or URLs, watch Messages,
launch/relaunch Messages, or control any Codex process.

Codex window focus and the task currently open in the Codex sidebar are never
inputs to user-mirror delivery. A Codex-authored user message remains visible
in iMessage whether Codex is frontmost, backgrounded, or showing that same
task. Only an explicit task mute, the short manual-selection prompt lease, or
the one-shot suppression of an iMessage message already visible in its native
Reply thread can intentionally omit or defer that user mirror.

The Remote Control client is independent from Codex Desktop. It does not
attach to a local socket, launch `codex app-server`, use `codex remote-control
start`, switch Desktop to another backend, or signal Desktop-owned processes.

## Requirements

- macOS with a separate standard (non-administrator) account signed into the
  service's iMessage identity.
- Codex Desktop installed and signed in under the active Codex user, with
  Remote Control enabled. The normal Desktop app must be open for its host
  environment to be online.
- An installed Codex build supported by this service. The app version,
  app-server version, signed native device-key module, and module digest are
  pinned and fail closed after an unsupported Codex update.
- `imsg` with the daemon-safe, custom-emoji tapback, and macOS 27 edit patches
  in `docs/`, applied in that order, plus the full IMCore bridge enabled.
- The active Codex profile also needs the local `imsg` IMCore bridge active for
  outgoing user mirrors. The service probes it but never launches or relaunches
  Messages automatically; core helper and Codex functions remain independent.
- Network access to OpenAI authentication and Remote Control endpoints.
- Node.js 22.6 or newer and pnpm 10.26.

The service transport profile is fixed: authenticated helper mode, bridge
features, native rich text, native replies, polls, and reactions. Basic,
automatic-downgrade, plain-text, arbitrary-recipient local transport, and
hosted messaging profiles are rejected. The target-locked user-mirror RPC
above is the only normal-profile send capability.

## Setup

Install dependencies and verify the source:

```bash
pnpm install
pnpm test
pnpm typecheck
```

Open Codex Desktop under the active Codex user, sign in, and enable Remote
Control in Codex settings. Leave the app open during initial authorization and
pairing. In Codex, open **Settings → Connections → Control this Mac** and
request a pairing code.
Do not install or start a separate app-server daemon.

Authorize the active user's independent Remote Control client before finishing
Messages helper setup:

```bash
node bin/imessage-handoff.mjs remote-control authorize
node bin/imessage-handoff.mjs remote-control pair ABCD-EFGH
```

This order is intentional: `authorize` enrolls this independent client, while
`pair` grants that exact client access to the Desktop environment pinned in the
active user's Codex state. Pairing codes contain eight letters or digits; the
CLI accepts the compact or `ABCD-EFGH` form. Neither code
nor authentication tokens are printed or persisted. Authorization and pairing
can be completed before the Messages profile exists. Initial `finish-helper`
then requires the client-scoped environment directory to contain the exact
pinned Desktop installation before launching the daemon.

Harden the existing dedicated Messages account before staging the helper. This
requests administrator authorization only for account/group changes, removes
administrator and other privileged memberships, creates a two-member private
exchange group, and does not change Messages data or secure-token state:

```bash
node bin/imessage-handoff.mjs transport harden-helper --helper-user=codex
```

Log out of and back into the dedicated Messages account after this command.

Prepare the split-user bundle from the active Codex account:

```bash
IMSG_RUNTIME=/absolute/path/to/patched/imsg-release
node service/scripts/prepare-split-user-helper.mjs \
  --recipient-config="$HOME/.codex/imessage-handoff/config.json" \
  --daemon-safe-imsg="$IMSG_RUNTIME/imsg" \
  --imsg-runtime="$IMSG_RUNTIME" \
  --dedicated-user=codex \
  --project-root="$PWD"
```

With the dedicated Messages account still logged in, launch the signed
installer from the active Codex account, then finish configuration. Keep an
existing service running until the installer succeeds; staging preserves its
live exchange socket, and a failed or unanswered approval must not take the
old helper offline.

```bash
node service/scripts/install-prepared-helper.mjs --helper-user=codex
node bin/imessage-handoff.mjs service stop
node bin/imessage-handoff.mjs transport finish-helper --helper-user=codex
```

If the cross-profile administrator dialog is not visible, switch to the
dedicated Messages account and run
`/Users/Shared/codex-imessage-helper/Install Codex Messages.command` instead.
Stop the service only after either installer reports success, immediately
before `finish-helper`, because the helper permits one authenticated controller
at a time.

`finish-helper` saves only the private helper-client path and pinned chat
identity. Configuration is owner-only (`0600`). Outdated configuration is
rejected and must be recreated with `finish-helper`.

Verify all three boundaries:

```bash
node bin/imessage-handoff.mjs transport check
node bin/imessage-handoff.mjs remote-control status
node bin/imessage-handoff.mjs service status
```

## Remote Control commands

```bash
node bin/imessage-handoff.mjs remote-control authorize
node bin/imessage-handoff.mjs remote-control pair ABCD-EFGH
node bin/imessage-handoff.mjs remote-control status
node bin/imessage-handoff.mjs remote-control deauthorize
```

- `authorize` is the one-time browser and device-key enrollment flow. Running
  it again is idempotent while the saved enrollment remains valid. It reports
  `pairingRequired` until pairing is verified; the local Messages watch remains
  available while setup, cancellation, or a transient authorization failure is
  in progress. If authorization replaces the enrollment, the already-installed
  client process is immediately rotated and must prove a new ready PID before
  configuration, deployment preflight, or network status continues. A failed
  rotation verifies that the LaunchAgent is unloaded instead of retaining an
  older authorized socket.
- `pair` claims the code shown by Codex Desktop for this enrolled client. It
  accepts eight alphanumeric characters (with or without the middle hyphen),
  then verifies the response and the client-scoped environment catalog against
  the exact local environment ID, installation ID, Desktop host type, and
  app-server version. It never selects an account-wide environment.
- `status` performs a network-aware check of Codex authentication, local
  controller enrollment, pinned Desktop environment, installation and version,
  and current host online state. It does not enroll or deauthorize a controller.
- `deauthorize` stops the service and deletes this controller's local enrollment
  and nonextractable device key. It leaves the service stopped until it is
  authorized again. It does not disable
  Remote Control in Codex Desktop or delete the Desktop host enrollment.

Re-run `authorize`, then `pair`, after deauthorization, controller revocation,
device-key loss, or an enrollment reset. If Codex was updated and status reports an
unsupported version, update this service's compatibility pins before
authorizing again; never bypass the verification.

Authorization and pairing do not pre-stop a ready local Messages service.
Controller state is replaced atomically, and successful paired setup activates
the replacement through the normal transactional service restart; an activation
failure restores the prior ready job. During first-time setup the command reports
that Messages configuration is still required. Ordinary service start/restart
checks remain local so a temporary network outage cannot prevent recovery; the
daemon retries Remote Control connectivity without touching Codex Desktop
processes.

## Service commands

```bash
node bin/imessage-handoff.mjs service install
node bin/imessage-handoff.mjs service status
node bin/imessage-handoff.mjs service restart
node bin/imessage-handoff.mjs service stop
node bin/imessage-handoff.mjs service uninstall
node bin/imessage-handoff.mjs service run
```

Install and restart wait for truthful local messaging readiness. A ready
service proves that the authenticated helper, exact profile, bridge
capabilities, and watch subscription are live. Remote Control is deliberately
lazy, so `remote-control status` is the authoritative host/authentication check;
`service status` may remain locally ready while Codex Desktop is closed.

Transport diagnostics are intentionally small:

```bash
node bin/imessage-handoff.mjs transport status
node bin/imessage-handoff.mjs transport check
```

Status output redacts the chat GUID, sender identity, and helper-client path.

## Runtime lifecycle

1. The active user's LaunchAgent starts the iMessage service and authenticates
   the dedicated user's helper/watch connection.
2. The Remote Control controller and relay connection are created lazily when
   Codex work is first needed. Each active iMessage task gets its own
   app-server RPC client and logical stream on that shared connection.
3. The controller reads the active user's current Codex authentication,
   refreshes its short-lived Remote Control session, and verifies the exact
   enrolled Desktop environment is online.
4. One physical controller WebSocket connects to OpenAI's relay. A signed
   device challenge must complete before any logical app-server stream opens.
5. JSON-RPC requests travel through the relay to the private app-server already
   owned by Codex Desktop. Desktop continues operating normally on its own
   connection and lifecycle.
6. Relay reconnects use acknowledgements, replay of unacknowledged client
   envelopes, and a server cursor. Protocol gaps and invalid challenges close
   the affected stream rather than guessing.
7. Service stop closes every active logical stream, the relay connection, and helper IPC.
   It never stops, restarts, or signals Codex Desktop or its app-server.

The LaunchAgent strips the retired local-daemon routing variable before the
service starts. Migration cleanup runs only after the replacement service is
ready and removes only ownership-proven artifacts from the retired
`com.codex.imessage-handoff.shared-backend` deployment. It does not enumerate
or modify unrelated LaunchAgents.

When Codex Desktop quits, its environment goes offline normally. Pending
iMessage work remains durable and is deferred until Desktop is reopened and
the same pinned environment returns.

## Messages interface

Each Codex task owns a durable native Messages reply thread. Replying to a task
message routes to that exact Codex task. An unthreaded message routes to the
task most recently addressed by the user, not the task that most recently sent
a notification. Task commands use that default for five minutes; ordinary new
messages keep using it until the user addresses another task.

A Messages header shows the project first and task immediately underneath,
followed by a separated status block and task link. Opening its
`codex://threads/<id>` link asks the normal Codex Desktop UI to show that task.
The service does not force-open or retarget Desktop windows and does not
fabricate Desktop UI notifications. Remote activity is recorded by the normal
Codex host; what Desktop renders live still depends on the task currently
loaded in its UI.

Directory browsing uses rich project/task polls. New-task project selection
includes every active or recently used project and splits long directories
into bounded native poll parts without dropping choices. Poll selection is
task-local, expires after five minutes, and never pauses unrelated task
updates. Expired or unknown votes produce a fresh directory rather than
silently changing context.

Available commands:

```text
/new [message]  Choose a project and reasoning, then create a task
/threads        Browse tasks by project
/refresh        Refresh the directory
/search query   Search every visible task
/projects       Browse projects
/thread         Current status, Codex link, and latest response
/request        Latest user request
/turn           Current or latest turn
/history 3      Completed turn history
/reasoning high View or change reasoning
/defaultreasoning high  View or change the iMessage reasoning default
/listen         Stream the next turn's visible updates
/mute           Mute automatic task updates
/unmute         Resume automatic task updates
/retry          Retry failed iMessage work
/dismiss        Dismiss failed iMessage work
/help           Show command help
```

Adding or removing 👍 on a task message enables or disables one-turn live
listening. Adding or removing 👎 mutes or unmutes that task. Adding ❓ shows
its status, Codex link, and recent history. Adding ‼️ stops iMessage-started
work in that task immediately. Task-scoped commands sent outside a native
reply thread use the five-minute default before opening a task picker.
Notifications cannot silently retarget them. A `/new` command without a
message waits up to 120 seconds for the first unthreaded message and pauses
proactive task traffic during that short handoff. Its first turn listens for
live updates by default; `/cancel` remains available only while that new-task
setup is unfinished.

### Codex questions and approvals

When Codex pauses a remotely started turn for permission or user input, the
request appears inside that task's native reply thread. Command and file-change
requests show bounded, sanitized details and a native poll for **Allow once**,
**Allow for session**, or **Deny**. Codex questions use one prompt at a time;
finite choices use native polls and free-form answers use a reply. Connected
service forms and manual dynamic-tool results are also routed to the same task.

Interaction authority is deliberately ephemeral. It exists only while the
matching Remote Control turn and service process are alive, expires after at
most two minutes (or the app-server's shorter auto-resolution deadline), and
is never replayed after a restart. Missing, malformed, stale, timed-out, or
disconnected replies use the app-server method's exact fail-closed response.
Secret questions are never accepted through Messages and must be completed in
Codex on the Mac.

## Delivery and recovery

- Inbound text and imported images are persisted locally before Codex work is
  queued.
- Every authorized inbound Messages event is marked read, including poll and
  tapback events that intentionally produce no Codex action.
- The runtime multiplexes up to three independently owned Remote Control RPC
  clients over one physical relay connection. A task still runs only one turn
  at a time; excess or same-task work remains queued and starts automatically.
- Every submitted turn has a durable client message id. If the relay or host
  disconnects after accepting `turn/start`, recovery looks up that exact id and
  never blindly submits a replacement turn.
- Protocol-v3 client envelopes are sequenced and retained until acknowledged.
  Reconnect replays only unacknowledged work and resumes server delivery from
  the last fully delivered cursor.
- Text and generated-image acceptance are checkpointed so a restart does not
  replay an already accepted part.
- Native message GUID routing, poll state, mute/listen state, run state, and
  live-mirror offsets are private local files. The user-mirror journal stores
  hashes, markers, and routing metadata, never message bodies.
- Helper/watch degradation changes local service readiness immediately and
  recovers without claiming a healthy state prematurely.
- Periodic bridge/account checks run asynchronously and sequentially, tolerate
  two transient samples, and immediately retire the helper for an authoritative
  account mismatch or pinned RPC failure. Slow probes cannot block helper IPC.
- Remote Control availability is a separate readiness capability. Successful
  RPC traffic proves it online; only an explicit host-offline response produces
  an offline presence notification. Authentication, pairing, and transient
  relay failures are reported as degraded without mislabeling the Mac offline.
- Deferred Remote Control work uses durable capped exponential backoff. A
  pairing/setup failure reaches a 30-minute cap, transient availability a
  five-minute cap, and busy-task retries a one-minute cap; stopping removes
  the block immediately.
- Helper bundle upgrades preserve the existing mutable exchange directory and
  live Unix socket until the newly authorized helper takes over.
- Closing the service detaches from Remote Control; it does not cancel a
  canonical Codex turn unless the user explicitly stopped that task with ‼️.
- No operation falls back to another Codex transport, another environment, a
  local app-server process, or `imsg send`.
- Losing the normal-profile rich bridge degrades only the user-mirror
  capability. The service never restarts Messages, and the authenticated
  helper/watch and Codex Remote Control paths continue independently.

## Failure modes

- **Codex Desktop closed or host offline:** retain and defer work. Reopen Codex
  Desktop, then confirm `remote-control status` reports the pinned host online.
- **Codex authentication stale:** sign in or refresh authentication in Codex
  Desktop, then retry status. The service does not run a second app-server to
  refresh credentials.
- **Enrollment revoked or device key missing:** run `remote-control authorize`
  again. Revocation-class failures clear unusable local enrollment material;
  transient relay failures do not.
- **Unsupported Codex update or signature mismatch:** fail closed with an
  update-required error. Do not copy or load an unverified native module.
- **Environment, installation, account, client type, or app-server version
  mismatch:** refuse the connection. The controller never selects a different
  available host as a fallback.
- **Relay interruption:** keep the logical task, reconnect, and use v3 replay
  and cursor recovery. A sequence/segment gap closes that logical stream.
- **Helper/watch loss:** mark the local service not ready, preserve durable
  work, and retry the authenticated helper connection.
- **Busy task or client:** retain the job without starting a competing turn.

## Privacy and security

- The Messages database, iMessage identity, helper signing keys, raw chat
  handles, and attachment source paths remain in the dedicated Messages user.
- The active user retains Codex authentication, controller enrollment, device
  key, task catalog, and durable service state in owner-only files.
- Codex requests and responses traverse OpenAI's authenticated Remote Control
  relay over TLS. There is no Sendblue path, custom hosted relay, or additional
  third-party messaging service.
- Exact chat and expected-sender pins are verified on both sides of the helper
  boundary. IPC is mutually authenticated.
- The device key is nonextractable. Enrollment is pinned to the account user,
  controller client id, signed Codex bundle, native module digest, Desktop
  environment id, installation id, `CODEX_DESKTOP_APP` host type, and supported
  app-server version.
- Each WebSocket connection validates its target origin/path, controller id,
  session-token digest, expiry, and exact controller scope before signing a
  domain-separated challenge.
- Physical and logical Remote Control payloads are capped at the protocol's
  150 KiB wire-envelope limit before JSON parsing; oversize frames fail
  terminally instead of entering a reconnect loop.
- Attachments are copied into owner-only local storage and validated before
  use.
- The dedicated Messages account should remain a standard user with no admin
  or broad privileged-group membership.
- Never put helper keys, device enrollment, Codex tokens, chat handles, or
  private client configuration in logs, shell history, or source control.

## Development

```bash
pnpm test
pnpm typecheck
git diff --check
```

The implementation is in `service/src/`; the shared message grammar is in
`protocol/`. See `docs/PERSISTENT_SERVICE_PLAN.md` for the runtime invariants
and failure model.
