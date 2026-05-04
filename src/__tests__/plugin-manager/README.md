# plugin-manager(插件目录扫描 + 启用禁用 + 生命周期编排)

行为契约:**给定插件根目录(实现注入,主进程通过 IPC 提供)+ 启用列表,
PluginManager 扫描所有候选 → 解析 manifest → 按 enabled.json 过滤 →
loadPluginModule → new PluginClass → activate;暴露 enable/disable/listAll 方法。**

I/O 全部抽象为接口注入(`ManagerHost`),便于 jsdom 单测。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/PluginManager.ts` | `PluginManager` class + `ManagerHost` 注入接口 |

## 关键行为

### 扫描

- `host.listPluginDirs()` 返回 `[{ id, manifestText, moduleUrl, stylesText? }]`
- 调 `parseManifest`,失败的跳过 + warn
- 调 `isVersionCompatible`(若 manifest 有 minLMVersion),不兼容跳过 + warn

### 启用过滤

- `host.readEnabledIds()` 返回 `Set<string>`
- 不在集合内的解析成 "discovered but disabled",不激活

### 激活

- 对每个 enabled 插件:`loadPluginModule` → `new PluginClass(app, manifest)` → `_activate()`
- 任一插件 onload 抛错:**单插件失败不传染**,记录 error 并跳过
- 成功插件存入 `activated: Map<id, Plugin>`,失败入 `failures: Map<id, error>`

### enable / disable 单插件

- `enable(id)`:若已 active 直接返回 ok;否则 load → new → activate,写入 enabled.json
- `disable(id)`:若不 active 直接返回 ok;否则 `_deactivate` + 移除 enabled.json

### listAll

- 返回 `[{ id, manifest, status: 'enabled' | 'disabled' | 'failed' }]`

### init / shutdown

- `init()`:扫描 + 激活全部 enabled
- `shutdown()`:LIFO `_deactivate` 全部 active(防互相依赖循环挂)
