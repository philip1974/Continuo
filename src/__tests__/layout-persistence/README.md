# layout 持久化 (M2)

行为契约:用户对 dock 的任何拖拽/关闭都会被记住,下次打开恢复原状。

## 关键行为

1. **写后能读回**:`saveLayout(file, json) → loadLayout(file)` 拿回结构上等价的 json。
2. **缺失文件 → null**:首次启动文件不存在,`loadLayout` 返回 `null`(由调用方落到默认布局)。
3. **损坏 JSON → null,不抛**:文件被外部破坏不应让应用崩溃。
4. **schema 校验非对象 → 拒绝写入**:`saveLayout` 对不符合 schema 的 payload 抛错(由 IPC 层 catch)。
5. **顶层 `version` 字段保留**:为未来 migration 留扩展点,passthrough 其他字段。

## 不在本主题验证

- Electron `app.getPath('userData')` 路径解析(交给 main 进程的 `ipc.ts`,无法在 node 单测中验证)。
- IPC 通道实际握手(交给 M2 手工验收脚本)。
