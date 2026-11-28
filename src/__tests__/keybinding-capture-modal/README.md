# KeybindingCaptureModal(快捷键捕获 modal)

行为契约:**用户改某 command 的 hotkey:监听 keydown,把组合编成 'mod+shift+x' 形式呈现;
Backspace=unbind('');无修饰 Enter=保存已录组合;其它键 → 完整组合。Esc 由 Modal 自身处理 onClose。
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
- 无修饰的 Tab / ⇧Tab → 不拦截(A62 焦点导航);带 Ctrl / Cmd / Alt 的 Tab(⌃Tab、⌃⇧Tab、⌥Tab…)→ 照常录成组合。
  VSCode DefineKeybindingWidget 连无修饰 Tab 都录(只能 Esc 出);这里为键盘可达性刻意让出无修饰的两个
- 单独修饰键(Meta/Control/Shift/Alt)→ 不更新 captured
- Backspace → captured=''
- 'a' → captured='a'
- meta + shift + 'x' → captured='mod+shift+x'

### 录制区焦点 + Enter 保存(对齐 VSCode 录键框 DefineKeybindingWidget)

- 录制区 `data-testid="keybinding-capture-area"` 可获焦(tabIndex=0)且 `data-autofocus` → 打开即聚焦录制区
  (此前无 data-autofocus,初始焦点落在第一个按钮「取消」,Enter 等于点了取消)
- 无修饰 Enter(焦点不在按钮上)= 接受:已录组合(含 Backspace 清空的 '')→ onSave + onClose;不被录成按键
  (与 VSCode 一致:录键框里 Enter 是确认,无修饰 Enter 单键不可录;Shift/Ctrl/Cmd/Alt+Enter 仍可录)
- 未录到组合 / 录到保留键 / 与其它命令冲突 → Enter 不保存(冲突须看过警告后显式点「保存」;VSCode 此处
  直接接受,这里刻意更保守,因为冲突时只有先注册的命令会响应)
- 焦点在按钮上的 Enter / Space 仍放行给按钮激活(A63)
- Esc 由 Modal 处理 → onClose(取消)

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
