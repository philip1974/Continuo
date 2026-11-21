# terminal-panel-empty-dock

行为契约:所有 terminal panel 被关闭后,dockview 可以进入空状态并渲染 EmptyState。reconciler 不应因为 dock 为空而自动新建 terminal panel;新 terminal 只能来自显式用户命令或 main sessions snapshot 新增。

这个 topic 锁住“关最后一个 terminal panel”和“sessions 为空”两个条件的差异:前者只影响 dock UI,后者不触发自动 spawn。
