# SDK Contract BDD

This topic guards the plugin-facing SDK contract that Plan 06 depends on:
`shell.exec`, path-scoped `fs`, `workspace.getRoot`, and `DataStore`.

The specs are split into two layers:

- `shape/` pins the renderer/plugin-facing API surface. These specs use type
  assertions, runtime existence checks, and focused static checks around
  web-compatible SDK patterns.
- `integration/` exercises main-process service handlers through a stub IPC
  harness and real temporary filesystem fixtures.

Web-compat checks are rewritten in this repository. They may cite the
sample-plugin checker as the pattern source, but they do not import code across
repositories.

BDD cases use `Tn` numbering in each subdirectory README and spec name/comment
where helpful. The numbering is local to the spec set, not a global counter.
