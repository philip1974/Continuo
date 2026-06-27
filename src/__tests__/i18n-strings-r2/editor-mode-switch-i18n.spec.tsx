// @vitest-environment jsdom
// i18n(I14):编辑器模式切换 Edit/Source/Preview 此前硬编码英文(MODE_OPTIONS 模块级常量),
// zh/ko 工具栏显英文且不随 locale 切换。改用 panels.editor.mode.* catalog,在组件内用 useT
// 生成 → 按当前 locale 本地化、切 locale 重渲更新。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { setLocale } from '@/i18n';

vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => <div>{value}</div>,
}));
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

beforeEach(() => {
  useEditorStore.setState({
    tabs: [
      {
        id: '/a.md',
        filePath: '/a.md',
        content: 'aaa',
        originalContent: 'aaa',
        dirty: false,
      },
    ],
    activeTabId: '/a.md',
    mode: 'edit',
  } as never);
});
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('i18n I14 · 编辑器模式切换 label 本地化', () => {
  it('locale=zh → 显中文模式名(不是硬编码英文)', () => {
    setLocale('zh');
    const { container } = render(<EditorPanel />);
    expect(container.textContent).toContain('编辑');
    expect(container.textContent).toContain('源码');
    expect(container.textContent).toContain('预览');
  });

  it('locale=en → 显英文模式名', () => {
    setLocale('en');
    const { container } = render(<EditorPanel />);
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).toContain('Source');
    expect(container.textContent).toContain('Preview');
  });

  // a11y(A22,A21 同族):模式切换 radiogroup 须有 group 名,否则 AT 只读一组 radio(编辑/
  // 源码/预览)不知是「编辑器模式」选择器。断言 aria-label 非空且随 locale 本地化。
  it('a11y · 模式 radiogroup 有本地化 group 名(aria-label)', () => {
    setLocale('zh');
    const { container } = render(<EditorPanel />);
    const group = container.querySelector('[role=radiogroup]');
    expect(group).not.toBeNull();
    expect(group!.getAttribute('aria-label')).toBe('编辑器模式');
  });
});
