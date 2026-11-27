# QuickOpenModal(VSCode ⌘P 文件搜索)

行为契约:**isOpen=true 时弹 Modal,展示搜索框 + 文件列表;打开/root 切换时异步 walk 工作区。
query 输入用 VSCode 文件打分过滤排序(文件名优先、空格拆段,见 `quick-open-fuzzy-score`);ArrowUp/Down 移 selectedIndex,Enter 调
openFileByPath + close(⌘Enter / ⌥Enter 在侧边打开,见 `open-to-side-from-pickers`)。无 root 显「请先在 Explorer 打开工作区」;扫描中显 spinner;
列表为空显「工作区无文件」/「无匹配文件」。候选扫描达上限(`QUICK_OPEN_MAX_FILES` = 50000)被截断 → 底部截断提示
「只搜索了前 N 个文件」(有结果与无匹配时都显示)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/quick-open/QuickOpenModal.tsx` | UI |
| `src/plugins/quick-open/store.ts` | isOpen/query/selectedIndex/results/loading |
| `src/plugins/quick-open/walk-files.ts` | walk(已测) |
| `src/plugins/quick-open/quick-open-filter.ts` | 打分排序(`src/lib/fuzzy-scorer.ts`,见 quick-open-fuzzy-score) |

## 关键行为

### 渲染态

- isOpen=false → Modal 不渲染
- isOpen=true + root=null → 「请先在 Explorer 打开工作区」
- isOpen=true + root + walk 进行 + results=[] → spinner「扫描中…」
- walk 完成 + results=[] → 「工作区无文件」
- query 过滤后空 + results 非空 → 「无匹配文件」
- 有结果 → ul + li 列出
- results.length ≥ `QUICK_OPEN_MAX_FILES` → 截断提示(`role=status`,三语带上限数):有结果时在列表下方,**无匹配时也显示**
  (第二十四轮:旧实现只在有结果时提示,截断造成的「无匹配文件」看不出原因);未截断的无匹配只显示「无匹配文件」

### 结果行

- 文件名优先(不收缩,上限 60%);右栏只显示所在目录(relPath 的 dirname,VSCode 同款,不重复文件名),从前截断
- 工作区根下的文件无目录 → 右栏不渲染
- 行与右栏的 title 均为完整相对路径
- 命中字符高亮(VSCode Quick Open:文件名与路径分别高亮):查询能在文件名里命中 → 只高亮文件名;否则按相对路径
  (打分的匹配源)取命中下标,目录段与文件名段各自包 `<mark>`(`PICKER_MATCH_CLASS_NAME`);只为渲染的可见行计算,
  不影响过滤排序;行文本不变

### 选中态

- selectedIndex 行底色为 active(.bg-hover.text-fg)
- 其它 hover 浅色

### 键盘

- ArrowDown → moveSelection(1, filtered.length)
- ArrowUp → moveSelection(-1, filtered.length)
- Enter → openFile(filtered[selectedIndex]) + close

### 点击 li

- openFile + close

### walk 失败

- console.warn + setResults([])
- loading=false
