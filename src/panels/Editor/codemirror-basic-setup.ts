// CodeEditor 用的 basicSetup:CodeMirror 的 basicSetup 去掉与 VSCode 键位冲突的查找键(codemirror 包的文档即建议按需改写它)。
// - Mod-Alt-g(⌘⌥G / Ctrl+Alt+G)= CodeMirror 自带的「转到行」小面板 → 去掉:转到行是工作台命令 workbench.action.gotoLine(⌃G,
//   经 Quick Open `:`),两套入口行为不一致;
// - Alt-ArrowLeft / Alt-ArrowRight(Windows / Linux 上 = 按语法跳)→ 只在 mac 保留(mac 上本就是 ⌃← / ⌃→):Windows / Linux 的
//   Alt+← / Alt+→ 归后退 / 前进(workbench.action.navigateBack / navigateForward;BDD: src/__tests__/editor-navigation-history/)。
//   其 Shift 变体(按语法选择:mac ⌃⇧← / ⌃⇧→,其它 ⇧Alt+← / ⇧Alt+→)去掉:VSCode 里这两组键是扩展 / 收缩选区
//   (editor.action.smartSelect.*,经注册表分发;BDD: src/__tests__/editor-language-commands/)。
// - 改由命令注册表分发的文本编辑命令(切换注释 / 移动行 / 选中行 / 折叠 …,ROUTED_KEYMAP_COMMANDS)→ 去掉其键:快捷键页可改键 /
//   解绑,按键经全局分发(when: editorTextFocus)执行;键表里留着就会抢先执行、改键无效。查找 ⌘F、查找下一个 / 上一个
//   ⌘G / ⇧⌘G / F3 / ⇧F3 同样去掉(when: editorFocus,查找面板里也经注册表;Windows / Linux 的 Ctrl+G 归转到行,
//   查找下一个是 F3,见 editor-text-commands)。Esc 关闭查找面板留在键表。
// - 鼠标多光标修饰键对齐 VSCode(editor.multiCursorModifier 默认 alt):⌥ 单击添加光标(⌥ 拖动添加一段选区),⌘ / Ctrl 单击不再
//   加光标(留给打开链接);列选择改为 ⇧⌥ 拖动(CodeMirror 默认 ⌥ 拖动,会把 ⌥ 单击当成单点列选择、清掉其它光标);去掉按住 ⌥
//   显示十字光标(那是 CodeMirror 列选择的提示,VSCode 没有)。BDD: src/__tests__/editor-mouse-multicursor/
// 只改 basicSetup 里那一份键表与列选择,其余扩展原样;用公开 API(EditorState.facet)按元素找出它们(键表含 gotoLine、列选择提供
// mouseSelectionStyle),不依赖数组下标;十字光标是紧随列选择的配套元素(codemirror 包的固定搭配,另以 contentAttributes 核对)。
// BDD: src/__tests__/editor-goto-line/、src/__tests__/editor-navigation-history/、src/__tests__/editor-text-commands/、
// src/__tests__/editor-find-keybindings/

import { basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, rectangularSelection, type KeyBinding } from '@codemirror/view';
import { gotoLine } from '@codemirror/search';
import { cursorSyntaxLeft, cursorSyntaxRight } from '@codemirror/commands';
import { ROUTED_KEYMAP_COMMANDS } from './codemirror-text-commands';

/** 去掉 CodeMirror 自带的转到行小面板(纯函数;其余绑定原样返回)。 */
export function withoutConflictingSearchKeys(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.filter((b) => b.run !== gotoLine);
}

/** Alt-ArrowLeft / Alt-ArrowRight 的按语法跳只在 mac(⌃← / ⌃→)保留;按语法选择(Shift 变体)让给扩展 / 收缩选区(纯函数)。 */
export function withoutAltArrowSyntaxKeys(bindings: readonly KeyBinding[]): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of bindings) {
    if ((b.run === cursorSyntaxLeft || b.run === cursorSyntaxRight) && b.key?.startsWith('Alt-')) {
      const { key: _key, shift: _shift, ...rest } = b;
      out.push(rest);
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

/** VSCode multiCursorModifier = alt:⌥ 单击 / 拖动添加光标 / 选区;⇧⌥ 拖动列选择。 */
const addsSelectionRange = (e: MouseEvent): boolean => e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey;
const isColumnSelectDrag = (e: MouseEvent): boolean => e.button === 0 && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey;

const multiCursorMouse: Extension = [
  EditorView.clickAddsSelectionRange.of(addsSelectionRange),
  rectangularSelection({ eventFilter: isColumnSelectDrag }),
];

/** 是否 basicSetup 的列选择(rectangularSelection:唯一提供 mouseSelectionStyle 的元素)。 */
function isRectangularSelection(ext: Extension): boolean {
  return EditorState.create({ extensions: ext }).facet(EditorView.mouseSelectionStyle).length > 0;
}

function buildBasicSetup(): Extension {
  const parts = basicSetup as readonly Extension[];
  const out: Extension[] = [];
  for (let i = 0; i < parts.length; i++) {
    const ext = parts[i]!;
    if (isRectangularSelection(ext)) {
      // 紧随其后的是配套的 crosshairCursor(按住 ⌥ 显示十字光标,只提供 contentAttributes;codemirror 包 basicSetup 的固定搭配)
      const next = parts[i + 1];
      if (next !== undefined && EditorState.create({ extensions: next }).facet(EditorView.contentAttributes).length > 0) i++;
      out.push(multiCursorMouse);
      continue;
    }
    const bindings = bindingsOf(ext);
    out.push(
      bindings.some((b) => b.run === gotoLine)
        ? keymap.of(withoutRoutedTextCommandKeys(withoutAltArrowSyntaxKeys(withoutConflictingSearchKeys(bindings))))
        : ext,
    );
  }
  return out;
}

export const codeEditorBasicSetup: Extension = buildBasicSetup();
