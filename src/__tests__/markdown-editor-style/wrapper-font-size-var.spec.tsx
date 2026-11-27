// @vitest-environment jsdom
// Crepe 的代码块占位层(CodeMirror 懒创建 / 回收时显示)等部件按 --crepe-base-font-size 算字号,
// frame-dark 把它写死 16px → 字号设置不是 16 时,占位层与真实 CodeMirror 高度不同,滚动时跳变。
// MilkdownEditor 外层容器在设字号的同时写入该变量(覆写 CSS 让 .milkdown 继承它)。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@milkdown/crepe', () => ({
  CrepeFeature: {},
  Crepe: vi.fn().mockImplementation(() => ({ setReadonly: vi.fn(), editor: { config: () => {}, use: () => {}, remove: async () => {} }, on: () => {} })),
}));
vi.mock('@milkdown/react', () => ({
  Milkdown: () => <div data-testid="milkdown" />,
  MilkdownProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEditor: (init: (root: HTMLElement) => unknown) => {
    init(document.createElement('div'));
  },
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: () => 19,
}));

import { MilkdownEditor } from '../../panels/Editor/MilkdownEditor';

afterEach(() => cleanup());

it('外层容器的字号与 --crepe-base-font-size 都取 editor.fontSize', () => {
  const { container } = render(<MilkdownEditor tabId="/t.md" defaultValue="x" />);
  const wrapper = container.querySelector('.overflow-auto') as HTMLElement;
  expect(wrapper.style.fontSize).toBe('19px');
  expect(wrapper.style.getPropertyValue('--crepe-base-font-size')).toBe('19px');
});
