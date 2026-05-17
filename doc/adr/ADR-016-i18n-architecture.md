# ADR-016 · UI runtime i18n (en / zh / ko) architecture

**Status**: Accepted, implemented in topic 16 (`.claude/dev-loop/16-i18n-en-zh-ko/`).

## Context

Continuo until topic 15 was an English / Chinese-mixed app: source strings hardcoded in JSX, Settings panel labels in Mandarin only, Electron menu labels in English only. Adding Korean (or any new language) required hand-editing dozens of call sites. We also wanted:

- Runtime switching (no app restart on locale change)
- main + renderer + popout window 一致同步
- PTY child processes use the user's chosen locale's UTF-8 LANG
- Existing topic-15 `pushNotification(...)` infrastructure to keep working

cc-haha (a sibling project at `examples/cc-haha/desktop/`) had already shipped a working manual-i18n pattern using a typed flat dictionary + Zustand. That validated the lightweight approach.

## Decision

Four architectural commitments, each pinned during plan-v3 manual_override after two rounds of red-team:

### 1. Manual i18n catalog, not i18next / lingui / format.js

`translate(key, params?)` + typed `keyof typeof en` + flat dotted keys (`common.cancel`, `errors.AGENT_NOT_AUTHORIZED`, `settings.general.language.title`). Three reasons override the lure of a mature framework:

- All three target languages are LTR with no plural / gender complications. ICU not needed.
- Zero new runtime deps; `src/i18n/translate.ts` is ~80 lines.
- cc-haha proved the pattern is production-ready at our scale (~58 keys MVP, ~200 keys post-roadmap).

When plural / date / number formatting genuinely arrives, ADR-016b will revisit.

### 2. main-owned `settings.json`, **not** explorer.json v4

Topic 08 had just landed explorer.json v3 (per-window layout, ADR-012). Stuffing locale into explorer.json would:

- Force a v3 → v4 schema bump within 30 days
- Couple a global preference into a per-window data structure
- Re-trigger `mergeWritableIntoFull` audit (which only preserves window-level fields, top-level main-owned would silently drop)

Instead: **new file** `${userData}/settings.json` (Zod-validated, atomic write via `electron/main/lib/atomic-write.ts`, local mutex independent of explorer's chain). Schema:

```ts
{ version: 1, locale: 'en' | 'zh' | 'ko' }
```

Default: `mapSystemLocale(app.getLocale()) ?? 'en'` (covers `zh-CN`, `zh-TW`, `ko-KR`, etc.).

### 3. Shared catalog at `electron/shared/i18n-locales/`, **not** `src/i18n/locales/`

`src/i18n/` is renderer-only by tsconfig.web.json. main needs the same dictionary to build Electron menu labels (File / 文件 / 파일). Two options:

- a) Put catalog in `src/i18n/locales/` and configure main vite to alias `@` to `src/`
- b) Put catalog in `electron/shared/i18n-locales/` (shared by definition) and add `@shared/*` alias to renderer

We chose (b). main imports via relative path (`../shared/i18n-locales/en`); renderer imports via `@shared/i18n-locales/en` (alias added to `electron.vite.config.ts` + `tsconfig.{web,node,test}.json` + `vitest.config.ts`). Rationale:

- The catalog is metadata, not renderer business logic — `electron/shared/` is its natural home alongside `error-codes.ts` and `notify-channels.ts`.
- main-end imports are simpler (no extra alias config in main vite).

### 4. Settings registry `titleKey?` field, **not** dispose+re-register on locale change

`SettingItemSpec` and `SettingTabSpec` gain three optional fields:

```ts
readonly titleKey?: string;
readonly descriptionKey?: string;
readonly enum?: ReadonlyArray<{ value, label, labelKey?: string }>;
```

`SettingItemRow` renders via `useT()` at render time:

```tsx
const t = useT();
const title = spec.titleKey ? t(spec.titleKey) : spec.title;
```

Why not dispose + re-register all locale-bearing specs on every locale change?

- Forces every plugin to re-run `onload()` on a runtime event the plugin author didn't subscribe to
- `SettingItemSpec` has no built-in versioning, so dispose+re-register is identity-fragile
- `useT()` is `O(specs)` per render but Settings panels are open rarely; perceived cost is zero

The optional-field design also keeps **v0 plugins (only `title: string`) working unchanged** — legacy 兼容 0 成本。

## main → renderer broadcast

New IPC channels (`electron/shared/i18n-channels.ts`):

- `i18n:get-locale` — sync init pull (renderer bootstrap before `createRoot`)
- `i18n:set-locale` — renderer-initiated change; returns `{ ok, locale, gen }`
- `i18n:changed` — main → all `BrowserWindow.getAllWindows()` broadcast on every successful setLocale

P1-1 in-flight token (`setLocaleGen: number`): each setLocale increments; broadcast/menu rebuild only happens when the call is still the latest generation. Renderer mirrors the same `currentGen` to drop stale callbacks. Prevents lost-update on rapid double-clicks.

Setting `setMenuRebuilder(fn)` is a one-way hook in `electron/main/ipc/i18n.ipc.ts`: Op9 registers the actual `rebuildAppMenu` after `registerIpc()` so the dependency is loose-coupled. macOS `Menu.setApplicationMenu(buildAppMenu(getMainT()))` rebuilds the whole template per locale change (verified safe under `CONTINUO_E2E` guard).

## PTY safeguard

`electron/main/services/pty-lang.ts`:

```ts
export function withPtyLangEnv(env, locale = 'en') {
  if (env.LANG && UTF8_LANG_RE.test(env.LANG)) return env;  // user override preserved
  return { ...env, LANG: LANG_MAP[locale], LC_ALL: LANG_MAP[locale] };
}
```

Rule (P1-2): **fill default LANG only if missing or non-UTF-8**. A user who explicitly `export LANG=ja_JP.UTF-8` in `.zshrc` is honored. Forbidden non-UTF-8 (e.g. `zh_CN.GBK`) is replaced with the chosen locale's UTF-8 variant (`zh_CN.UTF-8`).

## NotifyPushPayload evolution

`electron/shared/notify-channels.ts` — `message: string` becomes `message?: string`, adds `params?: Record<string, string|number>`. NotifyIpcBridge ingress decision tree:

```
有 code → t('errors.' + code, params)
  - 若 translate 返回 key 本身 (catalog miss) → fall through 到 message
有 message → 用 message
都无 → console.warn drop
```

Existing topic-15 producers (still passing `message: string`) keep working unchanged.

## Bootstrap ordering

Per round-2 P0-2, locale must be hydrated **before** `bootCorePlugins()` (which registers `LanguageSettingPlugin` calling `addSettingItem`). `src/main.tsx` wraps the post-import boot sequence in an `async` IIFE:

```ts
void (async () => {
  const initial = await coApi.i18n.getLocale();
  if (initial.ok) {
    useSettingsStore.setState({ locale: initial.data, currentGen: 0 });
    setI18nModuleLocale(initial.data);
  }
  subscribeToI18nBroadcast();
  bootCorePlugins();
  // ... fire-and-forget initExplorerPersistence / refresh stores ...
  createRoot(container).render(<React.StrictMode><App /></React.StrictMode>);
})();
```

`captureLmApi()` stays synchronous at module top (preload bridge); IIFE wraps only the locale-dependent boot.

## Consequences

**Positive**:

- Three languages ship with type-safe key set (zh/ko `satisfies Record<keyof typeof en, string>` enforces parity)
- New plugin's locale label is one prop (`titleKey: 'settings.foo.bar'`); zero infrastructure cost
- ERROR_CODES enum stable; `errors.<CODE>` catalog is a pure rename layer, log / IPC / on-the-wire codes unchanged
- explorer.json v3 schema, persistence layer, and `mergeWritableIntoFull` all unchanged — no 30-day-old code re-audit
- main-owned `settings.json` is a clean extension point for future global preferences (next: keybindings? auto-update channel?)
- PTY users' `export LANG` not stomped on

**Negative / Trade-offs**:

- Two parallel settings stores in renderer: `useSettingsValuesStore` (existing per-item values, localStorage) and `useSettingsStore` (locale, main-mirrored). The `LanguageFromSettings` bridge keeps them sync; explicit by design to keep separation between "this is a user-toggleable preference" (values) and "this needs main-process side effects" (locale → menu rebuild + PTY env).
- Adding a new global preference (e.g. theme could in principle move from `values-store` → `settings.json`) would need a similar bridge component.
- 49 topic-16 spec adjustment deferred to follow-up topic 17: spec mocks were written speculatively in Op1 (TDD red), some don't match the v3 architecture exactly. Impl is type-correct; spec打磨 outstanding.

## Files

Authoritative implementation:

- `electron/shared/i18n-types.ts` — `Locale`, `LANG_MAP`, `UTF8_LANG_RE`, `mapSystemLocale`, `SettingsSchema`
- `electron/shared/i18n-channels.ts` — IPC channel const + payload types
- `electron/shared/i18n-locales/{en,zh,ko}.ts` — 58-key catalog × 3 locales
- `electron/main/services/settings.service.ts` — `loadSettings / saveSettings / getCurrentLocale / setCurrentLocale / getSetLocaleGen / mapSystemLocale (re-export)`
- `electron/main/services/pty-lang.ts` — `withPtyLangEnv`
- `electron/main/i18n.ts` — `getMainT()`
- `electron/main/ipc/i18n.ipc.ts` — `registerI18nIpc(trusted)` + `setMenuRebuilder(fn)` hook
- `electron/main/index.ts` — `buildAppMenu(t)` + `rebuildAppMenu` export + bootstrap await loadSettings
- `electron/main/ipc.ts` — `registerI18nIpc(trusted)` call inside `registerIpc()`
- `electron/preload/index.ts` — `coApi.i18n.{getLocale,setLocale,onChange}` exposure
- `src/i18n/{translate,react,index}.ts` — renderer `translate / useT / setLocale / notifyLocaleChange`
- `src/stores/settings.store.ts` — Zustand store + `subscribeToI18nBroadcast`
- `src/notifications/NotifyIpcBridge.tsx` — code-first ingress catalog
- `src/core-plugins/LanguageSettingPlugin.ts` — `addSettingItem({id:'general.language', titleKey, enum})`
- `src/plugins/settings/LanguageFromSettings.tsx` — values↔settings.store bridge (sibling of `useThemeBinding`)
- `src/plugins/registries/SettingItemRegistry.ts` + `SettingTabRegistry.ts` — `titleKey?` / `descriptionKey?` / `labelKey?` field additions
- `src/plugins/settings/SettingItemRow.tsx` — `useT()` render-time fallback

Topic audit trail:

- `.claude/dev-loop/16-i18n-en-zh-ko/{req.md, plan-v3.md, red-team-v{1,2}.md, execute-log.md, verify.md}` (NOT in git; archive only)

## Related

- ADR-007 zustand-pattern (settings.store sibling)
- ADR-009 atomic-write (settings.service write primitive)
- ADR-010 ipc-result-envelope (`coApi.i18n.*` return shape)
- ADR-012 explorer-json-multi-window (deliberately NOT extended; lesson driving "新 file 而非 schema bump")
- Topic 15 (commit `38720a8`) — unified-toast `NotifyPushPayload.message: string` baseline now relaxed to `message?: string` here
