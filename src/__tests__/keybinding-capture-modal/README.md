# KeybindingCaptureModal(快捷键捕获 modal)

行为契约:**用户改某 command 的 hotkey:监听 keydown,把组合编成 'mod+shift+x' 形式呈现;
Backspace=unbind('');其它键 → 完整组合。Esc 由 Modal 自身处理 onClose。
保存按钮在 captured!==null 时启用,点击 → onSave + onClose。
重置默认仅在有 defaultHotkey 或已 captured='' 时启用,点击 → onResetToDefault + onClose。
冲突检测:captured 非空时扫描其它命令 effective hotkey 命中 → 显示警告(不阻止保存)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/keybindings/KeybindingCaptureModal.tsx` | UI |
| `src/plugins/command-palette/format-hotkey.ts` | hotkey → KeyCap 切片(已测) |
| `src/plugins/keybindings/keybindings-store.ts` | getEffectiveHotkey |

## 关键行为

### 显示态

- captured=null + currentHotkey='mod+s' → 显示 currentHotkey 的 KeyCap
- captured=null + currentHotkey=undefined → 显示「按下新组合…」
- captured='' → 显示「未绑定(unbound)」
- captured='mod+x' → KeyCap 渲染新组合

### 按键

- Esc → 不拦截(交给 Modal)
- 单独修饰键(Meta/Control/Shift/Alt)→ 不更新 captured
- Backspace → captured=''
- 'a' → captured='a'
- meta + shift + 'x' → captured='mod+shift+x'

### visible 切换

- false → true 时 captured 复位为 null

### 冲突检测

- captured 非空时 → 扫 allCommands 中 effective hotkey 等于 captured 且 id≠commandId
- 显示「⚠️ 此组合已绑定到其它命令」

### 保存

- captured===null → disabled
- 否则 → onSave(captured) + onClose

### 重置默认

- defaultHotkey 缺 + captured!=='' → disabled
- 否则 → onResetToDefault() + onClose
