# KeybindingsTabContent(快捷键参考表 SettingTab)

行为契约:**列出 commands registry 中所有「有 hotkey 或显式 unbind 但有默认」的命令,
按 category 分组(空 category → 「其他」)。展示 title / id chip / hotkey KeyCap,
点击编辑 → 弹 KeybindingCaptureModal,onSave → store.setHotkey,onReset → store.reset。
搜索框过滤 title/category/id/hotkey。无匹配 → 空状态文案;一条都没注册 → 「暂无注册了快捷键的命令」。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/KeybindingsTabContent.tsx` | UI |
| `src/plugins/registries/CommandRegistry.ts` | commands |
| `src/plugins/keybindings/keybindings-store.ts` | overrides |
| `src/plugins/keybindings/KeybindingCaptureModal.tsx` | 编辑 modal(已测) |

## 关键行为

### 列表组成

- 包含:`hotkey` 存在,**或** id 在 overrides 中(允许用户改回)
- 不包含:从未注册 hotkey + 没改过

### 分组

- spec.category 缺 → 'DEFAULT_GROUP'='其他'
- 同 category 内 title localeCompare 排序
- 不同 category 之间 category localeCompare 排序

### 搜索过滤

- 大小写不敏感,匹配 title / category / id / hotkey

### 空态

- totalWithHotkey=0 → 「暂无注册了快捷键的命令」
- query 过滤后空 → 「无匹配命令」

### override 显示

- 行末 reset 按钮 invisible(未 override)/ visible(override 中)
- 点 reset → store.reset(cmd.id)

### 编辑

- 点编辑按钮 → 设 editing,Modal 弹出
- onSave(combo) → store.setHotkey(cmd.id, combo)
- onResetToDefault → store.reset(cmd.id)

### hotkey 渲染

- effective(override 优先)有 → KeyCap 切片
- 无(unbind)→ 「未绑定」
