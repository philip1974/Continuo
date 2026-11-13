# plugin-ipc-frame-trust(plugin-data / plugin-fs raw IPC 的 frame-trust 门)

## 行为契约

`plugin-data:*`(3 个)与 `plugin-fs:*`(18 个)是裸 `ipcMain.handle`,不经 `safeHandle`。`plugin-data` 只凭
renderer 自报的 `pluginId`(无 token)读 / 写 / 清任意插件的 `data.json`;`plugin-fs:_register-plugin` 任何
frame 可调。孪生的 `plugin-shell-stream:*` 早有 `defaultIsTrustedFrame` 检查(codex 复审 R8),这两组漏了
——同一条「所有写 / 敏感 IPC 只信真实 renderer 入口 frame」纪律未传播到兄弟入口。

### 规则

1. `withTrustedFrameGate(ipcMain)` 返回的对象,其 `handle(channel, fn)` 注册的 handler 在调用 `fn` 之前先校验
   `event.senderFrame`:不可信(含 null)→ 抛 `{ code: IPC_ERR.DENIED }`,`fn` 不执行;可信 → 原样透传全部参数与
   返回值。`ipcMain` 的其它方法(on / removeHandler …)原样转发。
2. 生产注册点 `plugin-data.ipc.ts` 与 `plugin-fs.ipc.ts` 把 **gated** 的 ipcMain 传给 service(单一漏斗,service
   内 21 个 handler 无需逐个加检查)。service 的单测仍可直接传裸 fake ipcMain。
3. `plugin-shell-stream` 的两处内联检查改用同一个 `assertTrustedFrame`(同一错误形态)。
