# i18n-strings-r2 — i18n 字符串迁移第二批 BDD

topic-16 i18n 主架构落地后，把 4 大 surface 的 hardcode 字面量迁到 catalog。

## Surface

- **core-plugins/*** — command title / panel title / setting tab title
- **panels/*** — Explorer / Terminal / Editor user-visible 文案
- **CommandRegistry / PanelRegistry** — spec 加 titleKey / categoryKey 字段
- **permissions / mcp** — AgentAuthPrompt method label + StatusBar revoke confirm

## 关键架构

- `tWithFallback(key, fallback)` — 缺 key 返 fallback 而非 key 字面量（不破现网兜底）
- `useDockLocaleSync(api)` — DockShell 内 mount；locale 变 → 遍历 panels → `setTitle(t(titleKey))`
- `addPanel({ params: { titleKey } })` — Dockview panel 元数据通道
- hardcode-regression.spec — TS Compiler API AST scanner，扫 scope 内 user-visible string literal CJK 命中

## Spec 列表

- `t-with-fallback.spec.ts` — helper 行为
- `registry-titlekey.spec.ts` — CommandSpec/PanelSpec titleKey/categoryKey 字段
- `dock-locale-sync.spec.tsx` — locale 变 → setTitle 调度
- `core-plugins-titlekey.spec.ts` — 12 core-plugins 注册后 titleKey 命中 catalog
- `command-palette-localized.spec.tsx` — CommandPalette 渲染 + filter/sort 按 displayTitle
- `explorer-panel-i18n.spec.tsx` — Explorer 6 文件三语
- `terminal-panel-i18n.spec.tsx` — Terminal 2 文件 aria-label 三语
- `editor-panel-i18n.spec.tsx` — Editor 3 文件三语
- `agent-auth-prompt-i18n.spec.tsx` — METHOD_LABEL_KEYS + generic fallback
- `statusbar-confirm-i18n.spec.tsx` — revoke confirm {count} 三语
- `hardcode-regression.spec.ts` — AST scanner CJK 限额
