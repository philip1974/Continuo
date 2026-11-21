# reconciler-close-keeps-session

行为契约:**reconciler 因会话从可见快照中消失而关闭终端面板时,不得再删除/杀掉该会话的 PTY。**

会话从可见快照消失有两种情况:main 已删除该会话(再删会得到 NOT_FOUND,误报「关闭失败」),
或会话只是被 workspace 过滤隐藏(仍在 main 中存活,切回该 workspace 时应重新出现)。两种情况下
面板关闭都只是视图收敛,不代表用户要关闭终端。

- reconciler 先 `markPanelCloseSuppressed(panelId)` 再 `panel.api.close()` → EXIT 动画结束后只关面板,
  不调 `coApi.terminal.remove`。
- 用户主动关闭(未标记)→ 照常 `coApi.terminal.remove(sessionId)`。
- 是否为 reconciler 关闭以**发起关闭的那一刻**为准:用户先关、动画期间 reconciler 才标记 → 仍按用户关闭处理。
- reconciler 关闭仍在 EXIT 动画中、会话又重新可见(如快速切走再切回 workspace)→ reconciler 撤销该关闭
  (`cancelReconcilerPanelClose`),面板保留、会话不删;之后用户再关闭该面板照常 remove。
