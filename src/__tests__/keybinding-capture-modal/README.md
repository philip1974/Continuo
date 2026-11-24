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
- 比较前两侧都经 canonicalHotkey 归一到运行时语义:修饰键顺序无关、去重、option≡alt、
  mod 按平台映射(mac≡cmd / 其它≡ctrl)、主键别名归一 → `shift+mod+enter` 与 `mod+shift+enter` 判冲突
- 显示「⚠️ 此组合已绑定到其它命令」

### Quick Open / 命令面板保留键

- ⌘P / ⌘⇧P(平台感知:mac 仅 Cmd、其它仅 Ctrl;与 `usePickerToggleHotkey` 同源 `PICKER_TOGGLE_HOTKEYS`)
  是 document 级写死监听、不在 CommandRegistry,绑上会一键两动作 / 编辑器焦点下命令永不执行
- captured 命中 → role=alert 提示「与 Quick Open / 命令面板冲突,是保留快捷键」,**保存 disabled**(拒绝,不是可覆盖警告)
- mac 上 Ctrl+P 不是保留键(picker 不认)

### 保存

- captured===null → disabled
- captured 命中保留键 → disabled
- 否则 → onSave(captured) + onClose

### 重置默认

- defaultHotkey 缺 + captured!=='' → disabled
- 否则 → onResetToDefault() + onClose
