// @vitest-environment jsdom
// BDD:把焦点交给编辑区 / 面板内容时不把视口拉到光标处(VSCode:切回编辑器、重启后恢复保存时的视口)。
// 见同目录 README.md。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { DockviewPanelApi } from 'dockview-react';
import { focusContentTarget, setContentFocusHandler } from '@/lib/content-focus-target';
import { focusPanelContent } from '@/shell/dock/panel-focus';
import { EditorHeader } from '@/panels/Editor/EditorHeader';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';

/** 编辑器的可编辑区,登记了编辑器自己的聚焦(view.focus())。直接 DOM focus 记为 domFocus。 */
function editorEditable(): { editable: HTMLElement; viewFocus: ReturnType<typeof vi.fn>; domFocus: ReturnType<typeof vi.fn> } {
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  const viewFocus = vi.fn(() => HTMLElement.prototype.focus.call(editable, { preventScroll: true }));
  const domFocus = vi.fn();
  editable.focus = domFocus;
  setContentFocusHandler(editable, viewFocus);
  return { editable, viewFocus, domFocus };
}

const nextFrame = () =>
  act(async () => {
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('focusContentTarget', () => {
  it('登记了编辑器自己的聚焦 → 用它,不直接 DOM focus', () => {
    const { editable, viewFocus, domFocus } = editorEditable();
    document.body.appendChild(editable);
    focusContentTarget(editable);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(domFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editable);
  });

  it('未登记(输入框、图片预览等)→ focus({ preventScroll: true })', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const spy = vi.spyOn(el, 'focus');
    focusContentTarget(el);
    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(el);
  });

  it('注销后退回 DOM focus;注销旧登记不影响同元素的新登记', () => {
    const el = document.createElement('div');
    el.tabIndex = 0;
    document.body.appendChild(el);
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = setContentFocusHandler(el, first);
    setContentFocusHandler(el, second);
    offFirst();
    focusContentTarget(el);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('点 dock tab / F6 / 关闭后回落:focusPanelContent', () => {
  it('落点是编辑器可编辑区 → 走编辑器自己的聚焦', () => {
    const { editable, viewFocus, domFocus } = editorEditable();
    const content = document.createElement('div');
    content.appendChild(editable);
    document.body.appendChild(content);
    const api = {
      id: 'editor',
      group: { panels: [{ id: 'editor', view: { content: { element: content } } }] },
    } as unknown as DockviewPanelApi;
    focusPanelContent(api);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(domFocus).not.toHaveBeenCalled();
  });
});

describe('鼠标点编辑器 tab:EditorHeader', () => {
  function tab(id: string): EditorTab {
    return { id, filePath: id, content: '', originalContent: '', dirty: false };
  }

  beforeEach(() => {
    useEditorStore.setState({ tabs: [tab('/a.md'), tab('/b.md')], activeTabId: '/a.md' });
  });

  it('下一帧经编辑器自己的聚焦进入编辑区', async () => {
    const { container } = render(
      <div>
        <EditorHeader onCloseRequest={vi.fn()} />
      </div>,
    );
    const { editable, viewFocus, domFocus } = editorEditable();
    container.firstElementChild!.appendChild(editable);
    const t = container.querySelectorAll<HTMLElement>('[role=tab]')[1]!;
    t.focus();
    fireEvent.click(t, { detail: 1, button: 0 });
    await nextFrame();
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(domFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editable);
  });
});
