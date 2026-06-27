// @vitest-environment jsdom
// a11y(A152):Markdown 预览里 Cmd/Ctrl+click 跳转链接的键盘等价 —— Cmd/Ctrl+Enter。键盘用户
// 无法用鼠标修饰键点击;handleKeyDown 在 <a href> 上 Cmd/Ctrl+Enter → onLinkClick(href)。
import React from 'react';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {},
  Crepe: vi.fn().mockImplementation(() => ({
    setReadonly: vi.fn(),
    on: () => {},
  })),
}));
vi.mock('@milkdown/react', () => ({
  Milkdown: () => <div data-testid="milkdown" />,
  MilkdownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEditor: (init: (root: HTMLElement) => unknown) => {
    init(document.createElement('div'));
  },
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

afterEach(() => cleanup());

describe('a11y(A152) — Markdown 链接键盘激活(Cmd/Ctrl+Enter)', () => {
  function setup() {
    const onLinkClick = vi.fn();
    const { container } = render(
      <MilkdownEditor defaultValue="x" readonly onLinkClick={onLinkClick} />,
    );
    // 包裹 div 是 onKeyDown 宿主(.overflow-auto)。注入一个真实 <a> 模拟渲染出的 markdown link。
    const wrapper = container.querySelector('.overflow-auto') as HTMLElement;
    const a = document.createElement('a');
    a.setAttribute('href', './doc.md');
    a.textContent = 'link';
    wrapper.appendChild(a);
    return { onLinkClick, wrapper, a };
  }

  it('Cmd+Enter on <a> → onLinkClick(href)', () => {
    const { onLinkClick, a } = setup();
    fireEvent.keyDown(a, { key: 'Enter', metaKey: true });
    expect(onLinkClick).toHaveBeenCalledWith('./doc.md');
  });

  it('Ctrl+Enter on <a> → onLinkClick(href)', () => {
    const { onLinkClick, a } = setup();
    fireEvent.keyDown(a, { key: 'Enter', ctrlKey: true });
    expect(onLinkClick).toHaveBeenCalledWith('./doc.md');
  });

  it('裸 Enter(无修饰键)→ 不触发(留给编辑换行)', () => {
    const { onLinkClick, a } = setup();
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(onLinkClick).not.toHaveBeenCalled();
  });

  it('Cmd+Enter 但不在链接上 → 不触发', () => {
    const { onLinkClick, wrapper } = setup();
    fireEvent.keyDown(wrapper, { key: 'Enter', metaKey: true });
    expect(onLinkClick).not.toHaveBeenCalled();
  });
});
