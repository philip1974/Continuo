# editor-milkdown-roundtrip-safety

Markdown files that contain syntax Milkdown cannot preserve byte-for-byte must not be rewritten behind the user's back: they stay on the CodeMirror Source path for editing unless the user explicitly opts into Edit mode for that file. Reading them rendered (Preview) is always allowed, because Preview never writes.

## Contracts

- `isMilkdownUnsafe` detects YAML frontmatter and wiki-links, including BOM, CRLF, and EOF-terminated frontmatter variants.
- Unsafe Markdown rendered through `EditorPanel` uses CodeEditor and shows the preservation banner when the requested mode is Edit.
- Preview mode renders unsafe Markdown through read-only Milkdown (no banner, no forced Source). Frontmatter is shown as a `yaml` code block instead of being mis-parsed as a rule + heading; the stored content is untouched.
- Choosing Edit on unsafe Markdown asks for confirmation; "switch anyway" opts that tab (only that tab) into Milkdown Edit. Other unsafe tabs stay on Source. The opt-in follows the tab through edits, external reloads and save-as, and ends when the tab is closed.
- `getEffectiveMode` is the single source of truth for the engine actually rendered (EditorPanel body, mode control, EditorHeader actions, SDK `editor.openFile`).
- Milkdown preview mode does not forward mount-time or later serializer emissions to the editor store.
- Milkdown edit mode ignores serializer emissions that only differ in trailing whitespace (the mount-time trailing-paragraph normalization), and forwards every real edit — including the very first one.
- Auto-save over an unsafe Markdown file does not write changed bytes after open.

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/milkdown-roundtrip-safety.ts` | Pure unsafe-markdown predicate + preview-only frontmatter transform |
| `src/stores/editor.store.ts` | `getEffectiveMode` + per-tab unsafe-edit opt-in |
| `src/panels/Editor/EditorPanel.tsx` | Effective-mode routing, unsafe banner, opt-in dialog |
| `src/panels/Editor/MilkdownEditor.tsx` | Readonly / normalization-only emission guard |
