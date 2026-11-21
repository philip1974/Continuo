// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    // 保存快捷键按平台渲染:mac → ⌘S,非 mac → Ctrl+S。固定 mac 验证 ⌘。
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    try {
      const { container } = render(<EditorWelcome />);
      expect(container.textContent).toContain(t('editor.welcome.title'));
      expect(container.textContent).toContain(t('editor.welcome.hint_prefix'));
      expect(container.textContent).toContain(t('editor.welcome.save'));
      expect(container.textContent).toContain('⌘');
      expect(container.textContent).toContain('S');
      expect(
        container.querySelector('[aria-hidden="true"] svg'),
      ).not.toBeNull();
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    }
  });

  it('保存快捷键 parts 按 mount memoize,不在每次 render 直接 detectPlatform', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/EditorWelcome.tsx'), 'utf8');

    expect(src).toContain('const saveHotkeyParts = useMemo(');
    expect(src).toContain('saveHotkeyParts.map');
    expect(src).not.toContain("formatHotkeyParts('mod+s', detectPlatform()).map");
  });

  it('装饰 document icon 预创建,不随 render 重建 svg element', () => {
    const src = readFileSync(join(process.cwd(), 'src/panels/Editor/EditorWelcome.tsx'), 'utf8');

    expect(src).toContain('const DOCUMENT_ICON = (');
    expect(src).toContain('{DOCUMENT_ICON}');
  });

  it('非 mac 平台:保存提示渲染 Ctrl+S(不含 ⌘,跨平台审计 P2)', () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, 'platform');
    Object.defineProperty(navigator, 'platform', {
      value: 'Linux x86_64',
      configurable: true,
    });
    try {
      const { container } = render(<EditorWelcome />);
      expect(container.textContent).toContain('Ctrl');
      expect(container.textContent).not.toContain('⌘');
    } finally {
      if (orig) Object.defineProperty(navigator, 'platform', orig);
    }
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
