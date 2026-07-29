# pi-gui-ask

A Pi Coding Agent extension that lets the Agent collect several user decisions
inside one `ask` tool call. Questions can be single-choice, multiple-choice, or
free text. The complete answer set is returned as one structured tool result so
the Agent can continue without a long clarification loop.

pi-gui-next renders a matching running `ask` tool as a compact one-question-at-a-time
flow and submits all answers together. Single-choice questions advance automatically;
multiple-choice and free-text questions use an explicit next action. Every choice
question also includes an “Other” path for a user-written answer. Pi TUI and other
RPC clients expose the same custom-answer path through the standard extension UI dialogs.

## Install

Install from this repository as a local Pi package:

```sh
pi install /absolute/path/to/extensions/pi-gui-ask
```

Package changes apply after opening a new Session or reloading an existing
Session.

## Tool input

```json
{
  "questions": [
    {
      "id": "scope",
      "prompt": "Which scope should we implement?",
      "type": "single",
      "options": [
        { "value": "minimal", "label": "Minimal" },
        { "value": "complete", "label": "Complete" }
      ]
    },
    {
      "id": "targets",
      "prompt": "Which targets are required?",
      "type": "multiple",
      "options": [
        { "value": "linux", "label": "Linux" },
        { "value": "macos", "label": "macOS" }
      ]
    },
    {
      "id": "notes",
      "prompt": "Anything else to preserve?",
      "type": "text",
      "placeholder": "Constraints or context"
    }
  ]
}
```

All questions are required. One call supports 1–8 questions and each choice
question supports 2–12 unique fixed options in addition to the built-in custom-answer option.
