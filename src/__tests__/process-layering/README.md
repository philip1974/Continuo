# process-layering(重构:进程间依赖方向)

## 行为契约

三棵源码树的依赖方向固定:`electron/shared`(跨进程契约,无进程依赖)← `electron/main` / `electron/preload`
← 无;renderer(`src/`)可依赖 `electron/shared`,对 `electron/preload` 只取类型。此前 main 有 8 处反向从
`src/plugins/{types,permissions,manifest}` 导入**运行时值**(PathScope 错误类、PERMISSION_KEYS、
parseManifest),`tsconfig.node.json` 被迫逐个白名单 `src/` 文件。已把这些契约下沉到 `electron/shared/`
(`plugin-fs-contract` / `permission-keys` / `plugin-manifest` / `permission-record-limits`),`src/plugins/*`
原路径保留 re-export(插件 SDK 的类型入口不变)。

### 规则

1. `electron/` 下任何文件(含主进程测试)不得从 `src/` 导入。
2. `electron/shared/` 不得导入 `electron/main`、`electron/preload` 或 `src/`。
3. `tsconfig.node.json` 的 `include` 不含任何 `src/` 条目。
4. `src/plugins/{types,permissions,manifest}` 的既有导出与 shared 定义是**同一对象**(re-export,非副本)。
