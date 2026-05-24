// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { setLocale, t } from '@/i18n';
import { EditorWelcome } from '../../panels/Editor/EditorWelcome';

afterEach(() => cleanup());

describe('EditorWelcome', () => {
  beforeEach(() => {
    // 测试隔离:重置成默认 locale 'zh',然后逐 case 显式切换。
    setLocale('zh');
  });

  it('渲染标题、副提示、装饰 svg(默认 zh locale)', () => {
    const { container } = render(<EditorWelcome />);
    expect(container.textContent).toContain(t('editor.welcome.title'));
    expect(container.textContent).toContain(t('editor.welcome.hint_prefix'));
    expect(container.textContent).toContain(t('editor.welcome.save'));
    expect(container.textContent).toContain('⌘');
    expect(container.textContent).toContain('S');
    expect(
      container.querySelector('[aria-hidden="true"] svg'),
    ).not.toBeNull();
  });

  it('切到 en locale 后渲染英文文案(not 中文)', () => {
    setLocale('en');
    const { container } = render(<EditorWelcome />);
    expect(container.textContent).toContain('No file open');
    expect(container.textContent).not.toContain('未打开文件');
  });

  it('切到 ko locale 后渲染韩文文案', () => {
    setLocale('ko');
    const { container } = render(<EditorWelcome />);
    expect(container.textContent).toContain('열린 파일 없음');
  });
});
