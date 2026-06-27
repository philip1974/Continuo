// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { EditorHeader } from '../../panels/Editor/EditorHeader';
import {
  useEditorStore,
  type EditorTab,
} from '../../stores/editor.store';
import { coApp } from '../../plugins/co-app';
import { EditorActionRegistry } from '../../plugins/registries/EditorActionRegistry';

function tab(over: Partial<EditorTab>): EditorTab {
  return {
    id: '/x.md',
    filePath: '/x.md',
    content: '',
    originalContent: '',
    dirty: false,
    ...over,
  };
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null, mode: 'edit' });
  // 隔离 editorActions registry
  (coApp as { editorActions: EditorActionRegistry }).editorActions =
    new EditorActionRegistry();
});

afterEach(() => cleanup());

describe('EditorHeader — tab 数量', () => {
  it('tabs=0 → 不渲染', () => {
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('tabs=1 → 也走 TabNav(VSCode 对齐:单 tab 不撑满整行)', () => {
    const t = tab({ id: '/x.md', filePath: '/x.md' });
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    const tablist = container.querySelector('[role=tablist]');
    expect(tablist).not.toBeNull();
    // 唯一 TabNavItem 必须是收紧的(flex-shrink:0 + max-width),不撑满
    expect(tablist?.querySelectorAll('[role=tab]').length).toBe(1);
    expect(container.textContent).toContain('x.md');
    // a11y(A107):tablist 有本地化可访问名(默认 locale=zh → 「编辑器标签」)。
    expect((tablist!.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
  });

  it('tabs=2 → TabNav 列出每个 basename', () => {
    const a = tab({ id: '/a.md', filePath: '/a.md' });
    const b = tab({ id: '/b.md', filePath: '/b.md' });
    useEditorStore.setState({ tabs: [a, b], activeTabId: a.id });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.querySelector('[role=tablist]')).not.toBeNull();
    expect(container.textContent).toContain('a.md');
    expect(container.textContent).toContain('b.md');
  });
});

describe('EditorHeader — 与 VSCode 对齐:无保存按钮 + 不再持有 mode 切换', () => {
  // dirty 真假都不显示文字「保存」按钮 — dirty 由文件名旁的 ● 指示,
  // 保存走 ⌘S(EditorPanel keydown 已挂)。
  for (const dirty of [true, false]) {
    it(`dirty=${dirty} → 不显「保存」按钮`, () => {
      const t = tab({ dirty });
      useEditorStore.setState({ tabs: [t], activeTabId: t.id });
      const { container } = render(
        <EditorHeader
          onCloseRequest={vi.fn()}
        />,
      );
      expect(
        Array.from(
          container.querySelectorAll<HTMLButtonElement>('button'),
        ).some((b) => b.textContent === '保存'),
      ).toBe(false);
    });
  }

  // mode SegmentedControl(Edit/Source/Preview)已搬到 EditorPanel 中的
  // EditorModeBar(tab 行下方独立一行) — EditorHeader 不再渲染它。
  it('EditorHeader 内不再渲染 Edit/Source/Preview 切换', () => {
    const t = tab({ dirty: true });
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    const labels = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).map((b) => b.textContent);
    expect(labels).not.toContain('Edit');
    expect(labels).not.toContain('Source');
    expect(labels).not.toContain('Preview');
  });
});

describe('EditorHeader — 单 tab close', () => {
  it('TabNavItem 自带的 close 调 onCloseRequest(tab)', () => {
    const t = tab({ id: '/x.md', filePath: '/x.md' });
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const onCloseRequest = vi.fn();
    const { container } = render(
      <EditorHeader
        onCloseRequest={onCloseRequest}
      />,
    );
    // a11y(A106):close 按钮 aria-label 经 closeLabel 本地化(默认 locale=zh → 「关闭 x.md」,
    // title=basename);用子串匹配定位,locale-健壮。
    const closeBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label]'),
    ).find((b) => (b.getAttribute('aria-label') ?? '').includes('x.md'))!;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    expect(onCloseRequest).toHaveBeenCalledWith({
      id: '/x.md',
      filePath: '/x.md',
      dirty: false,
    });
  });
});

describe('EditorHeader — 插件 editor action', () => {
  it('注册带 icon 的 action → 渲染 IconButton + 点击调 fn', () => {
    const t = tab({});
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const fn = vi.fn();
    coApp.editorActions.register({
      id: 'plugin.preview',
      label: '预览',
      icon: <span data-testid="action-icon">▶</span>,
      fn,
    });
    const { container, getByTestId } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    expect(getByTestId('action-icon')).toBeDefined();
    const iconBtn = container.querySelector(
      'button[aria-label=预览]',
    ) as HTMLButtonElement;
    fireEvent.click(iconBtn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('注册无 icon action → ghost Button(label 文案)', () => {
    const t = tab({});
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const fn = vi.fn();
    coApp.editorActions.register({
      id: 'plugin.fmt',
      label: '格式化',
      fn,
    });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    const btn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent === '格式化')!;
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('when 谓词返 false → 不渲染', () => {
    const t = tab({});
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    coApp.editorActions.register({
      id: 'plugin.x',
      label: '隐藏的',
      when: () => false,
      fn: vi.fn(),
    });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain('隐藏的');
  });

  it('subscribe → 后注册的 action 立即出现', () => {
    const t = tab({});
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain('动态');
    act(() => {
      coApp.editorActions.register({
        id: 'plugin.z',
        label: '动态',
        fn: vi.fn(),
      });
    });
    expect(container.textContent).toContain('动态');
  });
});

describe('EditorHeader — basename 兜底', () => {
  it('filePath=null → 「未命名」', () => {
    const t = tab({ id: 'untitled-1', filePath: null });
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const { container } = render(
      <EditorHeader
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('未命名');
  });
});
