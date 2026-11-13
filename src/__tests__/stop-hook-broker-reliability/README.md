# stop-hook broker:不丢事件、不留孤儿等待者

行为契约(`terminal.await_stop_hook` 背后的 `HookFileBroker`):

## 写入中途的 hook 文件不会被永久漏掉

CLI 用 `cat > file` 写 hook 事件:先创建空文件(第一次 watch 事件),写完再触发一次 change 事件。

- 第一次读到的是空 / 半截内容 → 解析失败,保留文件等重试(既有行为)。
- 第二次事件若恰好在第一次处理**尚未返回**期间到达,此前被「该文件正在处理」直接丢弃;第一次失败返回后
  再无事件 → 该 hook 事件永久漏掉,`await_stop_hook` 假超时。
- 现在:处理期间到达的同名事件记为「需补跑」,本次处理结束后立刻再处理一次。

## 调用方断开后等待者立即撤销

`await_stop_hook` 最长等 600s。调用方(agent 的 MCP 连接)断开后:

- 此前等待者仍挂在 broker 里:重连后同一会话的调用一直得到 `AWAIT_STOP_HOOK_ALREADY_PENDING`,
  期间真正到达的 Stop 事件被死连接的等待者消费掉,新调用方永远拿不到。
- 现在:`awaitNext(filter, signal)` 在 signal abort 时撤销等待者(reject、清定时器、让出 key);
  传入已 abort 的 signal → 立即 reject,不登记。工具把 `ctx.signal` 传给 broker。

## 安装 stop hook:畸形的用户配置不崩、不被覆盖

- `hooks.Stop[].hooks` 里有 `null` 等非对象项 → 跳过该项,正常安装(此前读 `null._continuo_managed` 抛错,
  被上层吞成没有原因的 `installed:false`)。
- 配置文件顶层不是对象(数组 / 标量)→ `parse-error`,不改写文件(此前当成空配置整体替换)。
