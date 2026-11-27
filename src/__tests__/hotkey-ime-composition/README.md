# hotkey-ime-composition(输入法组字中的按键不触发工作台快捷键)

行为契约(对齐 VSCode:keybinding 分发把 keyCode 229 映射成 `KEY_IN_COMPOSITION`,不匹配任何绑定):**输入法(拼音 / 日文 /
韩文)组字中的按键 —— `isComposing === true` 或 `keyCode === 229` —— 属于输入法,工作台快捷键一律不执行,也不 `preventDefault`。**
组字中 Esc 是取消组字、Enter 是确认候选、方向键是选候选;F 键 / 带修饰键的组合同样不当快捷键。组字结束后照常分发。

- 全局命令分发(`useCommandHotkeys`,主窗与 popout 子窗):组字中按下与绑定相同的键不执行命令。
- Quick Open / 命令面板开关键(`usePickerToggleHotkey`,⌘P / ⌘⇧P):组字中不打开 / 不关闭。
- 编辑器查找 / 替换框里组字中的 Esc 不关查找条,见 `editor-find-widget`。
- 其它已自带组字判断的入口(`isImeComposing`,`src/design/ime.ts`):Modal、命令面板 / Quick Open 列表、在文件中查找、设置搜索、
  快捷键搜索、资源管理器新建 / 重命名、终端查找条与终端让出键、Markdown 编辑区(ProseMirror 自身处理组字)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/command-palette/useCommandHotkeys.ts` | 分发 handler 开头判组字 |
| `src/plugins/picker/use-picker-toggle-hotkey.ts` | picker 开关键判组字 |
| `src/design/ime.ts` | `isImeComposing(e)` |

## Specs

- `hotkey-ime-composition.spec.tsx`
