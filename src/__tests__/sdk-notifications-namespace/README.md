# SDK notifications namespace

Topic 31 adds the plugin-facing `app.notifications.show({ kind, message, code? })` API.

Behavior contract:

- `kind` uses the same source type as `NotificationLevel`.
- Runtime plugin input is guarded: unknown kinds fall back to `info`.
- `code` is forwarded to the existing toast notification system when present.
- v1 intentionally has no per-plugin rate limit because Continuo currently uses a trusted manual-install plugin model.
- Scoped plugin apps expose a wrapped `notifications` namespace so future policy hooks can live in `scoped-app.ts`.
