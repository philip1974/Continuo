// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EditorWelcome } from '../../panels/Editor/EditorWelcome';

afterEach(() => cleanup());

describe('EditorWelcome', () => {
  it('渲染标题、副提示、装饰 svg', () => {
    const { container } = render(<EditorWelcome />);
    expect(container.textContent).toContain('未打开文件');
    expect(container.textContent).toContain('在 Explorer 单击文件打开');
    expect(container.textContent).toContain('保存');
    // KeyCap ⌘ + S 都渲染为 <kbd> / 类似元素,文本至少包含字符
    expect(container.textContent).toContain('⌘');
    expect(container.textContent).toContain('S');
    expect(
      container.querySelector('[aria-hidden="true"] svg'),
    ).not.toBeNull();
  });
});
