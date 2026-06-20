# 48-main-inject-continuo-meta

Topic 48 wires the packaged-state metadata that the plugin isolation spike
already reads from `window.__continuoMeta?.appIsPackaged`.

Plan-v2 fixes the round-1 review gaps:

- v2-A: packaged real_test must launch the rebuilt app with a runtime spike
  opt-in, not only set `CONTINUO_SPIKE=1` for build.
- v2-B: `webPreferences` are built by a factory so each window receives an
  isolated object and `additionalArguments` array.
- v2-C: missing `--continuo-packaged=` parses to `null`, preserving the old
  diagnostic "unknown" behavior instead of collapsing to `false`.
- v2-D: the change is explicitly main + preload side; the renderer spike code
  stays unchanged.
- v2-E: the exposed metadata object is frozen before crossing the
  `contextBridge`.
- v2-F: `--continuo-packaged=<bool>` is produced by one main-side helper and
  parsed by one preload-side helper.

Observable behavior:

- main adds exactly one Continuo metadata argument to every BrowserWindow it
  creates through the shared preferences factory.
- preload exposes a synchronous `window.__continuoMeta.appIsPackaged` value.
- renderer consumers keep using the existing optional read path.
