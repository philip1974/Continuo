# 外部追加时光标跟随(editor-external-append-cursor)

行为契约:**光标停在文件末尾时,外部进程往文件末尾追加(写日志),重读后光标跟到新的末尾;别处的光标不动。**

对齐 VSCode:光标选区是 `TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges` 的跟踪范围(`src/vs/editor/common/cursor/oneCursor.ts`),
模型改动后从标记恢复选区(`readSelectionFromMarkers`):恰在边上插入的文本并入选区,空光标再 `collapseToEnd` 折叠到插入之后。

## 行为

- 外部重读(及另一编辑器组改同一文件)按最小差异应用时,**每个**选区各自判断(多光标照 VSCode):
  - 空光标恰在插入点 → 移到插入文本之后(末尾的光标随追加到新末尾);
  - 非空选区边上的插入并入选区(方向不变);
  - 其它位置照常随改动映射(插入点之前的光标不动)。
- 不滚动视图(VSCode 从标记恢复选区时不 reveal):视图不在末尾时阅读位置不被拽走。
- 整篇不同(无公共前后缀)的整篇替换不变:旧选区 clamp 到新长度。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/minimal-change.ts` | `selectionGrowingAtEdges`:改动后的选区(边上插入并入 / 空光标折叠到末尾) |
| `src/panels/Editor/CodeEditor.tsx` | 外部 value 同步按最小差异派发时带上该选区 |

## Specs

| File | 覆盖 |
|---|---|
| `external-append-cursor.spec.tsx` | 末尾光标随追加到新末尾;中部光标不动;多光标各自判断;非空选区边上插入并入;不发滚动请求 |
