# editor-markdown-lists

行为契约:**Markdown 列表在 Edit / Preview(Milkdown)里正常显示,编辑保存后文件里的列表不丢,紧凑 / 松散保持。**

## 背景

`@milkdown/preset-commonmark` 7.20 的 `bullet_list` / `ordered_list` / `list_item` 把 `spread` 声明为
`validate: "boolean"`,解析器却传字符串 `"true"` / `"false"`(序列化按 `=== "true"` 读)。prosemirror-model
1.25 校验 attrs → 抛 `RangeError: Expected value of type boolean for attribute spread`,列表节点整段被丢:
Edit / Preview 里看不到列表;在 Edit 里做任意编辑后保存,文件中的列表被删掉(数据丢失)。上游在 7.22.0
(milkdown#2419/#2423「store list spread attribute as boolean」)把 spread 全程改成布尔,Continuo 升级到 7.23。

## 行为

- 无序 / 有序 / 嵌套 / 任务列表都渲染为列表项,解析时不报 spread 类型错误。
- 序列化(保存路径)后列表仍在:紧凑列表仍紧凑,项之间有空行的松散列表仍松散,任务列表勾选状态保持。
- 在 Edit 里编辑后保存,文件仍含列表。

## Specs

| File | 覆盖 |
|---|---|
| `markdown-list-roundtrip.spec.ts` | 真实 Crepe(jsdom):渲染 + getMarkdown 往返 + 编辑后序列化 |
| `tests/e2e/markdown-lists.spec.ts` | 真实 Electron:Preview / Edit 列表可见,Edit 编辑保存后文件含列表 |
