# dock-layout-json-safe-write — 布局写盘前清洗成 JSON-safe

## 背景 / 行为契约

dockview `api.toJSON()` 在某些瞬时状态(拖拽中、零面积 group、布局未就绪)会产出**非有限
`size`** 等非 JSON-safe 值。写端 `layout:write` 链上的 `assertJsonValue`(E119,topic-59 新增)
是为**插件数据**设计的硬守卫 —— 一旦发现非 JSON-safe 值就整份**拒写**(`BAD_INPUT`「layout
contains non-JSON-safe values」)。

后果:只要 dockview 偶发产出一个 `NaN` size,布局就**永远无法落盘**(`explorer.json` 自守卫
上线起冻结),用户每次布局变化都看到红色「面板布局保存失败」toast。

对布局这种「丢个别字段可接受、dockview 恢复时会按窗口尺寸重算 size」的 UI 状态,正确做法是
**写盘前清洗成 JSON-safe**,让其余布局正常持久化,而非整份拒绝。`makeJsonSafe(value)` 负责此事;
`writeDockLayoutSnapshot` 在 strip 终端之后、`coApi.layout.write` 之前调用,并把被丢弃的 path
打 `console.warn`(诊断)。main 侧 `assertJsonValue` 仍是兜底(清洗后必然通过)。

## 规范要点(`makeJsonSafe`)

- 保留:`null` / boolean / **有限** number / string。
- 非有限 number(`NaN`/`±Infinity`):对象属性 → **删键**;数组元素 → **置 null**(保索引,
  与 `JSON.stringify` 行为一致)。
- `undefined` / function / symbol / bigint:同上(对象删键 / 数组置 null)。
- 数组、普通对象**递归**处理;深层嵌套布局结构(grid 树)内的坏值也被清除。
- 返回 `{ value, dropped }`,`dropped` 为被丢弃字段的 path 列表(供诊断日志,如
  `$.grid.root.data[0].size`)。
- 清洗后的结果必然通过 `assertJsonValue`(写端不再 `BAD_INPUT`)。

## 与边界守卫的关系

`makeJsonSafe` **仅**用于「个别字段可接受静默丢失」的 UI 状态持久化。插件数据 /
MCP schema 等不容静默丢失的场景**仍用** `assertJsonValue` 硬拒(数据安全优先,见 topic-54)。
