# explorer-downgrade-compat(会话文件降级兼容)

0.2.15(已发布)读 `explorer.json` 用 strict 的 v3 schema:有一个不认识的字段就当损坏 → 原文写进一次性的 `explorer.json.corrupt`
(`wx`,只写一次),随后用默认值覆盖。之后版本给 v3 加了窗口几何、搜索输入、编辑器组 / 固定 / 预览 / MRU / 视图状态 / 编码、
按文件夹快照、`openWindowSeqs` 等字段,仍写 `version: 3` → 升级后回退到 0.2.15,整个工作区会话被清空,再升级也找不回。

对标 VSCode:各项状态是 `state.vscdb` 里的独立键(`src/vs/platform/storage/common/storage.ts`),旧版本只读它认识的键,不认识的键不影响它。
这里旧版本已发布不能改,只能让新版不往旧版本要读的文件里写它不认识的东西。

## 行为

- **explorer.json 只写 0.2.15 认识的字段**;新增字段写旁挂 `explorer-ext.json`(按 windowSeq 对应窗口段),读时合并回去
  (`electron/main/explorer-downgrade-compat.ts`,写入口 `writeExplorerFile`、读入口 `loadExplorer` 各一处)。
  守护:`fixtures/explorer-schema-0.2.15.ts` 是 0.2.15 schema 原样快照,新版写出的 explorer.json(每个新增字段都填上)必须过它的 strict v3。
  以后再加字段:放到白名单之外即自动进旁挂文件;往 0.2.15 已有的子对象(如 `explorer` / `workspace`)里加字段会被守护测试拦下。
- **拆分过编辑器组的 layout**:写给 0.2.15 的 layout 只留一个编辑器面板(`editor`;主编辑器被关掉时第一个组面板顶替这个 id),
  去掉其余 `editor:N`(0.2.15 不认识编辑器组,会显示成内容一样的多个编辑器),空出的尺寸并给主编辑器那一侧,活动组被去掉 → 改指主编辑器所在组;
  完整 layout 进旁挂文件。守护:写出的文件仍过 0.2.15 strict schema,且 layout 里只有一个编辑器面板。
- **按窗口比对旧版本有没有改过 tab**:旁挂文件逐窗口记下写出时该窗口的 tab 列表摘要(`openFilePaths` + `activePath`)与
  layout 结构摘要(分组树形、各组面板、面板 id 与类型;不含尺寸、标题、参数、活动面板 / 活动组 —— 0.2.15 什么都不动退出也会重写这些,
  如编辑器面板标题、`lastClosedAt`)。读时逐窗口:
  - tab 列表对得上 → 该窗口的编辑器组、MRU、预览 / 固定 tab 照常合并;layout 结构也对得上 → 还原完整 layout(组面板回来);
  - tab 列表对得上、layout 结构变了(旧版本里挪过面板)→ 用 explorer.json 的 layout,编辑器组不合并(组面板已不在 layout 里);
  - tab 列表对不上(旧版本里改过 tab)→ 该窗口以 explorer.json 为准,只合并与 tab 列表无关的字段(几何、搜索、视图状态、编码、Markdown 模式);
  - 只影响对不上的那个窗口;`openWindowSeqs` 只留 explorer.json 里仍在的窗口;文件夹快照照常合并。
  旁挂文件里没有逐窗口摘要的段(更早写的)退回整份原文摘要比对(不符 = 当作 tab 列表对不上)。
- 旁挂文件缺失 → 只用 explorer.json;JSON 损坏 → 留 `.corrupt` 后只用 explorer.json;字段值畸形(合并后不合 schema)→ 只用 explorer.json。
  读不出来(权限 / 超大)→ 同 explorer.json「当前态未知」,抛出、不覆盖。
- 启动时:未拆分的旧文件(explorer.json 自带新增字段)重写一次拆出去。
- **找回被旧版本清掉的会话**:启动时 `explorer.json.corrupt` 能被本版本完整解析(说明不是真损坏,只是旧版本不认识新字段)且当前会话没有任何
  用户数据(无最近目录 / 固定项 / 快照,各窗口没开文件夹与文件 —— 即旧版本重建出的空会话,或 explorer.json 不存在)→ 自动恢复,
  `.corrupt` 改名 `.corrupt.restored`(不重复恢复)。当前会话已有数据 → 不动、`.corrupt` 保留(不拿旧会话覆盖降级期间的新工作)。
  explorer.json 存在但本身损坏 → 不恢复(它的原文没能留证,不能覆盖)。

## 规范

- `explorer-downgrade-compat.spec.ts`
