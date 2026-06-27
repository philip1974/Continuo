// 终端会话数量上限,main(reservation 双闸,E235)+ renderer(IPC ingress 计数闸,E292)单一来源。
//
// 跨进程单一来源放 electron/shared(renderer 不可 import main;此前 MAX_TERMINAL_SESSIONS_GLOBAL 是
// main terminal-sessions.service.ts 的本地 const,renderer ingress 无对应上限 → 畸形/有 bug 的 main 推送
// 超 256 的 sessions 数组时 renderer 无界遍历 + 入 store + 渲染 tab)。值远超任何正常人工/agent 并发终端数。

export const MAX_TERMINAL_SESSIONS_GLOBAL = 256; // 全局会话上限
export const MAX_TERMINAL_SESSIONS_PER_WINDOW = 64; // 单窗口会话上限
