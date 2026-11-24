# unified-toast-notification

This BDD topic pins topic-15: a unified toast notification infrastructure that replaces user-visible `window.alert()` call sites while keeping existing IPC envelopes and design-token rules intact.

Behavior contract checklist T1-T12:

T1 `NotificationsProvider` queues notifications, supports `dismiss(id)`, and clears per-notification timers;
T1b provider registration is epoch-guarded so an old unmount cannot clear a newer provider handle;
T2 public `notify.error/warn/info/success` helpers forward to the shared notification API with `warn -> warning`;
T2b notification levels have one source: `electron/shared/notify-channels.ts` `NOTIFY_LEVELS` (the `NotifyLevel` type derives from it) and its `isNotifyLevel` guard accepts every level and rejects anything else (plugin `notifications.show` falls back to `info` through it);
T3 notification calls mirror to `console.error/warn/log` by default;
T3b `mirror:false` suppresses console mirroring;
T3c calling the public API before a provider mounts does not throw, mirrors to console, and does not buffer stale messages;
T4 `info/warning/success` auto-dismiss after 5000ms and `error` auto-dismisses after 15000ms;
T5 (VSCode notifications) a notification with the same `level` + `message` as one still in the list (shown or queued) is merged into it instead of stacking: its count goes up and its auto-dismiss timer restarts (a queued one gets its timer when it becomes visible); this applies to `error` too, and different level or message never merge;
T9 `ERROR_CODES` exposes 34 unique keys: 27 main codes plus 7 fs codes;
T9b migrated source files no longer contain raw business-code string literals in throw sites or renderer `r.code === 'X'` comparisons;
T-FS-IO unknown node errno values still map to `FS_ERROR_CODES.FS_IO`;
T10 business source contains no direct `alert(...)` calls;
T10b a TypeScript compiler-API scan finds no `CallExpression` named `alert` in business source;
T11 `Toast.tsx` uses design tokens rather than default Tailwind colors or hex literals;
T11b `Toast.css` contains no naked hex/rgb color literals;
T12 rendering `<NotificationsProvider><ToastViewport /></NotificationsProvider>` and calling `notify.error()` shows an alert toast whose body is the message only; the error code is not body text — it stays in the message `title` (`message (CODE)`) and `data-code` for support;
T15 hovering a toast pauses its auto-dismiss; leaving resumes with the remaining time (not a fresh full duration); a de-duplicated re-notify while paused refreshes the remaining time without restarting the timer (`toast-pause-focus.spec.tsx`);
T16 focus inside a toast also pauses it — pause sources (hover, focus, each window's copy) are counted, so leaving with the mouse while the × is still focused keeps it paused;
T17 when a toast unmounts (× clicked, expiry, cap/visible-limit eviction) while focus is inside it, focus returns to the element focused before entering the toast instead of falling to `document.body`; a toast that expires without focus inside never moves focus;
T18 while dockview groups are popped out, every toast is also rendered (via `createPortal`) into each popout window's `document.body` (popout panels are rendered by the main window's React, so their `notify.*` lands in the main provider); the copy disappears when the group returns to the main window; dismiss and hover-pause work in the popout copy; each popout window's copy is keyed by its document, so returning one popout never remounts the toasts in another (`toast-popout-windows.spec.tsx`);
T19 only one copy of each toast is a live region (`role=alert/status` + `aria-live`): the popout window that has focus when the toast first appears, else the main window; the choice never changes afterwards so screen readers do not re-announce.
T21 (VSCode) at most `MAX_VISIBLE_NOTIFICATIONS` = 3 toasts are visible at once (the oldest three); the rest wait in the queue without a running timer, and when a visible one is dismissed or expires the next one appears and starts its timer;
T22 a merged toast shows its count (`×N`) after the message; a single occurrence shows none;
T23 toasts sit below modal dialogs: the viewport's `z-index` is the `--z-toast` token (40, `theme.css`), above `--z-overlay` and below `--wm-z-modal`, so an open modal's scrim covers toasts (`toast-above-statusbar.spec.ts`).
T20 toasts never cover the bottom status bar: in a document that has the status bar (`footer[data-statusbar]`, main window) the viewport sits `calc(var(--wm-statusbar-height) + 8px)` from the bottom; in a document without it (popout child windows, `PopoutHost`) it keeps `12px`, leaving no status-bar-sized gap. The height is one token: `--wm-statusbar-height: 24px` (`theme.css` `:root`), exposed as Tailwind `h-statusbar` and used by `StatusBar` (`toast-above-statusbar.spec.ts`).

Key invariants:

- `src/styles/design-tokens.css` and `electron/shared/ipc-result.ts` are not modified by this topic.
- Toast lives under `src/notifications/`, not `src/design/`, until it is generalized and pushed upstream.
- There is no main → renderer push channel: the `notify:push` infrastructure (T6–T8: `pushNotification`, `NotifyIpcBridge`, `coApi.notify.onPush`) never had a production sender and was removed. Main-side failures reach the user through each IPC's own result, which the renderer turns into a toast.
- Existing adjacent `console.warn` lines are preserved during alert收编; those toast calls use `mirror:false` to avoid double logging.
