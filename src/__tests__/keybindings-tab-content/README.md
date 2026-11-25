# KeybindingsTabContent(快捷键参考表 SettingTab)

行为契约:**列出 commands registry 中的全部命令(对齐 VSCode 键盘快捷方式编辑器;无快捷键的显示「未绑定」,可直接录键),
按 category 分组(空 category → 「其他」)。展示 title / id chip / hotkey KeyCap,
点击编辑 → 弹 KeybindingCaptureModal,onSave → store.setHotkey,onReset → store.reset。
搜索框过滤 title/category/id/hotkey。无匹配 → 空状态文案;一条都没注册 → 「暂无命令」。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/KeybindingsTabContent.tsx` | UI |
| `src/plugins/registries/CommandRegistry.ts` | commands |
| `src/plugins/keybindings/keybindings-store.ts` | overrides |
| `src/plugins/keybindings/KeybindingCaptureModal.tsx` | 编辑 modal(已测) |

## 关键行为

### 列表组成

- 全部命令(含从未注册 hotkey 的);无生效快捷键(无默认 / 显式解绑)显示「未绑定」
- 统计行:「共 N 个命令，M 个已绑定」(M 按生效快捷键计,解绑不算)+「也可用 ⇧⌘P 在命令面板中搜索执行」;
  键帽组 `inline-flex whitespace-nowrap`,窄宽不拆行

### 分组

- spec.category 缺 → 'DEFAULT_GROUP'='其他'
- 同 category 内 title localeCompare 排序
- 不同 category 之间 category localeCompare 排序

### 搜索过滤

- 大小写不敏感,匹配 title / category / id / hotkey
- hotkey 的搜索文本含原始串(mod+t)+ 平台显示形式(mac `⌘T`、其它 `Ctrl+T`)+ mac 修饰键英文名(cmd+t):
  Windows 输 ctrl+t、mac 输 ⌘ / cmd 都能搜到
- 界面语言非 en 时搜索文本另含英文原名(标题 + 分类,与命令面板同源 `englishWithFallback`):zh / ko 下输「open folder」
  能搜到「打开文件夹…」(VSCode 同样可按英文命令名搜)

### 按快捷键搜索(对齐 VSCode KeybindingItemMatches)

- 查询含 `+` 且前几段都是修饰键名(cmd / meta / ⌘、mod、ctrl / control / ⌃、shift / ⇧、alt / opt / option / ⌥)、
  末段是非空主键 → 按快捷键语义比对,不再做子串匹配(`cmd+s` 不再因是 `cmd+shift+e` 的前缀而误中 ⇧⌘E)
- 主键精确相等(别名 / 上档符号同运行时归一);普通查询要求查询的修饰键都在绑定里(`cmd+s` 命中 ⌘S 与 ⇧⌘S),
  引号查询 `"cmd+s"` 要求修饰键集合完全相同(只命中 ⌘S)
- 其余查询(含未写完的 `cmd+`)照旧文本搜索

### 搜索框 Esc(对齐 VSCode)

- 有内容时 Esc 清空搜索并阻止冒泡(外层不会因此关闭 / 失焦);输入法组字中不处理
- 内容为空时不拦截,Esc 交给外层照常处理

### 空态

- 命令数=0 → 「暂无命令」
- query 过滤后空 → 「无匹配命令」

### override 显示

- 行末 reset 按钮:未 override 时宽 invisible 占位、列表窄(`@max-md`)时 hidden 让出宽度;override 中始终可见
- 点 reset → store.reset(cmd.id)
- reset 提示「恢复默认(…)」里的默认快捷键用与键帽同一格式化(⇧ ⌘ ↵ / Shift Ctrl Enter),不显示原始串

### 编辑

- 点编辑按钮 → 设 editing,Modal 弹出
- onSave(combo) → store.setHotkey(cmd.id, combo)
- onResetToDefault → store.reset(cmd.id)

### hotkey 渲染

- effective(override 优先)有 → KeyCap 切片
- 无(unbind)→ 「未绑定」
