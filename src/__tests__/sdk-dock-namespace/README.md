# SDK dock namespace

Topic 31 adds the plugin-facing `app.dock.openPanel(panelId)` API.

Behavior contract:

- v1 is a singleton panel API: `panelId === PanelSpec.type === component === id`.
- If the panel is registered and already open, `openPanel` focuses it.
- If the panel is registered but not open, `openPanel` adds the panel through Dockview.
- If the panel id is unknown or Dockview is not ready, `openPanel` is a silent no-op.
- Scoped plugin apps expose a wrapped `dock` namespace so future policy hooks can live in `scoped-app.ts`.
