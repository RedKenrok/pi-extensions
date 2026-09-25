# pi-notify

`pi-notify` is a Pi extension that notifies you when an interactive run has fully settled and Pi is ready for input.

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

For project-local installation, add `--local` to `pi install`. For development, symlink `packages/notify` into `~/.pi/agent/extensions/` and run `/reload`.

## Behavior

The notification title includes the basename of the current working directory. Its body includes the Pi session name (or “Thread”), the first eight characters of the session ID, and “Ready for input.” This helps distinguish threads in the same workspace. Notification labels are shortened and sanitized before delivery.

The extension listens for `agent_settled`, not `agent_end`, so it waits until retries and queued work finish. It notifies only in interactive TUI mode with a TTY on standard output. It uses OSC 99 for Kitty, a PowerShell toast for Windows Terminal/WSL, and OSC 777 otherwise (for terminals such as Ghostty, iTerm2, WezTerm, and rxvt-unicode). Support for OSC 777 depends on the terminal. No notification is sent in print, JSON, or RPC mode.

Kitty notifications use unique IDs; Kitty's default click action focuses the originating window. Other terminals' click behavior is terminal-dependent. The extension does not switch tabs or navigate to a Pi session on click. Delivery is best-effort: synchronous delivery failures do not stop Pi, and PowerShell toasts have a three-second process timeout.

## Security and privacy

The extension makes no network requests and does not send conversation content or credentials. The workspace basename, session name, and short session ID are sent to the terminal or Windows notification system and may remain visible in OS notification history. Avoid sensitive session names if that matters for your setup. Dynamic labels are sanitized to remove terminal controls and Unicode format characters, including bidirectional overrides, before being used in escape sequences or toasts.

## Development

From the repository root, run `npm run lint`, `npm run test`, and `npm run test:coverage`. The tests cover lifecycle and non-interactive behavior, terminal selection and Kitty IDs, label sanitization, and synchronous delivery failures. They do not validate OS-level notification display or click behavior; test those manually in your terminal.
