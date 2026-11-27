// @vitest-environment jsdom
// BDD:edit-context-menu —— 代码编辑器右键在所在文档 <html> 上打标记,main 读出并清除;下一次右键开始时清掉残留。见同目录 README。
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { codeEditorContextMenuMarker } from '@/panels/Editor/codemirror-context-menu';
import {
  EDITOR_CONTEXT_MENU_ATTR,
  READ_EDITOR_CONTEXT_MENU_SCRIPT,
} from '../../../electron/shared/editor-context-menu';

const views: EditorView[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute(EDITOR_CONTEXT_MENU_ATTR);
});

function mount(ext: Extension[] = []): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc: '{"a": 1}', extensions: [codeEditorContextMenuMarker, ...ext] }), parent });
  views.push(view);
  return view;
}

const rightClick = (el: Element) =>
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
const mark = () => document.documentElement.getAttribute(EDITOR_CONTEXT_MENU_ATTR);
// main 在 frame 里执行的同一段脚本(常量,读出并清除)
const readInFrame = (): unknown => (0, eval)(READ_EDITOR_CONTEXT_MENU_SCRIPT);

describe('代码编辑器右键标记', () => {
  it('纯文本 / 代码 → code;JSON(有格式化程序)→ code-format', () => {
    rightClick(mount().contentDOM);
    expect(mark()).toBe('code');
    rightClick(mount([json()]).contentDOM);
    expect(mark()).toBe('code-format');
  });

  it('main 的读取脚本:返回标记并清除', () => {
    rightClick(mount().contentDOM);
    expect(readInFrame()).toBe('code');
    expect(mark()).toBeNull();
    expect(readInFrame()).toBeNull();
  });

  it('未被取走的标记在下一次(编辑器外的)右键开始时清掉,不串到输入框的右键', () => {
    rightClick(mount().contentDOM);
    const input = document.createElement('input');
    document.body.appendChild(input);
    rightClick(input);
    expect(mark()).toBeNull();
  });

  it('右键已被别处接管(defaultPrevented)→ 不打标记', () => {
    const v = mount();
    v.contentDOM.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
    rightClick(v.contentDOM);
    expect(mark()).toBeNull();
  });
});

describe('更改所有匹配项命令(editor.action.changeAll)', () => {
  it('⌘F2 / Ctrl+F2,标题三语照抄 VSCode', async () => {
    const { EDITOR_TEXT_COMMANDS } = await import('@/panels/Editor/editor-text-commands');
    const { en } = await import('@shared/i18n-locales/en');
    const { zh } = await import('@shared/i18n-locales/zh');
    const { ko } = await import('@shared/i18n-locales/ko');
    expect(EDITOR_TEXT_COMMANDS.find((c) => c.id === 'editor.action.changeAll')).toMatchObject({ mac: 'mod+f2', key: 'change_all' });
    const k = 'commands.editor.text.change_all.title' as const;
    expect([en[k], zh[k], ko[k]]).toEqual(['Change All Occurrences', '更改所有匹配项', '모든 항목 변경']);
  });
});
