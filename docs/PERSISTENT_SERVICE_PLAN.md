# Local iMessage service architecture

This document is the implementation contract for the local-only Codex Messages
service.

## Supported topology

Exactly one messaging topology is supported:

1. A dedicated standard macOS user owns the service iMessage identity.
2. A daemon-safe `imsg` process runs in full bridge mode in that user's GUI
   session.
3. A small helper exposes the pinned chat through mutually authenticated local
   IPC.
4. The controller user's service consumes that IPC and connects to the
   supervised Codex app-server already used by Codex Desktop.

The service must not start in direct CLI, basic, plain-text, auto-downgrade, or
private Codex-process mode. It must never launch a second messaging backend or
silently fall back after an ambiguous send.

## Configuration contract

The active configuration is v4:

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

Unknown fields fail validation. The client configuration must be an existing
owner-only regular file. Outdated configuration fails validation and must be
recreated through the authenticated helper setup.

## Readiness contract

Ready means all of the following are true at the same time:

- the configured helper identity and helper-reported profile match exactly;
- the IPC channel is authenticated;
- the full bridge, rich text, reply, poll, reaction, and watch capabilities are
  available;
- the inbound watch subscription is live;
- the supervised shared Codex app-server is healthy; and
- restored durable jobs have been registered before new inbound work runs.

Readiness must degrade when helper/watch health is lost. A LaunchAgent process
existing is not sufficient evidence of readiness.

## Routing contract

- Each Codex task maps to its own durable native Messages reply thread.
- An explicit native reply always wins over every inferred context.
- Unthreaded text uses the most recent task addressed by the user. Outbound
  notifications never change that cursor.
- Every unthreaded task command opens a task picker.
- Polls and awaiting-prompt state are scoped to one task and expire after five
  minutes. They cannot pause other task mirrors or completions.
- Unknown and expired votes are visible failures followed by a fresh directory.

## Delivery contract

Inbound work is durable before execution. One shared-backend turn runs at a
time. Restart reconciliation compares a persisted running request with the live
rollout before deciding whether to wait, deliver an already completed result,
or submit work.

Every semantic outbound operation uses a stable delivery identity. Completed
text is checkpointed independently from generated images; images are accepted
and checkpointed one at a time. A crash may delay a result but must not replay
an already checkpointed component.

An ambiguous rich send remains pending. It is never repeated through a simpler
send API.

## Presentation contract

Messages contain no universal header or footer. Native reply threads provide
task context. The first message for a task includes its deterministic object
emoji, title, and Codex URI; subsequent messages remain content-first.

Projects and tasks use deterministic object emoji identities. State indicators
also include readable text. Project/task directories preserve status, recency,
queue depth, and request previews. Long history responses disclose when older
turns remain.

Markdown source is the canonical fallback, while the bridge compiles the
supported subset into native rich text. Polls are enhancements, not the only
place important context appears.

## Failure behavior

- Helper or watch loss: mark not ready, retain pending work, and retry the
  authenticated connection.
- Shared backend loss: retain the job, send at most one actionable notice, and
  resume after supervision recovers.
- Busy task: retain the job without starting a competing turn.
- Invalid chat/helper identity: stop before consuming or sending messages.
- Expired selection: clear only that selection and refresh navigation.
- Terminal run failure: reset one-shot listen state and expose retry/dismiss.
- Shutdown: stop watching before closing helper IPC; do not block Codex Desktop.

## Verification gate

Before installation or upgrade:

```bash
pnpm test
pnpm typecheck
git diff --check
```

A release also requires a live test from the dedicated Messages identity:
directory poll, task selection, native reply routing, unthreaded routing,
task-scoped command picker, rich text, poll vote, attachment, cancellation,
restart recovery, helper reconnect, and Codex Desktop use during service work.
