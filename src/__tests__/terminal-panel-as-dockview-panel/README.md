# terminal-panel-as-dockview-panel

行为契约:terminal UI 不再是一个 dockview panel 内部维护多 tab / BSP,而是每个 PTY session 对应一个独立 dockview panel。renderer 端 reconciler 以 terminal sessions store 为真实源,把 session add/remove 映射到 dockview `addPanel` / `panel.api.close`。

关闭路径必须区分“reconciler 因 store 删除主动关闭 panel”和“用户从 dockview 关闭 panel”。前者使用 suppress 标记避免反向调用 `coApi.terminal.remove`;后者在 microtask 后确认 panel 没有因 move/reparent 重新出现,才删除对应 PTY session。
