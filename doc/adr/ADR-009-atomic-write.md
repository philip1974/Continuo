# ADR-009 · Atomic file write (five-step rename)

**Status**: Accepted, implemented (extracted from ContinuoWiki tutorial 06 §3.5).

## Context

`fs.writeFile(path, content)` directly truncates and re-fills the target. If the process crashes, the OS power-fails, or the renderer dies mid-write, the user's file becomes empty or half-written. For an editor that the user trusts with hours of writing (`editor.store` flushing to disk via auto-save, see ADR-015), partial writes are unacceptable.

## Decision

Every `fs.writeFile` / `fs.writeBinary` / `fs.createFile` IPC channel goes through an **atomic write helper** with five steps:

1. Write `${path}.tmp` (full new content).
2. `fsync(fd)` — force the OS page cache to disk.
3. If `${path}` already exists → `rename` it to `${path}.backup`.
4. `rename ${path}.tmp → ${path}`  ← **this step is the atomic point** (POSIX `rename` is atomic on the same filesystem; NTFS provides equivalent semantics via `ReplaceFile`).
5. Delete `${path}.backup`.

Any step 1–3 failing → return `{ ok: false, code: 'FS_IO', message }`, leave the original file intact.

Step 4 failing → restore `${path}.backup` to `${path}`, then return the failure.

Step 5 failing → **ignore the error**. The new content is already in place; the leftover `.backup` is a cosmetic issue, not a data loss.

## Implementation

`electron/main/ipc/fs/atomic-write.ts`. Accepts `string | Uint8Array` content. No external dependencies — pure `fs.promises`.

Verified end-to-end via Explorer write flow + Editor auto-save flow.

## Consequences

- **Disk usage**: transiently 2× the file size during the write window.
- **Filesystem boundary**: rename only atomic within the same filesystem. The temp file lives in the same directory as the target, so this is the common case. Cross-FS writes (e.g. writing to a mounted share with a temp on local) are not covered — those should error or be done with copy-then-rename inside the destination FS.
- **Permission**: the directory must be writable for the `.tmp` and `.backup` to land; this is the same requirement as the original write.

## See also

- ContinuoWiki tutorial 06 §3.5 ("写文件的原子操作")
- `electron/main/ipc/fs/atomic-write.ts`
- ADR-015 (auto-save consumes this through `fs.writeFile`)
