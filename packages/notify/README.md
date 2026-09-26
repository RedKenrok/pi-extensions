# notify

`notify` is a Pi extension that notifies you when an interactive run has fully settled and Pi is ready for input.

## Requirements and loading

- Node.js 22.19.0 or newer.
- Pi `@earendil-works/pi-coding-agent` `>=0.85.1 <1.0.0`.
- A terminal and operating system that support and allow notifications.

From the repository root:

```sh
pi install ./packages/notify
# One-off loading:
pi -e ./packages/notify
```

For project-local installation, add `--local` to `pi install`. For development, run `npm install` at the repository root, symlink `packages/notify` into `~/.pi/agent/extensions/`, and run `/reload`. The root install links the shared runtime beside the extension so Pi can resolve it through the symlink.

## Behavior

The notification title includes the basename of the current working directory. Its body includes the Pi session name (or “Thread”), the first eight characters of the session ID, and “Ready for input.” This helps distinguish threads in the same workspace. Notification labels are shortened and sanitized before delivery.

The extension listens for `agent_settled`, not `agent_end`, so it waits until retries and queued work finish. It notifies only in interactive TUI mode with a TTY on standard output. No notification is sent in print, JSON, or RPC mode. By default, runs shorter than 10 seconds do not notify; this uses `before_agent_start` as the start of the run (including retries and queued work).

Configure with environment variables before starting Pi:

- `PI_NOTIFY_MIN_RUN_MS`: minimum elapsed run time in milliseconds (default `10000`; `0` notifies on every settle). Invalid values use the default. If no start event was observed, the default filter skips the settle.
- `PI_NOTIFY_METHOD`: `auto` (default), `kitty`, `osc777`, `toast`, or `off`. Explicit methods bypass terminal detection but still require a TUI and stdout TTY. Use `off` to disable notifications.

`auto` selects a PowerShell toast when `WT_SESSION` is set and Pi runs on Windows or inside WSL (`WSL_DISTRO_NAME`); otherwise OSC 99 when `KITTY_WINDOW_ID` is set. Other terminals are not assumed to support notifications. To enable OSC 777 for a terminal that supports it, set `PI_NOTIFY_METHOD=osc777`. An inherited `WT_SESSION` in a remote Linux shell does not select PowerShell.

Kitty notifications use unique IDs; Kitty's default click action focuses the originating window. Other terminals' click behavior is terminal-dependent. The extension does not switch tabs or navigate to a Pi session on click.

Delivery is best-effort: delivery failures never stop Pi. PowerShell toasts have a three-second process timeout, and at most one toast process runs at a time; while one runs, the latest subsequent notification is kept and sent after it exits (even if it fails). Kitty's title and body sequences are combined into one stdout write; an OS-level partial write is still possible.

Escape sequences are written directly to standard output, because Pi (checked through 0.87.1) gives extensions no API for raw terminal output; `ctx.ui.notify` only shows a message inside the TUI. Notifications fire on `agent_settled`, when the TUI is idle, so these writes do not land in the middle of a render.

### tmux and GNU screen

Inside tmux (`TMUX` is set), escape sequences are wrapped in tmux's DCS passthrough. tmux only forwards them when passthrough is enabled:

```tmux
set -g allow-passthrough on
```

Inside GNU screen (`STY` is set, and `TMUX` is not), sequences are wrapped in screen's DCS passthrough. screen ends a passthrough at the first string terminator (ST), so Kitty's OSC 99 is terminated with BEL there, which Kitty also accepts. When tmux runs inside screen, tmux is the multiplexer Pi talks to, so tmux's passthrough is used.

### Diagnostics

Failures are silent by default. Set `PI_EXT_DEBUG` to a comma-separated list of package names (or `*`) that includes `notify` to print one line per failure to standard error, such as `[notify] write_failed`. The reason codes are `write_failed`, `toast_spawn_failed`, and `toast_failed`.

## Security and privacy

The extension makes no network requests and does not send conversation content or credentials. The workspace basename, session name, and short session ID are sent to the terminal or Windows notification system and may remain visible in OS notification history. Avoid sensitive session names if that matters for your setup. Dynamic labels are sanitized to remove terminal controls and Unicode format characters, including bidirectional overrides, before being used in escape sequences or toasts.

## Development

From the repository root, run `npm run lint`, `npm run test`, and `npm run test:coverage`. The tests cover lifecycle and non-interactive behavior, terminal and platform selection, Kitty IDs, tmux passthrough, label sanitization and toast escaping, the queued latest toast, run-duration filtering, delivery failures, and debug diagnostics. They do not validate OS-level notification display or click behavior; test those manually in your terminal.
