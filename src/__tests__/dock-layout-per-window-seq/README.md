# dock-layout-per-window-seq

This BDD topic is the topic-08 workspace-isolation follow-up after topic-07. It captures the persistence and IPC contracts needed for dock layout to be scoped by stable per-window sequence IDs instead of leaking state across windows. The main surface is main-process persistence: `explorer.json` v3 schema, layout data merged into the explorer file, atomic `windowSeq` allocation, and protection for main-owned fields while renderer persistence moves to v3-aware roundtrips.

Behavior contract checklist T1-T28:
T1 v3 schema contains `windows` keyed by `windowSeq`;
T2 legacy explorer roots migrate into a current window entry;
T3 legacy layout payload migrates into the v3 layout section;
T4 migration is idempotent;
T5 corrupt or missing optional layout data falls back without losing roots;
T6 unknown fields survive read/write roundtrips;
T7 LRU metadata is bounded and deterministic;
T8 window sequence service exposes allocate/read/write helpers;
T9 `layout:read` resolves the sender window context;
T10 `layout:write` writes only the sender window layout;
T11 explorer file migration handles empty, v2-only, layout-only, and mixed paths;
T12 renderer v3 persistence sends the correct window-scoped payload;
T13 `explorer:write` cannot overwrite another window entry;
T14 window close flush persists the last known layout;
T15 `ensureWindowEntry` creates missing entries without replacing existing data;
T16 multi-window IPC mocks prove independent layouts;
T17 persistence writes via temp file plus rename;
T18 file mutex serializes concurrent read-modify-write operations;
T19 `safeHandleWithCtx` injects sender context into handlers;
T20 `lastClosedAt` is owned by main process and updated on close;
T21 e2e roundtrip gate validates reopen behavior;
T22 writable merge rejects stale or foreign `windowSeq`;
T23 main-owned fields are preserved during renderer writes;
T24 writable merge preserves unknown future fields;
T25 IPC errors preserve stable error codes;
T26 `mergeWritableIntoFull` only updates current-window writable fields;
T27 throw-with-code helpers normalize coded failures;
T28 `allocateWindowSeq` is atomic under concurrent window creation.

This topic is related to topic-07 by closing the remaining workspace-isolation gaps that topic-07 left at the layout/persistence boundary. Topic-07 established window-aware runtime behavior; this topic makes that behavior durable across `explorer.json` migration, layout roundtrips, close flushes, and e2e gates. Reference context lives in `doc/24` and `.claude/dev-loop/08-*`, but this directory is intentionally only the BDD red entry point for Op1.
