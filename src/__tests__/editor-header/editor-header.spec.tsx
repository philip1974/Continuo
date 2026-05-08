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
        activeTab={null}
        autoSaveEnabled={false}
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
        activeTab={t}
        autoSaveEnabled={false}
        onCloseRequest={vi.fn()}
      />,
    );
    const tablist = container.querySelector('[role=tablist]');
    expect(tablist).not.toBeNull();
    // 唯一 TabNavItem 必须是收紧的(flex-shrink:0 + max-width),不撑满
    expect(tablist?.querySelectorAll('[role=tab]').length).toBe(1);
    expect(container.textContent).toContain('x.md');
  });

  it('tabs=2 → TabNav 列出每个 basename', () => {
    const a = tab({ id: '/a.md', filePath: '/a.md' });
    const b = tab({ id: '/b.md', filePath: '/b.md' });
    useEditorStore.setState({ tabs: [a, b], activeTabId: a.id });
    const { container } = render(
      <EditorHeader
        activeTab={a}
        autoSaveEnabled={false}
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.querySelector('[role=tablist]')).not.toBeNull();
    expect(container.textContent).toContain('a.md');
    expect(container.textContent).toContain('b.md');
  });
});

describe('EditorHeader — 与 VSCode 对齐:无保存按钮', () => {
  // 不论 autoSaveEnabled 真假、dirty 真假,都不显示文字「保存」按钮 — dirty
  // 由文件名旁的 ● 指示,保存走 ⌘S(EditorPanel keydown 已挂)。
  for (const autoSaveEnabled of [true, false] as const) {
    for (const dirty of [true, false]) {
      it(`autoSaveEnabled=${autoSaveEnabled} + dirty=${dirty} → 不显「保存」按钮`, () => {
        const t = tab({ dirty });
        useEditorStore.setState({ tabs: [t], activeTabId: t.id });
        const { container } = render(
          <EditorHeader
            activeTab={t}
            autoSaveEnabled={autoSaveEnabled}
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
  }

  it('autoSaveEnabled=true → 显示 mode SegmentedControl(Edit/Source/Preview)', () => {
    const t = tab({ dirty: true });
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const { container } = render(
      <EditorHeader
        activeTab={t}
        autoSaveEnabled={true}
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).toContain('Source');
    expect(container.textContent).toContain('Preview');
  });
});

describe('EditorHeader — 单 tab close', () => {
  it('TabNavItem 自带的 close 调 onCloseRequest(tab)', () => {
    const t = tab({ id: '/x.md', filePath: '/x.md' });
    useEditorStore.setState({ tabs: [t], activeTabId: t.id });
    const onCloseRequest = vi.fn();
    const { container } = render(
      <EditorHeader
        activeTab={t}
        autoSaveEnabled={false}
        onCloseRequest={onCloseRequest}
      />,
    );
    // TabNavItem close button:aria-label="Close <title>"
    const closeBtn = container.querySelector(
      'button[aria-label="Close /x.md"]',
    ) as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);
    expect(onCloseRequest).toHaveBeenCalledWith(t);
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
        activeTab={t}
        autoSaveEnabled={false}
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
        activeTab={t}
        autoSaveEnabled={false}
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
        activeTab={t}
        autoSaveEnabled={false}
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
        activeTab={t}
        autoSaveEnabled={false}
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
        activeTab={t}
        autoSaveEnabled={false}
        onCloseRequest={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('未命名');
  });
});
