# cold-start-drag-folder (Issue #45)

Tracks issue #45 cold-start drag-folder behavior. Verifies the `fresh` query flag's routing in `initExplorerPersistence`: fresh+initialWorkspace overrides the persisted segment (root, UI, and editor tabs); no fresh keeps the existing restore behavior; the `workspace` query without `fresh` survives as the corrupted-snap fallback.
