# Memory Diagnostics and Runtime Lifecycle

> Slice: S26 — Memory Budget & Runtime Hibernation  
> Status: In Progress  
> Last updated: 2026-07-28

## 1. Purpose and evidence levels

This document separates three kinds of evidence:

- **verified_current live evidence**: measurements from the currently running development app and its real Main/Renderer/Pi process tree;
- **isolated AppImage diagnostic evidence**: a clean detached source commit packaged and exercised by the existing 18-step Linux verifier with memory diagnostics enabled;
- **local_source_snapshot**: code-path findings that explain where state is retained or copied, but are not by themselves runtime retained-size proof.

The diagnostic output contains process roles, lifecycle status, counts, byte sizes and durations only. It must not contain Project/Session identity, paths, command lines, prompt/output text, tool content, credentials or private Extension state.

## 2. Live failure and restart observations

### 2.1 Long-running failure

A development run lasting about 1 hour 52 minutes reached:

- Renderer RSS: about 5.4 GiB;
- Renderer private anonymous Chromium `PartitionAlloc`: about 4.98 GiB;
- `PartitionAlloc` mappings: about 21,762;
- Electron Main RSS: about 372 MiB / PSS about 225 MiB;
- direct Pi Runtime processes: 10, commonly about 280–500 MiB PSS each.

The active Session JSONL was about 400 KiB and the largest Session JSONL was about 8 MiB. Raw transcript volume therefore could not explain the Renderer footprint.

### 2.2 Restarted real-workload app

In a later run, the app accumulated 11–12 top-level Pi Runtime processes within about 13 minutes. A seven-sample, 30-second `/proc/*/smaps_rollup` window observed:

| Role | Observed PSS |
| --- | ---: |
| Whole app process tree | 5.62–6.12 GiB |
| 11–12 top-level Pi Runtime processes | 3.39–3.83 GiB |
| 4–5 nested Pi child processes | 0.87–1.27 GiB |
| Renderer | 520 → 593 MiB in 30 seconds |
| Electron Main | about 256 MiB at the end of the window |

At the end of that window, the Renderer mapping breakdown was approximately:

| Mapping class | PSS |
| --- | ---: |
| `[anon:partition_alloc]` | 365 MiB |
| `[anon:v8]` | 77 MiB |
| `[anon:v8-sandbox]` | 76 MiB |
| Electron executable/file mappings | 46 MiB |

`PartitionAlloc` already had 1,726 mappings. Most mappings formed roughly 2 MiB super-page regions plus small guard/metadata mappings. The earlier 5 GiB failure had more than twelve times as many mappings.

## 3. Isolated AppImage diagnostic gate

Diagnostic source commit:

```text
e2aeb73cea10d67994d69497935ecc86471f466f
```

AppImage SHA-256:

```text
b8f489e1f05fd9c300c9f10af85f3a9fcd79ad6681bcc37ff49ab173d8309da0
```

Evidence:

```text
release/evidence/2026-07-27T17-24-06-418Z-e2aeb73cea10/report.json
```

This was a diagnostic run from an isolated clean worktree while unrelated canonical work was still in progress. It passed all 18 verifier steps, but it is **not** a replacement for a canonical release acceptance run.

### 3.1 Process and state samples

| Sample | Total PSS | Renderer PSS | Top-level Pi | Pi PSS | Nested Pi | Nested Pi PSS | Full state events | Patch events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Single Runtime ready | 729 MiB | 70 MiB | 1 | 230 MiB | 0 | 0 | 1 | 1 |
| Tool turn settled | 925 MiB | 88 MiB | 1 | 400 MiB | 0 | 0 | 41 | 19 |
| Reopened Runtime ready | 727 MiB | 72 MiB | 1 | 230 MiB | 0 | 0 | 2 | 1 |
| Two Project Runtimes ready | 967 MiB | 82 MiB | 2 | 461 MiB | 0 | 0 | 6 | 2 |
| Three Session Runtimes ready | 1,378 MiB | 93 MiB | 3 | 859 MiB | 0 | 0 | 17 | 15 |
| Three Subagents running | 2,334 MiB | 131 MiB | 3 | 1,021 MiB | 3 | 787 MiB | 280 | 27 |
| Three Subagents completed | 1,252 MiB | 105 MiB | 3 | 755 MiB | 0 | 0 | 317 | 33 |
| Before final close | 1,261 MiB | 114 MiB | 3 | 755 MiB | 0 | 0 | 317 | 33 |

The isolated Conversation was intentionally small:

- maximum complete KernelState JSON: 37,432 bytes;
- Renderer V8 heap maximum: about 12.3 MiB;
- Renderer PSS maximum: about 131 MiB.

### 3.2 Full-state amplification

During the approximately 80-second three-Subagent step, the Renderer received:

- 317 complete `kernel.state-changed` events;
- 33 `kernel.state-patched` events;
- 9 inserted entries;
- about 1,433 appended text/output characters;
- about 1,394 characters in inserted payloads.

The update stream therefore copied complete state hundreds of times to communicate only a few KiB of new textual payload plus participant/status metadata.

The real working Session measured earlier had a complete KernelState of about 936 KiB. At that size, 317 complete events represent about 297 MiB of one-way Renderer payload in 80 seconds. This excludes:

1. `WorkbenchKernel.getState()` deep copies in Main;
2. Electron structured clone and Chromium IPC/native buffers;
3. many mutating `ipcRenderer.invoke()` results that return a second complete KernelState after an event already published the update;
4. temporary React projection/grouping objects.

If sustained, the same event rate produces tens of GiB of allocation churn over a multi-hour run even though the live logical state remains below 1 MiB. Chromium retaining super-pages in `PartitionAlloc` is consistent with the observed 5 GiB Renderer failure.

## 4. Source-path findings

### 4.1 Runtime retention

`WorkbenchKernel` retains a complete `KernelState` inside every managed `RuntimeContext`. Inactive contexts continue receiving and projecting Runtime events. There is no idle eviction; contexts are removed only by explicit stop/cleanup paths such as archive, reload, failed launch cleanup or app shutdown.

This makes process count the dominant current steady-state cost:

```text
visited/running Session count
  × Pi Runtime baseline
  + nested Agent/Extension processes
  + retained RuntimeContext Conversation state
```

### 4.2 Duplicate complete state transport

Many mutating commands both:

1. publish `kernel.state-changed` or `kernel.state-patched`; and
2. return another `kernel.getState()` through the invoke result.

The Renderer may logically ignore a stale invoke result after an event revision changes, but both deep copy and IPC structured clone have already happened.

### 4.3 Metadata-only updates fall back to complete state

`createConversationEntryPatch()` currently supports only:

- entry insertion;
- message text suffix append;
- thinking text suffix append;
- tool output suffix append.

A tool/subagent status, participant, token, duration, current-tool or final-output metadata change with no tool-output growth returns `null`. `handlePiEvent()` then calls `emitState()`. This is the primary source-level explanation for hundreds of complete states during a parallel Subagent run.

### 4.4 DOM mounting is not the main failure

The real working Renderer had about 520 DOM nodes, about 3 KiB visible body text and about 58 MiB JS heap while its working set was about 755 MiB. Timeline currently limits mounted completed turns, but the full `conversation.entries` array remains in Renderer state and is regrouped on updates. DOM virtualization alone cannot solve native IPC allocation or inactive Runtime retention.

## 5. Product patterns

The selected policy combines established patterns rather than copying one product literally:

- **Chrome tab discard**: preserve tab identity, rank background tabs by importance/recency, discard under pressure and reload on selection; active tabs are protected until necessary.  
  Source: <https://developer.chrome.com/blog/tab-discarding>
- **Jupyter kernel culling**: document persistence and execution kernel lifetime are separate; automatic idle culling is opt-in, with busy and connected kernels protected by default.  
  Source: <https://jupyter-server.readthedocs.io/en/latest/other/full-config.html>
- **VS Code extension hosts**: heavyweight Extension execution is isolated from the UI and shared by host location instead of creating one host per editor.  
  Source: <https://code.visualstudio.com/api/advanced-topics/extension-host>
- **Electron performance guidance**: measure retained objects and process costs continuously, defer work, and avoid blocking or unnecessary module/state loading instead of relying on GC flags.  
  Source: <https://www.electronjs.org/docs/latest/tutorial/performance>

For Pi GUI this becomes: Jupyter-style Session/Runtime separation, Chrome-style foreground protection and conservative LRU, and VS Code-style reuse of shareable Project services.

## 6. Accepted implementation order

1. Keep the opt-in, redacted memory diagnostics in the single official verifier.
2. Replace duplicate mutating invoke state returns with typed acknowledgements.
3. Add identity/revision-safe metadata patches so Subagent/tool status updates do not fall back to complete state.
4. Bound and coalesce Main→Renderer event delivery; overflow causes a targeted reset instead of an unbounded queue.
5. Split Navigation, active Session metadata and active Conversation projections.
6. Add user-explicit Session/Project/all-idle Runtime hibernation.
7. Define Kernel and Extension operation leases; unknown quiescence fails closed.
8. Enable conservative automatic hibernation only for persisted, inactive, non-busy, non-provisional, lease-free Runtimes.
9. Page and evict old Timeline data in Renderer.
10. Measure bare Pi, Subagent, Magic Context, Advisor and combined Extension baseline costs, then move excessive fixed cost to lazy initialization in the owning component.

## 7. Provisional budgets

These are investigation targets, not yet release gates:

| Scenario | Initial target |
| --- | ---: |
| AppImage + one ready Runtime | ≤ 1.0 GiB PSS |
| Electron shell without Pi Runtime | ≤ 500 MiB PSS |
| Renderer settled | ≤ 300 MiB PSS |
| Renderer 30-minute settled slope | ≤ 2 MiB/min after warm-up |
| Default warm Runtime set | foreground + most recent quiescent Runtime |
| Automatic hibernation grace period | initially 5 minutes, subject to evidence |
| Busy/provisional/unknown-quiescence Runtime | never automatically hibernated |

Parallel busy work is allowed to exceed the steady-state budget. The required behavior is that memory returns toward the warm-set budget after work completes and the grace period expires.

## 8. Diagnostic safety

Electron 43.1.1 in this project fatally traps a Renderer if CDP `Memory.prepareForLeakDetection` is called without Chromium `--js-flags=--expose-gc`. Diagnostics must not call it. `Runtime.getHeapUsage`, `Memory.getDOMCounters`, `HeapProfiler.collectGarbage` and `Memory.forciblyPurgeJavaScriptMemory` were non-fatal in this environment, but forced GC/purge is not a product memory policy.

The normal diagnostic command is:

```bash
pnpm verify:linux -- --memory-diagnostics
```

It remains subject to clean-worktree, real-AppImage, isolated-XDG, single-verifier and redaction rules.
