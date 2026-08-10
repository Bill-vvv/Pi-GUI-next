# P4 Cross-platform Desktop Plan

> Status: Windows Bootstrap In Progress
> Baseline commit: `d4f524784a8abd91f0e9f5f33066c8f8e65c3f90`
> Last updated: 2026-08-10
> Scope owner: the main Agent remains the integration and acceptance owner

## 1. Goal

P4 brings the existing Linux Pi GUI product to three native desktop targets without splitting it into separate products:

| Platform | Minimum supported system | Architecture | First public artifact |
| --- | --- | --- | --- |
| Linux | Existing Arch/Linux baseline | x64 | AppImage |
| Windows | Windows 11 | x64 | NSIS installer |
| macOS | macOS 14 Sonoma | Apple Silicon arm64 | DMG |

The implementation order is fixed:

1. Windows 11 x64.
2. macOS 14+ arm64.
3. Evaluate WSL only after native Windows is stable and a real need exists.

Windows 10, Windows 32-bit, Windows ARM64, Intel/universal macOS, application stores, automatic updates and WSL are outside the first P4 release.

## 2. Relationship with P3

P3 remains the primary product-function track. P4 advances in parallel through an isolated worktree and stays one accepted P3 checkpoint behind when shared code is changing.

```text
P3 implements and accepts checkpoint N
→ pushes the stable checkpoint
→ P4 synchronizes checkpoint N
→ classifies Windows impact
→ changes or verifies Windows as required
```

Rules:

- The canonical `/home/vvv/Projects/pi-gui-next` worktree remains owned by P3.
- P4 uses an isolated local worktree and branch.
- P4 does not write into a dirty canonical worktree.
- Shared Main, preload, Kernel or Runtime changes are integrated only at an explicit foreground maintenance boundary after the canonical GUI/dev supervisor is stopped and the source-maintenance lock is acquired.
- No unfinished P4 commit enters P3 automatically. The main Agent reviews, integrates and validates it.
- macOS implementation does not begin until the Windows platform boundary is stable; macOS environment preparation may happen earlier.

## 3. Capability ownership

P4 validates complete product capability chains rather than only Renderer files.

### GUI/Electron Host

- Renderer, preload, Electron Main and Kernel.
- Pi process discovery, launch, stop and recovery.
- Project and application-state storage.
- File, path, Git, notification, font and memory integration.
- Native packaging and release gates.

### App-owned Runtime Extensions

The packaged Runtime automatically loads and P4 must validate:

- `pi-gui-ask`
- `pi-gui-history-navigation`
- `pi-gui-openai-fast-mode`
- `pi-gui-runtime-quiescence`
- `pi-gui-task-notify`

Platform-neutral extensions may need no source change, but still require native loading and complete-chain verification. Extensions that use paths, commands, permissions, IPC or native dependencies require platform adaptation.

### Adapted upstream Packages

- `pi-subagents`
- Magic Context

P4 distinguishes GUI adapter defects from upstream Package portability defects. It does not hide an unsupported upstream path with a silent fallback.

`pi-gui-multi-advisor` is retired from the active product surface; P4 only preserves valid historical Session projection. `pi-subagent-workspace-vcs` remains outside the core release gate unless it is separately admitted as a product capability.

## 4. External dependency policy

Linux, Windows and macOS all use user-installed Pi, Node and Git. AppImage, NSIS and DMG do not bundle a second Pi Runtime, Node installation or Git distribution.

Dependency discovery is fail-fast:

1. Validate a saved explicit executable path.
2. If no explicit path is saved, probe the current process `PATH`.
3. If unresolved, show dependency setup and let the user select the executable explicitly.
4. Main validates the selected ordinary file and the exact supported Pi version.
5. Persist the platform-local path.
6. If a saved path becomes invalid, report the real error and do not silently select another installation.

Executable paths, Project absolute paths, application directories, process identities, notification endpoints and credentials are device-local data.

### Windows Runtime process ownership

The first Windows Runtime path uses this fail-fast lifecycle contract:

1. Spawn the Pi RPC process with `detached: false` and `windowsHide: true`.
2. Close RPC stdin first and allow a bounded grace period for Pi to exit normally.
3. If the process remains alive, report `E_WINDOWS_RUNTIME_TREE_OWNER_REQUIRED` and retain the Runtime identity instead of claiming that killing a command shim cleaned its descendants.
4. Do not use `taskkill`, PID-tree enumeration or repeated direct-process signals as the release solution.
5. Before Windows public release, introduce a Windows Job Object-backed launcher/owner that owns the Pi process before it can create descendants and terminates the complete owned job on forced shutdown.

The internal Windows bootstrap may validate the normal stdin-close path, but P4-W1 cannot be accepted until forced cleanup and the no-residual-process gate are proven on Windows.

### Windows ProjectStore directories

The GUI-owned ProjectStore uses this Windows layout:

```text
%LOCALAPPDATA%\pi-gui-next\config.json
%LOCALAPPDATA%\pi-gui-next\state.json
%LOCALAPPDATA%\pi-gui-next\tasks.json
%LOCALAPPDATA%\pi-gui-next\restart-continuations.json
%LOCALAPPDATA%\pi-gui-next\tasks\...
```

Rules:

- `LOCALAPPDATA` must be present as an exact absolute local-drive Windows path; missing, relative, UNC or malformed values fail startup clearly.
- Roaming `%APPDATA%` is intentionally not used because Project paths, active Session identity, Task workspaces and GUI settings are device-local under the current product boundary.
- Linux retains the existing XDG config/state locations with no migration or path change.
- Pi-owned authentication, Package, Extension, Skill, Prompt Template and Session data remain under Pi's own user directory; they are not moved into the GUI ProjectStore.
- Remote access token/device storage remains a separate POSIX-bound capability and is not made Windows-compatible by this change.
- There is no Windows migration path in this batch because no prior Windows release exists.

## 5. Data scope

P4 provides independent local operation on each device. It does not provide cross-device Session or application-state synchronization.

Cross-device synchronization is a desired future capability and must be planned separately, including logical Project identity, transcript conflicts, path mapping, Package/Extension configuration and credential isolation. P4 does not add speculative synchronization abstractions.

## 6. Delivery slices

### P4-W0 — Linux preparation and Windows baseline

- Maintain this plan and capability ledger.
- Identify current Linux bindings.
- Add only platform behavior required by the first real Windows path.
- Run typecheck, build and focused tests on Linux.
- On the Windows machine, install dependencies, clone the same repository, build, package and record the first native failure.

### P4-W1 — Windows core Runtime

- Discover and validate external Pi, Node and Git.
- Open a local Project.
- Start or resume one Pi Session.
- Complete prompt and streaming response.
- Stop the Runtime and exit without residual owned processes.

### P4-W2 — Windows product parity

- Project, Task and multi-Session workflows.
- File and Git workflows.
- App-owned Runtime Extensions.
- `pi-subagents` and Magic Context.
- Notifications, file opening, settings and recovery.

### P4-W3 — Windows internal artifact

- Unsigned Windows 11 x64 NSIS package.
- Installation, upgrade, uninstall and real packaged-app gate.

An unsigned artifact may prove internal adaptation but is not public-release evidence.

### P4-W4 — Windows public release

- Select and configure Windows code signing.
- Verify the signed installer and installed application.

### P4-M1 through P4-M3 — macOS adaptation and release

- Reuse the proven narrow platform boundaries.
- Produce an internal unsigned arm64 app/DMG.
- Add Developer ID signing, Hardened Runtime, notarization and stapling before public release.
- Gate macOS 14 and the latest supported macOS release.

### P4-R — Unified three-platform release

The same version and source commit produce native Linux x64, Windows 11 x64 and macOS 14+ arm64 artifacts. Each artifact is built and verified on its native operating system. Platform-specific proof is not inferred from another platform.

## 7. Evidence vocabulary

Every conclusion must state its evidence level:

- `committed_source`: present in a commit.
- `local_source_snapshot`: present only in an uncommitted or isolated source snapshot.
- `built_artifact`: included in a produced artifact.
- `verified_current`: exercised successfully in the current native environment.
- `released/deployed`: delivered through the intended release path.

Static Linux tests cannot mark Windows behavior `verified_current`.

## 8. Cross-platform capability ledger

Every discovered platform difference remains in this table after it is resolved. A blank cell is not an accepted status.

Status values:

- `identified`
- `planned`
- `local_source_snapshot`
- `committed_source`
- `built_artifact`
- `verified_current`
- `deferred`
- `not-applicable`

| Capability | Owner | Linux state | Windows state | macOS state | Synchronization trigger | Native validation |
| --- | --- | --- | --- | --- | --- | --- |
| Pi executable discovery | Main Runtime | `verified_current`: `pi` in PATH or `~/.local/bin/pi` | `local_source_snapshot`: Linux-tested PATH/PATHEXT ordering plus explicit `.exe`/`.com`/`.bat`/`.cmd` validation; not yet run on Windows | `identified`: PATH and explicit selection; Finder environment must be checked | Pi installation method, supported Pi version or dependency settings change | Resolve the intended installation and reject missing/ambiguous/invalid paths |
| Pi command invocation | Main Runtime and command callers | `verified_current`: canonical direct spawn; `local_source_snapshot`: four Pi child-process entry points use pinned `cross-spawn@7.0.6` and pass Linux tests | `local_source_snapshot`: `.cmd`/`.bat` command-shim execution is delegated to cross-spawn; not yet run on Windows | `planned`: direct executable behavior must be verified | Any Pi command caller, process-launch contract or cross-spawn version changes | Version probe, Runtime RPC, Package commands and provider probe; preserve argument boundaries and `shell: false` at call sites |
| Pi package-root discovery | Main Runtime and Package consumers | `verified_current`: canonical executable resolves to the Pi package `dist/cli.js` path | `local_source_snapshot`: a bounded `--version` probe observes the actual Node entry used by `.cmd`/`.bat`, then verifies the same package manifest, declared `bin.pi`, exact version and root export; not yet run on Windows | `planned` | Pi installation method, package layout or SDK import changes | Resolve and validate the exact package manifest, version, declared command entry and root export without scanning or trusting another global installation |
| Exact Pi version | Main Runtime | `verified_current`: `0.83.0` | `local_source_snapshot`: command-shim entry probing and all direct Pi commands still require exactly `0.83.0`; not yet run on Windows | `planned` | Pi dependency upgrade | Exact version succeeds; every other or malformed version fails clearly |
| Application data directories | Main ProjectStore | `verified_current`: existing XDG config/state locations unchanged | `local_source_snapshot`: config and state use `%LOCALAPPDATA%\pi-gui-next`; an exact absolute local-drive path is required; not yet run on Windows | `identified`: Application Support and platform state directory | Store schema or file-location change | Persist Project/settings/Session/Task state, restart, upgrade and preserve data; Windows must prove no use of roaming `%APPDATA%` |
| Runtime process lifecycle | Main Runtime and Kernel | `verified_current`: stdin close followed by bounded SIGTERM/SIGKILL; `local_source_snapshot`: extracted platform lifecycle boundary preserves this behavior | `local_source_snapshot`: non-detached hidden process, bounded stdin-close shutdown, and explicit `E_WINDOWS_RUNTIME_TREE_OWNER_REQUIRED` when safe forced tree ownership is unavailable; Job Object owner remains required and behavior is not yet run on Windows | `identified`: POSIX behavior still requires native verification | Runtime start, abort, crash, hibernation or shutdown changes | Start, normal close, forced close, crash, restart and app exit with no residual owned process; Windows forced path must prove Job Object ownership |
| Project path safety | Main Project services | `/proc`, symlink and Linux descriptor rules | `identified`: drive, UNC, junction and reparse-point rules | `identified`: symlink and descriptor strategy | Search, trust or filesystem boundary changes | Native race/link/path security probes |
| Git file safety | Main Git service | Linux `O_NOFOLLOW` contract | `identified` | `identified` | Git diff/read/mutation contract changes | Native path and link safety plus real Git workflow |
| Task notification | Extension + Main Broker + Session activation | Unix socket and Linux presenter | `identified`: transport and Windows notification presenter | `identified`: transport and macOS notification presenter | Notification payload, token, identity or click behavior changes | Deliver, click and activate the exact Project/Task/Session |
| System fonts | Electron Main | `fc-list` | `identified` | `identified` | Font settings or enumeration changes | Enumerate, select and render an installed font |
| Process memory evidence | Main diagnostics + release gate | Linux `/proc` metrics | `identified` | `identified` | Runtime ownership or release-budget change | Native metric with explicitly documented semantics |
| App-owned Extensions | Extension + Runtime + GUI adapter | `verified_current` in existing Linux gates | `planned` | `planned` | Extension protocol, packaging or activation change | Packaged loading plus complete capability-chain test |
| `pi-subagents` | Upstream Package + GUI adapter | Existing Linux integration | `planned` | `planned` | Package version or GUI projection change | Install/load/run/project status and native dependency checks |
| Magic Context | Upstream Package + GUI adapter | Existing Linux integration | `planned` | `planned` | Package version, setup/doctor or GUI status change | Setup, doctor, Session loading and persistence |
| Packaging | electron-builder + release scripts | AppImage | `planned`: NSIS x64 | `planned`: DMG arm64 | Electron, builder, native dependency or resource change | Build and exercise the installed native artifact |
| Signing | Release process | Existing Linux release policy | `deferred`: decide before public release | `deferred`: Developer ID required before public release | Release credential or distribution-policy change | Verify the signed/notarized final artifact |

## 9. Change review rule

Every later feature or dependency change checks the ledger and records one outcome for each affected platform:

- `requires-change`: platform code must change.
- `review-only`: no code change, but native verification is required.
- `not-applicable`: the capability does not apply, with a recorded reason.

Code and ledger updates are one completion unit. A platform adaptation is not complete when its implementation location, affected platforms, synchronization trigger or native validation requirement is unknown.
