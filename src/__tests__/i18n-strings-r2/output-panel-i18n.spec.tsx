// @vitest-environment jsdom
// i18n(I15):Output 面板文案走 panels.output.* catalog + useT(zh / ko 不显英文)。面板目前没有任何写入方,
// 只显示空状态 —— 不再写死「Continuo 就绪 / 已恢复停靠布局」两行假日志(首启默认布局时「已恢复」也不实)。

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Output } from '../../panels/Output';
import { setLocale } from '@/i18n';

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('i18n I15 · Output 面板文案本地化', () => {
  it('locale=zh → 显中文空状态,无假日志', () => {
    setLocale('zh');
    const { container } = render(<Output />);
    expect(container.textContent).toBe('暂无输出。');
  });

  it('locale=en → 显英文空状态,无假日志', () => {
    setLocale('en');
    const { container } = render(<Output />);
    expect(container.textContent).toBe('No output yet.');
    expect(container.textContent).not.toContain('dock layout restored');
  });

  // 与 Debug 等相邻面板同一空态(design EmptyState,居中、正文字体),不再是左上角等宽字。
  it('空状态用 design EmptyState', () => {
    const { container } = render(<Output />);
    const empty = container.querySelector<HTMLElement>('.wm-empty-state');
    expect(empty?.textContent).toBe('No output yet.');
    expect(container.querySelector('.font-mono')).toBeNull();
  });
});
