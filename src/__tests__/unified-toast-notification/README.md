# unified-toast-notification

This BDD topic pins topic-15: a unified toast notification infrastructure that replaces user-visible `window.alert()` call sites while keeping existing IPC envelopes and design-token rules intact.

Behavior contract checklist T1-T12:

T1 `NotificationsProvider` queues notifications, supports `dismiss(id)`, and clears per-notification timers;
T1b provider registration is epoch-guarded so an old unmount cannot clear a newer provider handle;
T2 public `notify.error/warn/info/success` helpers forward to the shared notification API with `warn -> warning`;
T3 notification calls mirror to `console.error/warn/log` by default;
T3b `mirror:false` suppresses console mirroring;
T3c calling the public API before a provider mounts does not throw, mirrors to console, and does not buffer stale messages;
T4 `info/warning/success` auto-dismiss after 5000ms and `error` auto-dismisses after 15000ms;
T5 `info/warning/success` de-duplicate matching `code+message` within 1000ms, while `error` never de-duplicates;
T9 `ERROR_CODES` exposes 34 unique keys: 27 main codes plus 7 fs codes;
T9b migrated source files no longer contain raw business-code string literals in throw sites or renderer `r.code === 'X'` comparisons;
T-FS-IO unknown node errno values still map to `FS_ERROR_CODES.FS_IO`;
T10 business source contains no direct `alert(...)` calls;
T10b a TypeScript compiler-API scan finds no `CallExpression` named `alert` in business source;
T11 `Toast.tsx` uses design tokens rather than default Tailwind colors or hex literals;
T11b `Toast.css` contains no naked hex/rgb color literals;
T12 rendering `<NotificationsProvider><ToastViewport /></NotificationsProvider>` and calling `notify.error()` shows a status toast with the message and code.

Key invariants:

- `src/styles/nous-tokens.css` and `electron/shared/ipc-result.ts` are not modified by this topic.
- Toast lives under `src/notifications/`, not `src/design/`, until it is generalized and pushed upstream.
- There is no main → renderer push channel: the `notify:push` infrastructure (T6–T8: `pushNotification`, `NotifyIpcBridge`, `coApi.notify.onPush`) never had a production sender and was removed. Main-side failures reach the user through each IPC's own result, which the renderer turns into a toast.
- Existing adjacent `console.warn` lines are preserved during alert收编; those toast calls use `mirror:false` to avoid double logging.
