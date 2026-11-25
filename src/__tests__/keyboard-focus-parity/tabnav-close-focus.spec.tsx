// @vitest-environment jsdom
// BDD:点 TabNav 关闭按钮不抢焦点(VSCode:点背景 tab 的 × 活动编辑器保持焦点)。见同目录 README 第 3 条。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { TabNav, TabNavItem } from '@/design';

afterEach(() => cleanup());

function mount() {
  const onClose = vi.fn();
  render(
    <>
      <TabNav>
        <TabNavItem active onSelect={() => {}} onClose={() => {}} closeLabel="close-a">
          a
        </TabNavItem>
        <TabNavItem onSelect={() => {}} onClose={onClose} closeLabel="close-b">
          b
        </TabNavItem>
      </TabNav>
      <textarea aria-label="editor" />
    </>,
  );
  return { onClose, close: screen.getByRole('button', { name: 'close-b' }) };
}

describe('TabNav 关闭按钮不抢焦点', () => {
  it.each(['pointerDown', 'mouseDown'] as const)('%s 默认动作被阻止(不把焦点移到按钮上)', (type) => {
    const { close } = mount();
    const event = createEvent[type](close, { button: 0 });
    fireEvent(close, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('点击仍关闭该 tab,编辑器保持焦点', () => {
    const { close, onClose } = mount();
    const editor = screen.getByRole('textbox', { name: 'editor' });
    editor.focus();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor);
  });
});
