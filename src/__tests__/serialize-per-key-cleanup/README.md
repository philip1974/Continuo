# serialize-per-key 链排空后回收(race R100)

`runSerialPerKey`(renderer 版,R21)按 key 把异步任务串行化并返回结果。

## 行为契约

- 同一 key 的任务按调用顺序串行执行,调用方拿到本次任务的真实结果/异常。
- **链排空(该 key 当前无在途/排队任务)后,必须从 chains Map 删除该 key**,使 Map 不随
  用过的 key(editor saveChains 按 tabId、PluginDataStore writeChains 按 pluginId)单调增长 ——
  否则已完成的串行锁条目永不回收,长会话/大量打开保存文件后形成内存泄漏。
- 删除只在「仍是当前尾部」时发生:cleanup 微任务跑前若有新任务入队,占位换成新尾,不误删,
  锁链保持完整(保序不被破坏)。
