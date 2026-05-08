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
- ok=true → 把每条 IpcPluginDir 的 mainText 包成 Blob → URL.createObjectURL,
  manifestText / stylesText 透传

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

- 透传到 dynamic `import(url)`(测试不便覆盖)
