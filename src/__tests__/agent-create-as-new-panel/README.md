# agent-create-as-new-panel

行为契约:agent 通过 MCP 创建 terminal session 时,renderer reconciler 应把它作为新的 dockview terminal panel 加到最近的 terminal panel 右侧,但不抢焦点。用户显式新建 terminal 时可以使用相同 session store 路径,但需要 pending focus intent 来决定 add 后激活。

首次 hydrate 一次收到多个 sessions 时,position 应按 `createdAt` 升序稳定计算,避免恢复顺序受 IPC snapshot 或对象遍历噪声影响。
