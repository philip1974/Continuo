# editor-milkdown-roundtrip-safety

Markdown files that contain syntax Milkdown cannot preserve byte-for-byte must stay on the CodeMirror Source path unless the user explicitly opts into Edit mode.

## Contracts

- `isMilkdownUnsafe` detects YAML frontmatter and wiki-links, including BOM, CRLF, and EOF-terminated frontmatter variants.
- Unsafe Markdown rendered through `EditorPanel` uses CodeEditor and shows the preservation banner even when the requested mode is Edit.
- Milkdown preview mode does not forward mount-time or later serializer emissions to the editor store.
- Auto-save over an unsafe Markdown file does not write changed bytes after open.

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/milkdown-roundtrip-safety.ts` | Pure unsafe-markdown predicate |
| `src/panels/Editor/EditorPanel.tsx` | Effective-mode routing and unsafe banner |
| `src/panels/Editor/MilkdownEditor.tsx` | Mount/readonly emission guard |
