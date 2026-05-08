# EmptyWorkspace(未选 workspace 占位)

行为契约:**`<EmptyWorkspace />` 显示「打开文件夹」按钮 + 最近项。点按钮调
`coApi.fs.selectDirectory()`,选中后 `setRoot`;最近项点击直接 `setRoot(p)`。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/EmptyWorkspace.tsx` | UI |

## 关键行为

### recentRoots 空

- 不渲染最近项 menu

### recentRoots 非空

- role="menu" 列出每条
- 点击 → setRoot(p)
- basename 与 parent 分两段显示

### 点「打开文件夹」

- 调 fs.selectDirectory()
- ok=true + data 非空 → setRoot(data)
- ok=false 或 data 空 → 不调 setRoot
- busy 期间(异步未结束)按钮 disabled,文案变「打开中…」
