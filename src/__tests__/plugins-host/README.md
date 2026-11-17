# plugins-host(renderer 端 ManagerHost)

行为契约:**`createWindowApiHost()` 把 `coApi.plugins.*` IPC 包成 PluginManager 期待的
ManagerHost 形态:listDirs 返回的 mainText 转成 Blob URL,readEnabled 转成 Set,
writeEnabledIds 静默 console.warn,removePluginDir 失败抛带 code 的 Error,importModule 直接走
dynamic import。IPC 失败统一 console.warn fallback 空数组 / 空 set,**而非**抛错。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/plugins-host.ts` | renderer 端 ManagerHost 实现 |

## 关键行为

### listPluginDirs

- 调 coApi.plugins.listDirs
- ok=false → console.warn + 返 []
- ok=true → 每条 IpcPluginDir 的 `moduleUrl` **惰性**生成:首次读取时才把 mainText 包成 Blob →
  URL.createObjectURL(只生成一次);未被读取的(reload 时非目标插件)不生成。manifestText 透传

### readPluginDirByManifestId(id)(perf:热重载只读目标插件)

- 调 coApi.plugins.readDirById(id);data=null → null
- ok=false → console.warn + 返 null(PluginManager.reload 据此抛 no longer exists,与旧 listDirs 失败同)
- ok=true → moduleUrl 同样惰性生成

### readEnabledIds

- ok=false → console.warn + 返空 Set
- ok=true → new Set(r.data)

### writeEnabledIds(ids)

- ok=false → console.warn,不抛
- ok=true → noop

### removePluginDir(id)

- ok=false → 抛 Error,且 error.code = r.code
- ok=true → resolve

### importModule(url)

- 透传到 dynamic `import(url)`
- import 结束(成功或失败)后对 `blob:` URL 调 URL.revokeObjectURL(已求值模块留在 module map,同 URL
  再 import 命中缓存);非 blob URL 不 revoke
