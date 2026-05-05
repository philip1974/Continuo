# lm-api(LM UI 内部 IPC 入口)

行为契约:**`captureLmApi()` 启动时把 window.api 缓存到 module-local;
`lmApi` Proxy 转发已 capture → 走缓存,未 capture → fallback globalThis;
sandboxSweep 删 window.api 后 lmApi 仍能用(因走缓存)。**

> v5 Phase 4.B。配合 sandbox-sweep,plugin 拿不到 window.api,LM UI 走 lmApi。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/lm-api.ts` | captureLmApi / lmApi Proxy / _resetLmApiForTest |

## 关键行为

### captureLmApi

- 把当前 `globalThis.window?.api` 缓存到 module-local
- 缺 window.api(jsdom)→ console.warn,不抛(后续 lmApi.* 调用才报)

### lmApi Proxy

- 已 capture → 走 `_cached[prop]`
- 未 capture → fallback 取 `globalThis.window?.api[prop]`
- 都没有 → 抛 `[lm-api] 访问 lmApi.X 时 window.api 未注入,且未 captureLmApi()`

### 与 sandbox-sweep 的协作

- main.tsx 顺序:`captureLmApi()` → `sandboxSweep()`(PROD)→ `PluginManager.init()`
- sweep 后 globalThis.api / window.api 都是 undefined
- LM UI 后续 `lmApi.fs.readFile(...)` 仍能工作,因 Proxy 走 _cached
- plugin 直接 `window.api.fs.*` → TypeError(undefined)
