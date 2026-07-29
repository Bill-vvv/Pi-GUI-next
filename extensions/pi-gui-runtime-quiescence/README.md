# pi-gui-runtime-quiescence

App-owned Pi extension loaded by Pi GUI for every managed Pi RPC Runtime.

It registers an **internal** slash command used only by Main `RuntimeHost.queryQuiescence()`:

```text
/pi-gui-runtime-quiescence <nonce>
```

The command replies through `extension_ui_request` / `setStatus` with a versioned JSON payload on status key `pi-gui.runtime-quiescence`. RuntimeHost correlates the caller nonce, swallows the event so it does not enter GUI conversation state, and does not rely on Session transcript writes.

## Providers

- **Pi core**: `ctx.isIdle()` and `ctx.hasPendingMessages()`
- **pi-subagents**: a registered event-bus provider is authoritative when present. Older builds without the provider use the diagnostic `subagents:rpc:v1` adapter; unsupported or drifted fleet text remains blocking `unknown`.
- **Registered event-bus providers**: extensions declare IDs on `pi-gui.runtime-quiescence/provider-register/v1`. Each QUERY snapshots the roster, emits `pi-gui.runtime-quiescence/provider-query/v1`, and expects a reply on `pi-gui.runtime-quiescence/provider-reply/v1:<requestId>`. Missing, late, or invalid replies become `unknown` for that provider id. Registered providers suppress stale compatibility diagnostics for the same exact provider ID.
- **Magic Context**: a registered provider is queried normally. Source/name discovery becomes a blocking not-adopted report only when Magic Context is loaded without that provider. Reasons never include filesystem paths.
- **Unregistered extension sentinel**: any discoverable non-builtin tool/command extension surface from `getAllTools` / `getCommands`—including SDK custom tools—that is not the app-owned internal quiescence command and not a known/adopted provider (pi-subagents, Magic Context, Multi Advisor markers, or an exact registered provider source/path segment) emits **one** generic blocking provider id `unregistered-extension` with a bounded count-only reason. Arbitrary source/tool names never become provider IDs.
- **Privacy boundary**: provider IDs use a narrow token grammar, provider reasons may not contain path separators, and discovery/query exceptions become fixed reason tokens. Raw filesystem paths and exception messages are never serialized into the status payload.
- **Discovery sentinels**: tool/command API throw, missing required API, or invalid discovery emit explicit blocking `unknown` sentinel provider ids (`tool-discovery`, `command-discovery`). Event-bus unavailability emits `event-bus`.

## Generation-fenced lease coordinator core

`src/lease-coordinator.mjs` now provides a pure, deterministic coordinator for one app-owned Runtime generation. The generation is the existing Main process-lifetime opaque `runtimeId`; the core does not create a parallel generation counter or UUID. It owns only bounded/redacted owner registration, exact work-holder admission, and the `open → draining → prepared → committed` prepare lease state machine.

The coordinator owns every work, prepare, and hibernation token. Callers admit work with only `runtimeId + ownerId + workId`; a successful admission (including an active duplicate) returns the exact coordinator-generated work token required by later commit checks and release. Re-admitting the same work identity after release creates a new holder token, so a delayed old release cannot remove it.

Every token combines a coordinator-internal, generation-local monotonic safe-integer sequence with a bounded `tokenFactory` suffix. The suffix supplies opacity only, not uniqueness: even a factory that always repeats the same valid suffix cannot recreate a token within the Runtime generation. Invalid suffixes and sequence exhaustion fail closed without changing lease or holder state.

The coordinator freezes new work admission and owner-roster changes in `draining`, while exact duplicate owner registration remains idempotent. Already-admitted holders may perform exact commit checks and release. An exact loaded-inventory roster/hash/request/deadline match is required before producing a hibernation token, and the fence remains committed until an exact stop-failure release. Wrong or stale tokens never mutate state. Duplicate begin/complete/commit and an exact duplicate release are idempotent; a released old token cannot reopen or alter a newer prepare.

This deterministic coordinator remains a pure protocol-core test surface and is not imported by `src/index.ts`. The production path uses the hidden provider lease command described below; WorkbenchKernel owns candidate selection and stop authority.

## Hibernate / automatic eviction boundary

QUERY remains diagnostic-only and is not hibernate authority. The hidden lease command uses the exact loaded Extension inventory, generation-fenced provider prepare/commit/release, and Kernel-owned busy gates before Main may stop a Runtime. Any missing provider, malformed reply, timeout, identity mismatch, or rollback failure skips reclamation.

Persisted `pi-subagents` deployments that registered their owner fence with `getSessionFile()` are handled by a bounded compatibility handshake: canonical `sessionId` is attempted first; only that provider may retry with the current Session file identity, and commit/release stay bound to the identity that prepared. No busy or admission fence is bypassed.

QUERY blockers include:

- registered providers that replied busy/unknown
- registered providers with missing/late/invalid replies
- Magic Context while it remains not adopted
- tool-discovery, command-discovery, and event-bus sentinels
- the generic `unregistered-extension` sentinel for discoverable non-builtin surfaces without a known/adopted provider
- **any extension activity the QUERY surface cannot observe** — the lease inventory still fails closed before stop

Unknown/unregistered extension activity must fail closed: never assume idle.
