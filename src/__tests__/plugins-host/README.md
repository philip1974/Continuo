# plugins-host(renderer 端 ManagerHost)

行为契约:**`createWindowApiHost()` 把 `coApi.plugins.*` IPC 包成 PluginManager 期待的
ManagerHost 形态:listDirs 列举项的 moduleUrl 是惰性源码引用(激活时才按目录名拉 main 源码转 Blob URL),
readEnabled 转成 Set,
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
- ok=true → id / manifestText 透传;列举项**不含 main 源码**(perf:未启用插件的源码不读、不经 IPC 传给每个窗口)
- `moduleUrl` 是惰性源码引用:读取它不发 IPC、不生成 Blob URL;每次列举得到新的引用(重新 init 读最新源码)
- importModule(引用) → 首次按**目录名**调 coApi.plugins.readMainByDir(dir, manifestHash) → Blob → URL.createObjectURL;
  同一引用再 import 复用同一 Blob URL(命中 module map 缓存,不重拉);源码不可用(data=null / ok=false)→ reject、
  不生成 Blob URL,下次激活重试
- 快照一致性(真实 service 接 host):列举后、激活前 manifest 被替换 → importModule 以 `PLUGIN_MANIFEST_CHANGED`
  拒绝(插件激活失败,不以旧 manifest 执行新 main);只换 main、manifest 不变 → 照常放行

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

- 列举项的源码引用先解析成 Blob URL(见上),其它 URL 透传到 dynamic `import(url)`
- import 结束(成功或失败)后对 `blob:` URL 调 URL.revokeObjectURL(已求值模块留在 module map,同 URL
  再 import 命中缓存);非 blob URL 不 revoke
