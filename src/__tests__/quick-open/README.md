# quick-open(⌘P 文件模糊搜索)

行为契约:**VSCode 同款 Quick Open** — 全局 ⌘P 触发,工作区文件
模糊搜索,Enter 打开 Editor。

> ⌘P 占用变更:之前 ⌘P=CommandPalette,现 ⌘P=QuickOpen / ⌘⇧P=
> CommandPalette(对齐 VSCode)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/quick-open/store.ts` | useQuickOpenStore — isOpen / query / selectedIndex / results / loading |
| `src/plugins/quick-open/walk-files.ts` | walkWorkspaceFiles 纯函数:listDir + 过滤 + slice maxFiles |
| `src/plugins/quick-open/QuickOpenModal.tsx` | UI 仿 CommandPalette |
| `src/plugins/quick-open/useQuickOpenHotkey.ts` | ⌘P 全局 toggle |

## 关键行为

### Store(同 CommandPalette 风格 + results / loading)

- `open()` reset query + selectedIndex,设 isOpen=true
- `close()` 仅 isOpen=false(query / results 保留 — 短期内重开秒响应)
- `setQuery(q)` 更新查询,reset selectedIndex 为 0
- `moveSelection(delta, max)` 循环
- `setResults(files)` walk 完成后 store
- `setLoading(b)` walk 期间 spinner

### walkWorkspaceFiles(纯函数)

接受:
```ts
{
  rootPath: string;          // workspace 根
  listDir: (path, opts) => Promise<{ ok: true, data: FileEntry[] } | IpcFail>;
  maxFiles?: number;         // 默认 5000
  extraExclude?: string[];   // 额外 ignore basename
}
```

行为:
- 调 `listDir(rootPath, { maxDepth: 8, exclude: [默认 + extraExclude] })`
- 默认 extraExclude:`dist / out / build / .next / .nuxt / .cache / .vite`
  (listDir 内置已排:`.git / .svn / .hg / node_modules / .DS_Store / Thumbs.db`)
- 过滤 isDirectory=false(只要文件,不要目录)
- slice(0, maxFiles)防卡死
- listDir 失败 → 返 `{ ok: false, code, message }`
- root 不存在 → fail
- 空 workspace → 返空数组(ok)

### QuickOpenModal UI

- Modal 仿 CommandPalette 形态(560px 宽,Input + 列表)
- 列表项显示:文件名 加粗 + 相对路径(rootPath 截掉)灰色
- 空 query → 显示全部(按相对路径排序);有 query → fuzzyFilter
- 选中 Enter → 调 openFileByPath(absolutePath, deps),关闭 Modal
- 空 results(query 无匹配 / workspace 空) → "未找到文件" 空态
- loading=true → "扫描中…" spinner
- workspaceRoot 为 null(未打开 workspace)→ "请先打开工作区" 空态

### Hotkey ⌘P / Ctrl+P

- 已 open 再按 → close(toggle)
- 不 open → open + 触发 walk(异步,先显空列表 + loading=true,完了
  setResults + loading=false)

## 不在本主题验证

- Modal 渲染细节(由 design Modal 自身保证)
- fuzzyFilter 算法(由 command-palette/fuzzy.spec 持有)
- openFileByPath(由 editor-file-actions 自身 spec 持有)
- listDir 后端行为(由 fs-* topic 持有)
- 全局快捷键 keydown 监听(由 command-hotkeys topic 模式参考,本 topic
  只测 store.open / close 行为契约)
