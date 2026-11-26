// CodeEditor 用的 basicSetup:CodeMirror 的 basicSetup 去掉与 VSCode 键位冲突的查找键(codemirror 包的文档即建议按需改写它)。
// - Mod-Alt-g(⌘⌥G / Ctrl+Alt+G)= CodeMirror 自带的「转到行」小面板 → 去掉:转到行是工作台命令 workbench.action.gotoLine(⌃G,
//   经 Quick Open `:`),两套入口行为不一致;
// - Mod-g / Shift-Mod-g = 查找下一个 / 上一个 → 只在 mac 保留(⌘G / ⇧⌘G,VSCode mac 同);Windows / Linux 上 Mod 是 Ctrl,
//   Ctrl+G 归转到行(VSCode Win/Linux 的查找下一个是 F3 / 查找框内 Enter,F3 / ⇧F3 照旧)。
// - Alt-ArrowLeft / Alt-ArrowRight(Windows / Linux 上 = 按语法跳)→ 只在 mac 保留(mac 上本就是 ⌃← / ⌃→):Windows / Linux 的
//   Alt+← / Alt+→ 归后退 / 前进(workbench.action.navigateBack / navigateForward;BDD: src/__tests__/editor-navigation-history/);
//   ⇧Alt+← / ⇧Alt+→ 按语法选择保留。
// - 改由命令注册表分发的文本编辑命令(切换注释 / 移动行 / 选中行 / 折叠 …,ROUTED_KEYMAP_COMMANDS)→ 去掉其键:快捷键页可改键 /
//   解绑,按键经全局分发(when: editorTextFocus)执行;键表里留着就会抢先执行、改键无效。
// 只改 basicSetup 里那一份键表,其余扩展原样;用公开 API(EditorState.facet(keymap))按元素找出它,不依赖数组位置。
// BDD: src/__tests__/editor-goto-line/、src/__tests__/editor-navigation-history/、src/__tests__/editor-text-commands/

import { basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';
import { findNext, gotoLine } from '@codemirror/search';
import { cursorSyntaxLeft, cursorSyntaxRight } from '@codemirror/commands';
import { ROUTED_KEYMAP_COMMANDS } from './codemirror-text-commands';

/** 按上述规则改写 CodeMirror 键表(纯函数;未命中的绑定原样返回)。 */
export function withoutConflictingSearchKeys(bindings: readonly KeyBinding[]): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of bindings) {
    if (b.run === gotoLine) continue;
    if (b.run === findNext && b.key === 'Mod-g') {
      const { key: _key, ...rest } = b;
      out.push({ ...rest, mac: 'Mod-g' });
      continue;
    }
    out.push(b);
  }
  return out;
}

/** Alt-ArrowLeft / Alt-ArrowRight 的按语法跳只在 mac(⌃← / ⌃→)保留;其它平台只留 Shift 的按语法选择(纯函数)。 */
export function withoutAltArrowSyntaxKeys(bindings: readonly KeyBinding[]): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of bindings) {
    if ((b.run === cursorSyntaxLeft || b.run === cursorSyntaxRight) && b.key?.startsWith('Alt-')) {
      const { key, shift, ...rest } = b;
      out.push(shift ? { ...rest, shift } : rest);
      // 非 mac 的 ⇧Alt 按语法选择单列一条(mac 上与上一条的 Shift 变体同键同命令,不改 mac 行为)
      if (shift) out.push({ key: `Shift-${key}`, ...(b.mac ? { mac: `Shift-${b.mac}` } : {}), run: shift });
      continue;
    }
    out.push(b);
  }
  return out;
}

/** 去掉改由命令注册表分发的命令的键(纯函数)。 */
export function withoutRoutedTextCommandKeys(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.filter((b) => !(b.run && ROUTED_KEYMAP_COMMANDS.has(b.run)));
}

function bindingsOf(ext: Extension): readonly KeyBinding[] {
  return EditorState.create({ extensions: ext }).facet(keymap).flat();
}

function buildBasicSetup(): Extension {
  const parts = basicSetup as readonly Extension[];
  return parts.map((ext) => {
    const bindings = bindingsOf(ext);
    return bindings.some((b) => b.run === gotoLine)
      ? keymap.of(withoutRoutedTextCommandKeys(withoutAltArrowSyntaxKeys(withoutConflictingSearchKeys(bindings))))
      : ext;
  });
}

export const codeEditorBasicSetup: Extension = buildBasicSetup();
