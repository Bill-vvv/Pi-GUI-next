# pi-gui-multi-advisor

`pi-gui-multi-advisor` is a standalone Pi Coding Agent extension providing a
configurable roster of independent advisors. Version 0.2.0 implements the
S18-3 protocol and works without Pi GUI.

## Install

Install from a local package source:

```sh
pi install /absolute/path/to/extensions/pi-gui-multi-advisor
```

For manual loading, copy this directory to a stable location and add that local
package source to Pi's `packages` setting. The package declares
`src/index.ts` through `pi.extensions`; do not copy only the entry file.

The advisor system is **disabled by default**. Enable, disable, or inspect it in
an interactive Pi session:

```text
/advisor on
/advisor off
/advisor status
```

The sole enabled-state fact is the strict versioned JSON file
`${PI_CODING_AGENT_DIR || ~/.pi/agent}/pi-gui-multi-advisor.json`. A missing
file means disabled. Malformed, unknown-version, or extra-field content is an
error. Saving uses a temporary file in the same fixed directory followed by
atomic rename; a failed save does not change live state.

## WATCHDOG discovery

At session start the extension loads `WATCHDOG.yml`, `WATCHDOG.yaml`, and
`WATCHDOG.md` from the Pi agent directory, then from the Git root (or home
directory) through every ancestor to the current working directory. At each
layer the root is read before `.omp`. Project-level files are ignored when Pi
reports that the Project is not trusted. Later advisors with the same derived slug
replace the whole earlier advisor; shared YAML `instructions` and
`WATCHDOG.md` content are concatenated in discovery order.

Advisor names are slugged by lowercasing, collapsing non-alphanumeric runs to
hyphens, and trimming hyphens; an empty result becomes `advisor`. Invalid files
are reported and skipped. Instruction text supports bounded `@relative/path`
and `@~/path` imports. Imports inside fenced or inline code stay literal;
missing imports stay literal and cycles are skipped.

Each enabled advisor has an independent runtime, one-item review queue, and
emission guard. `model: null` or `model: primary` follows the primary model;
`provider/model` selects that exact catalog entry; a bare model id uses the
primary model's provider. `thinking: null` follows Pi's current thinking level.
The built-in `Default Advisor` is the first roster layer:
`gpt-5.6-sol`, `medium`, and `read`, `grep`, `find`, `ls`. A later definition
named `Default Advisor` can replace or disable it.

Allowed tools are only `read`, `grep`, `find`, `ls`, `edit`, and `write`.
Omitted or empty `tools` defaults to the four read-only tools. `edit` and
`write` are granted only when explicitly listed. Unknown names, including
`bash`, are diagnosed and discarded. Protocol v2 advertises the multi-advisor roster, optional write tools, and
real-time usage telemetry; `/advisor status` shows the roster summary. Every
review publishes `pi-gui.multi-advisor/usage` on Pi's shared event bus with the
Advisor identity, model, outcome, duration, token/cache totals, reasoning tokens,
and provider-reported cost. The event never contains the reviewed prompt,
messages, advice text, or tool output.
The independent Advisor runtime does not use the primary Agent's approval
wrapper, so explicitly granting `edit` or `write` authorizes direct execution.

## Development

The tests are pure logic tests and never contact a model provider:

```sh
node --test tests/*.test.mjs
```

## License and references

This package is MIT licensed. Its behavior was informed by Oh My Pi at commit
`667111575ebba136dadfd6989379e7f67e0d40d9` and by
`pi-omplike-advisor`. See `THIRD_PARTY_NOTICES`. No upstream source code is
claimed as copied by this implementation.
