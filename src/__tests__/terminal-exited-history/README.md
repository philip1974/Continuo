# terminal-exited-history

行为契约:**PTY 退出后,尚未关闭的终端 tab 仍能回放退出前的输出**。

`@continuo-terminal/server-node` 在 PTY 退出(自然退出 / kill)时立即删除该会话的 ring buffer,
但 Continuo 的会话 metadata 进入 exited-retained 态继续显示 tab。agent 创建的终端是 inactive
panel,用户可能从没打开过;进程退出后再点开,readHistory 拿到空 → 整个 tab 空白,输出全部丢失。

## 行为

- PTY 退出时(自然退出 / kill / forceKill)主进程保留其最后一份输出快照
- 会话已退出、tab 仍在 → `getBufferSnapshot` 返回保留的快照,**带退出时的 endOffset**:挂载回放恰逢
  会话退出时,渲染端排队的退出前推送已含于快照,须按偏移丢弃(否则最后一段输出写两次)
- 会话 metadata 删除(用户关 tab / 窗口关闭)→ 快照随之释放;退出前 metadata 已删(关 tab 触发的 kill)→ 不保留
- 保留数量有上限(最旧的先淘汰),防止大量已退出会话累积内存

## 不在本主题

- MCP `terminal_read_output` 是按 seq 增量读的,退出后不支持(kill 工具描述据此如实说明)

## 渲染端:已退出且无可回放输出的 tab 不永挂 loading

- 面板挂载时会话已退出(store 中 exitCode ≠ null),readHistory 返回空历史 → 清掉「Starting shell…」遮罩
  (退出早于挂载,之后不会再有快照变更;此前遮罩永久悬浮)
- 会话仍在运行 + 空历史 → 遮罩保留,等首批输出(prompt 尚未产出的正常态)
