# Codex iMessage service architecture

This document is the implementation contract for the split-user Messages
transport and independent Codex Remote Control client.

## Supported topology

Exactly one topology is supported:

1. A dedicated standard macOS user owns the service iMessage identity,
   Messages database, IMCore session, and patched `imsg` runtime.
2. A small helper in that user's GUI session exposes one pinned chat through
   mutually authenticated local IPC.
3. A LaunchAgent in the active Codex user's session owns the iMessage service,
   durable routing state, Codex credentials, controller enrollment, and
   nonextractable device key.
4. That service creates one independent Remote Control controller and one
   physical controller WebSocket to OpenAI's relay, lazily on first Codex use,
   then multiplexes one owned logical app-server client per active task.
5. The relay routes logical app-server JSON-RPC to the normal private
   app-server already created and owned by Codex Desktop.

The dedicated Messages user is transport-only. The active user's service must
never read the Messages database directly or move Codex credentials/device-key
material into the dedicated account.

The service must not start, supervise, attach to, replace, restart, signal, or
kill a Codex app-server. It must not invoke `codex remote-control start`, open a
local app-server socket, switch the Desktop backend, or fall back to a second
Codex process. Codex Desktop's process tree and normal functionality remain
unchanged.

## Configuration contract

The active messaging configuration is v4:

```json
{
  "version": 4,
  "imsg": {
    "mode": "helper",
    "clientConfig": "/absolute/private/path.json",
    "chatId": 42,
    "chatGuid": "private",
    "expectedSender": "private",
    "featureMode": "bridge",
    "presentation": "rich",
    "polls": true,
    "reactions": true
  }
}
```

Unknown fields fail validation. The helper client configuration must be an
existing owner-only regular file. Outdated configuration fails validation and
must be recreated through authenticated helper setup.

Remote Control enrollment is separate from messaging configuration. Its
owner-only record contains only the enrolled account-user/client identifiers
and public metadata for the nonextractable key. Authentication tokens and
private key material must never be written into messaging configuration.

## Authorization contract

The active user performs a one-time enrollment:

```bash
node bin/imessage-handoff.mjs remote-control authorize
node bin/imessage-handoff.mjs remote-control pair ABCD-EFGH
```

Authorization requires the normal Codex Desktop app to be installed, signed
in, Remote Control-enabled, and online. The flow must:

1. Verify the signed Codex app, exact supported Desktop/app-server versions,
   and pinned native device-key module digest.
2. Read the active user's current Codex account identity and the Desktop-owned
   environment/installation identifiers.
3. Start a scoped PKCE browser reauthentication for
   `codex.remote_control.enroll`.
4. Create a nonextractable device key using the OS-supported protection class.
5. Sign the domain-separated enrollment challenge and finish controller
   enrollment.
6. Persist the owner-only controller record only after the backend accepts the
   enrollment; delete a newly created key on failure.
7. Claim the eight-character alphanumeric code from Codex Desktop through the
   normal ChatGPT-authenticated pairing endpoint, then require the returned
   environment ID and client-scoped environment directory to match the exact
   Desktop environment, installation, host type, and app-server version pins.

The client-scoped directory is authoritative for session routing. The
account-wide environment directory must never be used as a selectable fallback.
Pairing errors preserve generic backend semantics: authentication, permission,
feature availability, or request failure; the client must not infer a more
specific expired/invalid-code state that the endpoint did not return.

Operational commands are:

```bash
node bin/imessage-handoff.mjs remote-control status
node bin/imessage-handoff.mjs remote-control pair ABCD-EFGH
node bin/imessage-handoff.mjs remote-control deauthorize
```

`status` is network-aware and does not alter controller enrollment. It reports
`paired: null` for local-only inspection, then reports a verified boolean when
the network directory is queried. It verifies authentication, enrollment,
native key identity, the exact Desktop environment and installation,
host type/version, and current online state.

A changed controller enrollment immediately rotates the already-loaded service
process before configuration validation, deployment staging, or a network
status lookup. Rotation succeeds only after launchd reports a different ready
PID. If it cannot prove replacement, it verifies that the LaunchAgent is
absent; launchd inspection failures are never interpreted as absence.

`deauthorize` removes only this controller's local enrollment and device key.
It must not disable Desktop Remote Control, remove the Desktop host enrollment,
or alter Desktop's app-server lifecycle. The service remains stopped until a
controller is authorized again.

Revoked-client, incomplete-enrollment, or missing-key backend results invalidate
the unusable local controller material and require fresh authorization.
Transient network/relay failures preserve enrollment and must never cause key
rotation.

## Controller lifecycle contract

- `RemoteControlController` and `RemoteControlConnection` are each created
  lazily once per service process. Each runner gets one owned app-server RPC
  client and logical stream on that shared physical connection.
- Every physical WebSocket open/reopen obtains a freshly refreshed controller
  session and re-verifies the same pinned Desktop environment.
- The physical WebSocket uses protocol v3 and completes a validated signed
  device challenge before any logical stream reports open.
- The runtime allows at most three active iMessage-submitted turns through
  independent logical clients. A task remains serial, and excess work is
  retained and deferred without creating another physical connection.
- Client envelopes have per-stream sequence ids. Unacknowledged envelopes are
  replayed on reconnect; server delivery resumes from the last fully delivered
  cursor.
- Messages larger than the v3 threshold are segmented within the wire-envelope
  cap. Invalid metadata, sequence gaps, segment gaps, or mismatched challenges
  fail closed.
- Native WebSocket and logical stream ping/pong checks are independent.
- The physical WebSocket enforces the 150 KiB wire-envelope cap before
  pre-authorization parsing. Oversize frames are terminal protocol failures,
  not reconnectable network errors.
- Closing the service closes its logical streams, controller WebSocket, and
  helper IPC only. It never sends a process signal to Codex Desktop.
- App-server initiated approval, input, elicitation, and dynamic-tool requests
  are dispatched only to the handler attached to that active turn. Descriptors
  are field-whitelisted, deeply frozen, depth/collection/string bounded, and
  capped at 64 KiB before crossing into presentation code.

Codex Desktop owns host availability. Quitting Desktop makes the pinned
environment offline; reopening Desktop lets its normal private app-server
enrollment return online. The service waits for that state change and never
launches a substitute.

## Readiness contract

Local service readiness means all of the following are true at the same time:

- configured helper identity and helper-reported profile match exactly;
- local IPC is mutually authenticated;
- full bridge, rich text, reply, poll, reaction, receipt, typing, and watch
  capabilities are available;
- inbound watch subscription is live; and
- restored durable jobs are registered before new inbound work runs.

Remote Control is intentionally lazy and is not a prerequisite for the local
Messages watch to be ready. `remote-control status`, not LaunchAgent existence
or local service readiness, is authoritative for Codex authentication,
controller enrollment, and Desktop host online state.

Readiness must degrade when helper/watch health is lost. A running LaunchAgent
or an installed controller enrollment is not sufficient evidence of a healthy
Messages transport.

Runtime bridge and account probes are asynchronous, sequential, and
non-overlapping so their bounded subprocess timeouts cannot stall authenticated
IPC. Transient probe failures require three consecutive samples; a completed
account mismatch or pinned RPC failure remains immediately fatal.

## Routing contract

- Each Codex task maps to its own durable native Messages reply thread.
- An explicit native reply always wins over every inferred context.
- Unthreaded text uses the most recent task addressed by the user. Outbound
  notifications never change that cursor.
- Task commands may use the recent default context for five minutes before
  opening a picker; ordinary prompts retain the user-selected default.
- Polls and awaiting-prompt state are scoped and bounded. They cannot pause
  unrelated task mirrors or completions.
- Unknown and expired votes are visible failures followed by fresh navigation.
- Interactive app-server requests remain in the matching task reply thread.
  They are serialized per task, bounded in memory, never persisted as reusable
  authority, and are aborted when the turn, stream, or service ends. Poll
  tokens correlate a choice with one live request; stale tokens cannot answer a
  later request.

## Delivery contract

Inbound work is durable before execution. A host-offline, authentication,
enrollment, busy-client, or transient relay result defers the durable job rather
than dropping it or selecting another host.

The client message id is persisted before `turn/start` crosses the Remote
Control boundary. A timeout or disconnect after submission enters exact-id
reconciliation and can never return to ordinary submission. This prevents a
lost response from becoming an invisible duplicate turn.

Every semantic outbound operation uses a stable delivery identity. Completed
text is checkpointed independently from generated images; images are accepted
and checkpointed one at a time. A crash may delay a result but must not replay
an already checkpointed component.

Rollout reconciliation is path-aware and bounded. A known changed JSONL path
queues only its catalog task at foreground priority; an unknown path, missing
path, restart, or periodic fallback queues a background full-catalog pass. One
chain per task preserves task-local order, repeated activity while that chain
runs coalesces into one pending pass, and no more than four tasks reconcile at
once. A slow or ambiguous delivery for one task must not block live mirrors for
unrelated tasks. Full passes remain safe because every task owns a durable
rollout cursor.

Delivery retry state is task-local. A retryable result pauses only that task
and schedules one targeted retry; it cannot close the reconciliation gate for
another task. Filesystem work keeps foreground priority, but after a bounded
burst the oldest fallback item must run so sustained hot rollouts cannot starve
recovery scans.

An ambiguous rich send remains pending. It is never repeated through a simpler
send API. No operation falls back to direct `imsg send`, a remote messaging
provider, a local Codex process, or another Remote Control environment.

The sole active-profile messaging exception is a target-locked `imsg rpc`
child for mirroring Codex-authored user text as the outgoing half of the
conversation. It may send only formatted text to the root-proven direct
service chat and exact native task root. Prompt bodies cross stdin rather than
argv. New mirrors use standard `send.rich` and the GUID assigned by Messages;
the caller-GUID extension is optional and is not a readiness dependency. This
standard path is required because caller-owned GUID messages can reach the
recipient without rendering in the sending profile's transcript.

A private delivery journal, exact native Reply-root reservation, confirmed
bridge GUID, and dedicated-side echo ledger make the operation crash-idempotent
without adding hidden Unicode to new message bodies. The receiver may
provisionally hold an exact clean-body/root candidate for the short bridge
registration race. Before the durable send-attempt boundary, body/root
correlation alone never creates a receipt, removes a reservation, or discards
the candidate. Once dispatch may have occurred, a candidate that remains
indistinguishable after the bounded hold is parked privately and fail-closed by
GUID. It is promoted to a receipt only if the later authoritative bridge GUID
names that exact candidate. Every parked nonmatch is atomically re-ingested as
ordinary durable user input, and the daemon dispatches those released actions
immediately; startup pending-action replay is the crash fallback. Parking is
limited to eight plain-text candidates of at most 96 KiB each. Capacity
exhaustion fails before cursor advancement so watch recovery cannot evict user
input. While the bridge supplies no authoritative identity, the unavoidable
ambiguity still prefers preventing a duplicate Codex action. The bridge-returned
GUID is registered immediately, and acceptance requires either the matching
body-bound receiver receipt or an exact normal-profile sender-row proof for
GUID, body, chat, and `thread_originator_guid`. Echo suppression then applies
only to that GUID on that native Reply root, and a reused delivery ID cannot
settle different content.

Outstanding tagged and caller-GUID journals remain readable only for migration
and reconciliation. A definitely-unsent prepared entry may be converted to the
clean standard path, but any entry with send-attempt evidence keeps its
persisted identity and is never resent. Crash-bound or timed-out writes are
reconciled without another send; after fifteen minutes, a body-free task notice
advances the mirror.
It has no recipient, attachment, URL, watch, launch, or Messages lifecycle API;
failure is a separate readiness capability and cannot degrade the helper or
Codex Remote Control.

## Presentation contract

Messages contain no universal header or footer. Native reply threads provide
task context. The first message for a task shows deterministic project
identity, deterministic task identity, status, and Codex URI; subsequent
messages remain content-first.

Projects and tasks use deterministic object emoji identities. State indicators
also include readable text. Project/task directories preserve status, recency,
queue depth, and request previews. Long history responses disclose when older
turns remain.

Markdown source is the canonical fallback, while the bridge compiles headings,
emphasis, and supported links into native rich text. Local file and image links
become bold labels with unusable filesystem targets hidden; portable links keep
their visible destination. Polls enhance navigation but never contain the only
copy of important state.

## Failure behavior

- **Helper or watch loss:** mark local readiness unhealthy, retain pending
  work, and retry authenticated IPC.
- **Desktop host offline:** retain the job, send at most one actionable notice,
  and retry after the exact pinned environment returns.
- **Stale Codex authentication:** require refresh/sign-in through normal Codex
  Desktop state; do not start an authentication app-server process.
- **Controller enrollment/key loss:** fail closed and require
  `remote-control authorize`.
- **Unsupported Codex version/signature/module:** report update-required and
  refuse native signing.
- **Account, environment, installation, host type, or app-server version
  mismatch:** refuse the host without fallback.
- **Relay disconnect:** preserve the logical request and reconnect with
  acknowledgement replay and cursor recovery.
- **Interactive request timeout/disconnect/invalid answer:** send the exact
  method-specific decline or empty failure, revoke the ephemeral choice tokens,
  and ignore late decisions.
- **Incomplete or truncated approval disclosure:** deny automatically without
  presenting an Allow choice. Remote authority is never granted for a command
  or file set that Messages did not display completely.
- **Protocol sequence/segment gap:** close the affected logical stream and
  reconcile the durable request; never infer missing data.
- **Busy task/client:** retain the job without starting a competing turn.
- **Invalid chat/helper identity:** stop before consuming or sending messages.
- **Expired selection:** clear only that selection and refresh navigation.
- **Terminal run failure:** reset one-shot listen state and expose retry/dismiss.
- **Shutdown:** stop watching and detach controller/helper connections without
  interrupting Codex Desktop. Only an explicit user cancellation interrupts a
  canonical turn.

## Security contract

- Helper IPC pins the exact helper account, signed bundle, chat, and expected
  sender on both sides.
- The dedicated Messages account remains a non-administrator and receives no
  Codex auth, controller enrollment, catalog, or device-key material.
- The active user keeps Codex auth, enrollment, durable state, and staged
  attachments in owner-only files.
- Controller enrollment pins account-user id, controller client id, native key
  public identity/protection class, signed Codex app, native module digest,
  Desktop environment id, installation id, `CODEX_DESKTOP_APP` host type, and
  supported app-server version.
- Each controller WebSocket challenge pins purpose/audience, target
  origin/path, client id, session-token digest, token expiry, and exact scope.
  The proof is signed with a domain-separated payload by a nonextractable key.
- Codex control traffic uses OpenAI's authenticated Remote Control relay over
  TLS. No custom hosted relay or third-party messaging provider exists.
- Logs and status must not expose tokens, key material, chat handles, raw
  message bodies, helper-client paths, or attachment source paths.

## Verification gate

Before installation or upgrade:

```bash
pnpm test
pnpm typecheck
git diff --check
```

Preparing a helper upgrade must preserve the existing exchange directory and
live helper socket. Stop the running service only after the new helper installer
succeeds, immediately before single-controller verification and service
deployment.

A release also requires:

- `remote-control status` against the exact open Codex Desktop host;
- controller disconnect/reconnect with unacknowledged replay and cursor resume;
- Desktop quit/offline and normal reopen recovery without another app-server;
- concurrent normal Codex Desktop use while iMessage work runs;
- directory poll, task selection, native reply routing, unthreaded routing,
  task-scoped command picker, rich text, poll vote, attachment, cancellation,
  restart recovery, helper reconnect from the dedicated Messages identity,
  transcript-visible normal-profile outgoing user mirrors, echo-before-result
  suppression, exact sender-row verification, same-body collision resistance,
  historical caller-GUID no-resend reconciliation, and bridge-loss fallback
  behavior;
- deauthorization proving the controller is removed while Codex Desktop and its
  normal private app-server remain unaffected.
