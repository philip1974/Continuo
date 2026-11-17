# terminal-history-replay-dedup

行为契约:**面板挂载时回放历史(readHistory)与实时输出(onData)衔接,不重复、不丢、不乱序**。

背景:面板 mount 先订阅 onData 再 readHistory。主进程合批窗口里尚未发出的 chunk 已在 ring
buffer 中 → 快照包含它,随后 flush 又经 onData 发一遍 → 同段输出写两次(流式输出的 agent
终端切到前台 / popout 重挂载时 TUI 错乱、prompt 重复)。参考 VSCode 终端重连的 replay 思路:
历史与实时流按同一坐标衔接。

坐标:主进程按会话累计收到的 PTY 输出字符数(UTF-16 code unit)。

## 主进程(terminal.service)

- 每次 `terminal:data` 推送带第三个参数 = 本批首字符的累计偏移
- overflow 截断过的批次:偏移 = 实际保留下来的尾部的起点(reset 前缀不计),使其与上一批之间必然留出缺口,
  渲染端的连续性判断不会被「截断后长度恰好凑平」骗过
- `getBufferSnapshot` 先把合批窗口里的在途数据立即发出,再取快照;返回 `endOffset` = 快照结束处
  的累计偏移 → 此后的推送偏移一律 ≥ endOffset,此前的一律 < endOffset(每批要么全在快照内,要么全在外)
- 同时返回 `startOffset` = 快照首字符的累计偏移(ring buffer 按容量挤掉最旧数据后,快照未必从 0 开始)
- 会话已不存在 → 不返回 endOffset / startOffset

## 渲染端(useTerminal)

- readHistory 回来之前到达的实时输出先暂存,历史写入后再按偏移过滤补写(保持顺序)
- 偏移 < endOffset 的推送(已在快照里)丢弃,无论早于还是晚于 readHistory 回复到达
- 历史读取失败 / 无 endOffset(旧主进程)→ 暂存的输出全部照写(退化为旧行为,不丢数据)
- 暂存的首批推送偏移 ≤ startOffset(订阅到回复之间涌入的输出超过 ring buffer 容量,快照开头已被挤掉)→
  暂存队列比快照更完整且连续:不写快照,按序照写暂存队列(否则被挤掉的中段两边都没有,直接丢失)
- 上一条只在暂存队列**确实连续**(每批首尾相接)且覆盖到 endOffset 时成立;overflow 截断过的批次有缺口
  → 退回写快照的路径(快照是连续尾部,回放质量更好)
