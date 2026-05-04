# plugin-loader(ESM 动态加载 + styles 注入)

行为契约:**给定插件目录,加载 main.js(ESM)→ 拿到 default export 类(Plugin 子类),
注入可选 styles.css 到 head;返回一组 Disposable(unloadPlugin 调即清理)。**

文件 fetch 由调用方提供(主进程透明传 URL,renderer 用 import + fetch),
本模块只关心"给我 module URL + manifest,返回 PluginClass + cleanupStyles"。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/loader.ts` | `loadPluginModule(opts)` + `injectStyles(css)` |

## 关键行为

### loadPluginModule({ moduleUrl, manifest })

- 通过 `import(moduleUrl)` 拿到 module
- 取 `module.default`,要求是 Plugin 子类(typeof === 'function')
- 校验失败 → `{ ok: false, code: 'NO_DEFAULT_EXPORT' | 'NOT_PLUGIN_CLASS' }`
- 成功 → `{ ok: true, PluginClass }`

### 双重加载防御

- 同一 moduleUrl 二次 import 应拿到同一缓存(浏览器原生行为)
- loader 不做去重,由 PluginManager 决定是否调用

### injectStyles(css, scopeId)

- 在 `document.head` 创建 `<style data-plugin-id="<scopeId>">` 注入 css
- 返回 Disposable,dispose 时移除该 style
- 同 scopeId 重复注入 → 旧的先 dispose(防止累积)
