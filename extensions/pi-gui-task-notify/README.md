# pi-gui-task-notify

A small Pi Coding Agent extension that sends a Linux desktop notification after
an interactive task reaches `agent_settled`.

When loaded by pi-gui-next, the extension uses the GUI's private local broker.
Clicking the notification validates and activates the exact registered Project
and Session, restores the window when minimized, and focuses it. In Pi TUI or
when the broker is unavailable, it falls back to a normal `notify-send`
notification without a GUI jump action.

## Install

Install from this repository as a local Pi package:

```sh
pi install /absolute/path/to/extensions/pi-gui-task-notify
```

Package or Extension setting changes apply after opening a new Session or
reloading an existing Session.

## Usage

Notifications are automatic. Test the current environment with:

```text
/task-notify-test
```

The extension never includes Assistant response text in the desktop
notification. It displays only the Pi label, Session/Project name, completion
state, and elapsed time.

## Protocol and security

pi-gui-next injects a private Unix-domain socket path and a random capability
token into each Pi RPC child. Requests are bounded, schema-checked, and sent as
one JSON line. Electron Main owns `notify-send`; no command string, URL, or
shell interpolation is accepted from the extension. Clicking can activate only
a canonical, registered, non-archived Session after Main revalidates it.

The socket lives below the user's runtime directory, its directory is mode
`0700`, and the socket is mode `0600`. The broker is closed before Kernel
shutdown.

## Requirements

- Linux desktop notification service
- `notify-send` from libnotify
- Pi Coding Agent 0.80.x
- pi-gui-next for exact conversation activation
