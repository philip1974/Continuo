# 编辑器视图状态按 tab 保留(VSCode 对齐)

VSCode 每个打开的文件各自保留撤销栈、光标 / 选区与滚动位置:切到别的文件再切回、重命名、切换视图后都接着原样继续。
Continuo 的编辑器按 tab 卸载 / 重挂(EditorPanel 的 key),视图状态由 `editor-view-state-cache` 在卸载时保存、重挂时取回。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-view-state-cache.ts` | 按 tab id 存 CodeMirror 视图状态 / Markdown 滚动位置 / 切模式锚点;LRU 上限 50;重命名迁移、关闭删除 |
| `src/panels/Editor/CodeEditor.tsx` | 卸载(layout 清理,DOM 尚在)存 `EditorState` + `scrollSnapshot()`;挂载时取回 |
| `src/panels/Editor/MilkdownEditor.tsx` | 滚动时记 scrollTop;编辑器就绪后恢复 |
| `src/stores/editor.store.ts` | `renamePath` 迁移到新 id;tab 增删改名(chromeVersion 变)后丢弃已不存在 tab 的状态 |

## 行为

### CodeMirror(代码文件、Markdown Source)(`code-editor-view-state.spec.tsx`)

- 切走再切回(同 tab 重挂、内容与上次卸载时一致)→ 撤销历史、光标 / 选区、滚动位置都保留(整份 `EditorState`
  复用,配置整体换成新实例的扩展 —— 语言 / 主题 compartment 与更新监听都属于新实例,旧组件的 onChange 不再被调用)
- 切走期间内容被别处改了(Markdown 在 Edit 模式里改过再切回 Source、外部修改重载)→ 不复用撤销历史(旧历史对新
  文档无意义);光标 / 选区收进新文档范围,滚动快照按文档位置恢复并自动收进范围
- 重命名 / 移动(tab 换 id)→ 视图状态跟随到新 id(旧视图还挂着时直接按它的当前状态迁移)
- 关闭 tab(含删除文件、切工作区关掉的 tab)→ 丢弃其视图状态;同路径重开是全新历史;已关闭 tab 的编辑器随后卸载不再存入
- 最多保留 50 个 tab 的状态,超出淘汰最久未用的

### Milkdown(Markdown Edit / Preview)(`milkdown-scroll-restore.spec.tsx`)

- 滚动位置按 tab 记下,重挂(切 tab、Edit ↔ Preview、外部修改重载的 reloadEpoch 重挂)且编辑器就绪后恢复;
  节点视图下一帧才撑开高度时再补一次;恢复期间(到补齐为止)的滚动是中间值,不记进缓存
- 就绪时把 `view.focus()` 登记为可编辑区的聚焦方式:点 tab / dock tab、重启恢复聚焦不把恢复的视口拉回光标处
  (见 `focus-keeps-scroll`)
- 各 tab 互不影响;重命名后跟随新 id
- 撤销历史在 ProseMirror 插件 state 里,跨 Crepe 实例重建不复用(不保证;Edit ↔ Source 互切后各自从新历史开始,
  但 Source 侧内容未变时仍恢复其 CodeMirror 历史)
- 编辑器就绪时登记聚焦句柄(见 `editor-focus-on-open`)

### Markdown 切换模式(源码 / 编辑 / 预览)

- 从另一模式切来时按源码行交接位置与光标(锚点优先于本模式自己缓存的滚动);同模式重挂(切 tab 回来 / 外部修改重载)
  仍按上面各自的状态恢复。见 `markdown-mode-position`

## 端到端

- `tests/e2e/codemirror-state-keep.spec.ts`:改 a.ts → 切 b.ts → 切回 a.ts,内容保留且 ⌘Z 仍能撤销、光标位置保留
