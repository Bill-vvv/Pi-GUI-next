# Usage Debug (temporary project extension)

Project-local Pi extension for aggregate observability while debugging
`pi-gui-next`. It auto-loads from `.pi/extensions/usage-debug/index.ts` after the
Project is trusted.

## Activate

Use `/reload` in an existing Pi Session, or start/reload the Session from Pi GUI.
No global `settings.json` change or package installation is required.

## Inspect

- Ask the agent to call `usage_debug` with `action: "status"` (works in Pi GUI
  because the result is a normal tool result).
- In the TUI, run `/usage-debug status`.
- `/usage-debug path` returns the aggregate JSONL path.
- `/usage-debug reset` clears only this extension's current temporary state and
  log.

The footer status is intentionally compact:

```text
dbg · ctx 42% · sub 1/3 · 18.2k tok · adv 2
```

## What is measured

- Parent assistant response input/output/cache tokens and cost when Pi exposes
  usage on the assistant message.
- `pi-subagents` tool invocations, launches, completions, active run ids, and
  exact child usage/cost when the public result/event payload includes it.
- Advisor enabled turn cycles, emitted advisory messages, review outcomes,
  token/cache totals, reasoning turns, and provider-reported cost from
  `pi-gui.multi-advisor/usage`.
- Magic Context-owned tool calls (`ctx_*`, plus dynamically attributed tools
  such as `todowrite`), failures, duration, current/max Pi context pressure, and
  historian/dreamer/sidekick token/cache/cost usage from
  `magic-context:subagent-usage`.

## Deliberate limits

- Cost remains `n/a or zero` when the selected provider does not expose pricing;
  the monitor never estimates prices from a model name.
- Logs contain aggregate counters only. Prompts, tool arguments, tool output,
  file paths, child transcripts, credentials, and provider headers are never
  recorded.
- State and JSONL logs live under the OS temporary directory with user-only
  permissions. They are not committed and may be removed by normal temp cleanup.

## Remove

Delete `.pi/extensions/usage-debug/` and run `/reload`. Temporary log files can
then be deleted from the path shown by `/usage-debug path`.
