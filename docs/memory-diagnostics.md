# Memory Diagnostics and Runtime Lifecycle

> Slice: S26 — Memory Budget & Automatic Runtime Hibernation
> Status: Complete
> Last updated: 2026-07-30

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

A later development Renderer reached about 7.0 GiB RSS, about 6.9 GiB private anonymous memory and roughly 35,000 `PartitionAlloc` mappings. V8 was only about 358 MiB before collection. A Chromium GC/JavaScript purge reduced V8 to about 93 MiB but paged swapped native allocator regions back in, raised RSS again and was followed by a full development-instance restart. Forced GC/purge must therefore not be used for live containment or release acceptance.

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

The same AppImage scenario was run twice. The second run is bound to the durable implementation commit:

```text
981282e2c5649dd3e976721ab81b697abdc4c1ac
```

AppImage SHA-256 for both runs:

```text
b8f489e1f05fd9c300c9f10af85f3a9fcd79ad6681bcc37ff49ab173d8309da0
```

Evidence:

```text
release/evidence/2026-07-27T17-24-06-418Z-e2aeb73cea10/report.json
release/evidence/2026-07-27T17-31-22-250Z-981282e2c564/report.json
```

Both diagnostic runs came from an isolated clean worktree while unrelated canonical work was still in progress. Both passed all 18 verifier steps, but neither replaced a canonical release acceptance run.

The final canonical P2/S26 acceptance is commit `152a9a3a0725736c918cc92c8666b84037f5b3c6`. It passed the expanded 19-step AppImage verifier, including real five-minute automatic Runtime hibernation, explicit reactivation, conversation preservation and enforced memory budgets.

```text
release/evidence/2026-07-29T18-48-57-827Z-152a9a3a0725/report.json
```

Final AppImage SHA-256:

```text
114a7040a20cd21dd89dfe3de181334ef36d2d9698324ed3da76f0b8efd4e417
```

### 3.1 Process and state samples

| Sample | Total PSS | Renderer PSS | Top-level Pi | Pi PSS | Nested Pi | Nested Pi PSS | Full state events | Patch events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Single Runtime ready | 729–732 MiB | 70 MiB | 1 | 230–239 MiB | 0 | 0 | 1 | 1 |
| Tool turn settled | 920–925 MiB | 87–88 MiB | 1 | 400–404 MiB | 0 | 0 | 41 | 19–21 |
| Reopened Runtime ready | 727–744 MiB | 72–74 MiB | 1 | 230–242 MiB | 0 | 0 | 2 | 1 |
| Two Project Runtimes ready | 967–980 MiB | 80–82 MiB | 2 | 461–473 MiB | 0 | 0 | 6 | 2 |
| Three Session Runtimes ready | 1,375–1,378 MiB | 90–93 MiB | 3 | 858–859 MiB | 0 | 0 | 17–18 | 14–15 |
| Three Subagents running | 2,334–2,486 MiB | 128–131 MiB | 3 | 1,015–1,021 MiB | 3 | 787–948 MiB | 251–280 | 26–27 |
| Three Subagents completed | 1,245–1,252 MiB | 103–105 MiB | 3 | 749–755 MiB | 0 | 0 | 305–317 | 31–33 |
| Before final close | 1,255–1,261 MiB | 111–114 MiB | 3 | 749–755 MiB | 0 | 0 | 305–317 | 31–33 |

The isolated Conversation was intentionally small:

- maximum complete KernelState JSON: 37,432 bytes;
- Renderer V8 heap maximum: about 12.3 MiB;
- Renderer PSS maximum: about 131 MiB.

### 3.2 Full-state amplification

Across the repeated approximately 80-second three-Subagent step, the Renderer received:

- 305–317 complete `kernel.state-changed` events;
- 31–33 `kernel.state-patched` events;
- 9 inserted entries in the first run;
- about 1,433 appended text/output characters in the first run;
- about 1,394 characters in inserted payloads in the first run.

The update stream therefore copied complete state hundreds of times to communicate only a few KiB of new textual payload plus participant/status metadata.

The real working Session measured earlier had a complete KernelState of about 936 KiB. At that size, 317 complete events represent about 297 MiB of one-way Renderer payload in 80 seconds. This excludes:

1. `WorkbenchKernel.getState()` deep copies in Main;
2. Electron structured clone and Chromium IPC/native buffers;
3. many mutating `ipcRenderer.invoke()` results that return a second complete KernelState after an event already published the update;
4. temporary React projection/grouping objects.

If sustained, the same event rate produces tens of GiB of allocation churn over a multi-hour run even though the live logical state remains below 1 MiB. Chromium retaining super-pages in `PartitionAlloc` is consistent with the observed 5 GiB Renderer failure.

## 4. Source-path findings

### 4.1 Runtime retention

`WorkbenchKernel` retains a complete `KernelState` inside every warm managed `RuntimeContext`; inactive contexts continue receiving and projecting Runtime events until reclaimed. Automatic hibernation now uses a five-minute grace period, strict quiescence lease and a one-background-Runtime warm target, while busy, provisional, foreground and unknown-quiescence contexts remain protected.

Process count remains the dominant steady-state cost while contexts are warm:

```text
visited/running Session count
  × Pi Runtime baseline
  + nested Agent/Extension processes
  + retained RuntimeContext Conversation state
```

### 4.2 State transport containment

Mutating commands now return narrow revision acknowledgements rather than a second complete `KernelState`, and identity-safe metadata patches cover the high-frequency tool/Subagent path. Remaining consecutive state events previously still crossed Main→Renderer as separate Electron messages, so Renderer-side RAF merging could not prevent their structured-clone/native allocation cost.

Main now coalesces only consecutive state events into an 8ms, maximum-64-member envelope. A newer full state supersedes older pending state work, later patches retain revision order, and domain events flush the queue as ordering barriers. Active stderr diagnostics publish a narrow runtime patch instead of copying the full Conversation. Renderer expands each envelope through the existing revision barrier and snapshot-resync path.

This is bounded Main send-side containment, not byte-level backpressure after Electron accepts a message. The final P2 gate now enforces bounded Renderer/native measurements over the release workflow and verifies that total process-tree PSS falls after parallel work and again after one background Runtime is reclaimed. A separate 30-minute settled-slope stress test remains deferred unless a real regression requires it.

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
2. Replace duplicate mutating invoke state returns with typed acknowledgements. **Complete.**
3. Add identity/revision-safe metadata patches so Subagent/tool status updates do not fall back to complete state. **Complete for the high-frequency paths.**
4. Bound and coalesce Main→Renderer event delivery. **Complete for the Main pre-send queue: 8ms / 64 state events with full-state supersession and revision resync.**
5. Keep the single-Runtime stop/recovery primitive inside Main/Kernel only; do not expose Session, Project or all-idle hibernation as a user action. **Complete.**
6. Define Kernel and Extension operation leases; unknown quiescence fails closed. **Complete for current bundled/managed providers.**
7. Enable conservative automatic hibernation only for persisted, inactive, non-busy, non-provisional, lease-free Runtimes. **Complete and verified in the final AppImage gate.**
8. Split or page additional inactive Renderer state only if later evidence shows the bounded current projection is again a dominant retained-memory source. **Deferred; not required by the completed P2 budget.**
9. Measure additional standalone Extension combinations only when those products enter a release scope or trigger a real budget regression. **Deferred.**

## 7. P2 release budgets

The final `--memory-diagnostics` gate enforces these redlines:

| Metric | Release limit | Final observed maximum/result |
| --- | ---: | ---: |
| Whole AppImage process-tree PSS | ≤ 4 GiB | 2,687,216,640 bytes |
| Renderer PSS | ≤ 512 MiB | 164,363,264 bytes |
| Renderer V8 heap used | ≤ 128 MiB | 27,195,464 bytes |
| Complete Renderer KernelState JSON | ≤ 2 MiB | 100,568 bytes |
| Renderer full-state events in the scenario | ≤ 256 | 109 |
| Swap across sampled process tree | 0 | 0 |
| Settled PSS after parallel work | ≤ 80% of busy peak | 1,662,782,464 / 2,687,216,640 bytes, about 61.9% |
| Reactivated three-Runtime PSS | ≤ 3 GiB | 1,575,842,816 bytes |
| Main state envelope size | ≤ 64 members | 5 |

The Runtime lifecycle result was:

```text
3 materialized Runtime processes
→ real five-minute grace + automatic sweep
→ 2 Runtime processes / 1,304,407,040 bytes total PSS
→ explicit “恢复对话”
→ 3 Runtime processes / 1,575,842,816 bytes total PSS
```

The reactivated conversation retained its user and assistant entries. Busy, foreground, provisional, pending ask/queue, compaction, active lease and unknown-quiescence exclusions are covered by deterministic core tests; the verifier does not shorten the production grace or fake Kernel time.

Continuous 20-Session browsing, three simultaneously busy parent Runtimes, pressure-triggered reclaim and a 30-minute settled-slope run are intentionally not claimed. Under KISS/YAGNI they are follow-up stress scenarios, not P2 completion requirements, unless later evidence reopens them.

## 8. Diagnostic safety

Electron 43.1.1 in this project fatally traps a Renderer if CDP `Memory.prepareForLeakDetection` is called without Chromium `--js-flags=--expose-gc`. Diagnostics must not call it. `Runtime.getHeapUsage` and `Memory.getDOMCounters` are the safe read-only probes. Although `HeapProfiler.collectGarbage` and `Memory.forciblyPurgeJavaScriptMemory` were non-fatal in isolated probing, using them on a live multi-GiB Renderer paged native allocator memory back in and preceded a full development-instance restart; they must not be used for containment or release gates.

The normal diagnostic command is:

```bash
pnpm verify:linux -- --memory-diagnostics
```

It remains subject to clean-worktree, real-AppImage, isolated-XDG, single-verifier and redaction rules.
