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

describe('EditorHeader — 同名文件 tab 区分', () => {
  it('同名文件在文件名后用弱化色显示最短区分父路径;不重名的不显示', () => {
    const a = tab({ id: '/w/a/index.ts', filePath: '/w/a/index.ts' });
    const b = tab({ id: '/w/b/index.ts', filePath: '/w/b/index.ts' });
    const c = tab({ id: '/w/c.ts', filePath: '/w/c.ts' });
    useEditorStore.setState({ tabs: [a, b, c], activeTabId: a.id });
    const { container } = render(<EditorHeader onCloseRequest={vi.fn()} />);
    const tabs = Array.from(container.querySelectorAll('[role=tab]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['index.tsa', 'index.tsb', 'c.ts']);
    const desc = tabs[0]!.querySelector('[data-testid="tab-description"]')!;
    expect(desc.textContent).toBe('a');
    expect(desc.className).toContain('text-fg-dim');
    expect(tabs[2]!.querySelector('[data-testid="tab-description"]')).toBeNull();
  });
});

describe('EditorHeader — tab 栏溢出', () => {
  it('tab 栏可横向滚动,两侧有 token 色渐隐遮罩(溢出提示)', () => {
    const a = tab({ id: '/a.md', filePath: '/a.md' });
    useEditorStore.setState({ tabs: [a], activeTabId: a.id });
    const { container } = render(<EditorHeader onCloseRequest={vi.fn()} />);
    const nav = container.querySelector('.wm-tab-nav') as HTMLElement;
    expect(nav.className).toContain('overflow-x-auto');
    const fades = container.querySelectorAll('[data-testid^="tab-overflow-fade-"]');
    expect(fades).toHaveLength(2);
    for (const f of fades) {
      expect(f.getAttribute('aria-hidden')).toBe('true');
      expect(f.className).toMatch(/from-canvas/);
    }
  });

  it('只在对应方向确有被遮住的内容时显示渐隐(scrollLeft / scrollWidth 驱动)', () => {
    const a = tab({ id: '/a.md', filePath: '/a.md' });
    useEditorStore.setState({ tabs: [a], activeTabId: a.id });
    const { container } = render(<EditorHeader onCloseRequest={vi.fn()} />);
    const nav = container.querySelector('.wm-tab-nav') as HTMLElement;
    const left = container.querySelector('[data-testid="tab-overflow-fade-start"]') as HTMLElement;
    const right = container.querySelector('[data-testid="tab-overflow-fade-end"]') as HTMLElement;
    // 不溢出:两侧都隐藏
    expect(left.className).toContain('opacity-0');
    expect(right.className).toContain('opacity-0');
    Object.defineProperty(nav, 'scrollWidth', { configurable: true, value: 1000 });
    Object.defineProperty(nav, 'clientWidth', { configurable: true, value: 300 });
    nav.scrollLeft = 0;
    act(() => {
      nav.dispatchEvent(new Event('scroll'));
    });
    expect(left.className).toContain('opacity-0');
    expect(right.className).not.toContain('opacity-0');
    nav.scrollLeft = 700;
    act(() => {
      nav.dispatchEvent(new Event('scroll'));
    });
    expect(left.className).not.toContain('opacity-0');
    expect(right.className).toContain('opacity-0');
  });

  it('激活 tab 变化时滚入可见区(scrollIntoView nearest)', () => {
    const a = tab({ id: '/a.md', filePath: '/a.md' });
    const b = tab({ id: '/b.md', filePath: '/b.md' });
    useEditorStore.setState({ tabs: [a, b], activeTabId: a.id });
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      const { container } = render(<EditorHeader onCloseRequest={vi.fn()} />);
      spy.mockClear();
      act(() => useEditorStore.setState({ activeTabId: b.id }));
      expect(spy).toHaveBeenCalled();
      const target = spy.mock.contexts.at(-1) as Element;
      expect(target.closest('.wm-tab-nav-item')?.getAttribute('data-active')).toBe('true');
      expect(container.contains(target)).toBe(true);
      expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ block: 'nearest', inline: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
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
  // 模式切换行(EditorPanel 内、tab 行下方的 SegmentedControl) — EditorHeader 不再渲染它。
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

describe('EditorHeader — 鼠标点 tab 后焦点回到编辑区', () => {
  // VSCode:点编辑器 tab 即聚焦该编辑器,可直接继续输入。否则焦点停在 tab 上,用户接着打字按键落在 tab。
  function renderWithEditor() {
    const a = tab({ id: '/a.ts', filePath: '/a.ts' });
    const b = tab({ id: '/b.ts', filePath: '/b.ts' });
    useEditorStore.setState({ tabs: [a, b], activeTabId: a.id });
    return render(
      <div>
        <EditorHeader onCloseRequest={vi.fn()} />
        <div className="cm-content" contentEditable="true" suppressContentEditableWarning data-testid="editor" />
      </div>,
    );
  }

  it('鼠标点击 tab(含已激活 tab)→ 下一帧焦点进入编辑区可编辑元素', async () => {
    const { container, getByTestId } = renderWithEditor();
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role=tab]');
    for (const t of [tabs[1]!, tabs[0]!]) {
      t.focus();
      fireEvent.click(t, { detail: 1, button: 0 });
      await act(async () => {
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
      });
      expect(document.activeElement).toBe(getByTestId('editor'));
    }
    expect(useEditorStore.getState().activeTabId).toBe('/a.ts');
  });

  it('键盘激活(Enter / Space 合成 click,detail=0)→ 焦点留在 tab', async () => {
    const { container } = renderWithEditor();
    const t = container.querySelectorAll<HTMLButtonElement>('[role=tab]')[1]!;
    t.focus();
    fireEvent.click(t, { detail: 0, button: 0 });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    });
    expect(document.activeElement).toBe(t);
    expect(useEditorStore.getState().activeTabId).toBe('/b.ts');
  });
});
