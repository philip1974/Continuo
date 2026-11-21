// @vitest-environment jsdom
// i18n(I15,I14 同类硬编码 UI):Output 面板状态文案此前硬编码英文 '[info] Continuo ready' /
// '[info] dock layout restored',zh/ko 显英文。改用 panels.output.* catalog + useT 渲染。

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Output } from '../../panels/Output';
import { setLocale } from '@/i18n';

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('i18n I15 · Output 面板状态文案本地化', () => {
  it('locale=zh → 显中文状态文案(不是硬编码英文)', () => {
    setLocale('zh');
    const { container } = render(<Output />);
    expect(container.textContent).toContain('Continuo 就绪');
    expect(container.textContent).toContain('已恢复停靠布局');
    expect(container.textContent).not.toContain('dock layout restored');
  });

  it('locale=en → 显英文状态文案', () => {
    setLocale('en');
    const { container } = render(<Output />);
    expect(container.textContent).toContain('Continuo ready');
    expect(container.textContent).toContain('dock layout restored');
  });
});
