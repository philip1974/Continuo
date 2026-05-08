# QuickOpenModal(VSCode ⌘P 文件搜索)

行为契约:**isOpen=true 时弹 Modal,展示搜索框 + 文件列表;打开/root 切换时异步 walk 工作区。
query 输入用 fuzzyFilter(relPath)过滤;ArrowUp/Down 移 selectedIndex,Enter 调
openFileByPath + close。无 root 显「请先在 Explorer 打开工作区」;扫描中显 spinner;
列表为空显「工作区无文件」/「无匹配文件」。≥5000 文件 + 已过滤 → 底部尾巴提示。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/quick-open/QuickOpenModal.tsx` | UI |
| `src/plugins/quick-open/store.ts` | isOpen/query/selectedIndex/results/loading |
| `src/plugins/quick-open/walk-files.ts` | walk(已测) |
| `src/plugins/command-palette/fuzzy.ts` | fuzzyFilter(已测) |

## 关键行为

### 渲染态

- isOpen=false → Modal 不渲染
- isOpen=true + root=null → 「请先在 Explorer 打开工作区」
- isOpen=true + root + walk 进行 + results=[] → spinner「扫描中…」
- walk 完成 + results=[] → 「工作区无文件」
- query 过滤后空 + results 非空 → 「无匹配文件」
- 有结果 → ul + li 列出
- results.length≥5000 + filtered>0 → 底部尾巴提示

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
