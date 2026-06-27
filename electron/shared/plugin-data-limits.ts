// 插件本地 KV 存储(app.dataStore)的大小上限,main + renderer 单一来源(E20/E43)。
//
// 纯常量(无 node/electron 依赖),renderer 与 main 都可 import:
//  - main:plugin-data-store.service.ts 读盘 stat.size + 写盘 serialized.length 校验(E20)。
//  - renderer:PluginDataStore.write() 在 JSON.stringify 后、发 IPC 前预检(E43),挡畸形/恶意
//    插件传入超大对象时 renderer 先构造巨大字符串 + 跨 IPC 传输 + 主进程才拒绝的前置放大。

export const MAX_PLUGIN_DATA_BYTES = 16 * 1024 * 1024; // 16 MiB
