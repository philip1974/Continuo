// @vitest-environment jsdom
// BDD:保存冲突差异视图(真实 @codemirror/merge)。见同目录 README 契约 3。
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { getOriginalDoc } from '@codemirror/merge';
import { useEditorStore } from '@/stores/editor.store';
import { ConflictDiffPanel } from '@/panels/Editor/ConflictDiffPanel';
import { CONFLICT_DIFF_TITLE_KEY } from '@/panels/Editor/conflict-diff-constants';
import { CONFLICT_DIFF_MAX_CHARS } from '@/panels/Editor/conflict-diff-model';
import { ThemeContext } from '@/theme/ThemeProvider';
import { setLocale, t } from '@/i18n';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  dirListeners: [] as Array<(dir: string, files?: readonly string[]) => void>,
  announce: vi.fn(),
  resolveConflict: vi.fn(async () => true),
}));

vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: mocks.readFile,
      onDirChanged: (cb: (dir: string, files?: readonly string[]) => void) => {
        mocks.dirListeners.push(cb);
        return () => {
          mocks.dirListeners.splice(mocks.dirListeners.indexOf(cb), 1);
        };
      },
    },
  },
}));
vi.mock('@/lib/announce', () => ({ announce: mocks.announce }));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('@/panels/Editor/conflict-compare', () => ({ resolveConflict: mocks.resolveConflict }));

const PATH = '/work/conflict.txt';
const DISK = 'alpha\nbeta\ngamma\ndelta\n';
const MINE = 'alpha\nBETA\ngamma\ndelta\nepsilon\n';

function setTab(path: string, content: string) {
  useEditorStore.setState({
    tabs: [{ id: path, filePath: path, content, originalContent: 'orig', dirty: true }],
    activeTabId: path,
  });
}

function renderPanel(path = PATH) {
  const params = { tabId: path, groupId: 'editor', titleKey: CONFLICT_DIFF_TITLE_KEY, titleArgs: { name: 'x' } } as const;
  return render(
    <ThemeContext.Provider value={{ mode: 'dark', resolved: 'dark', setMode: () => {} }}>
      <ConflictDiffPanel params={params} />
    </ThemeContext.Provider>,
  );
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const side = (s: 'a' | 'b') => document.querySelector<HTMLElement>(`.cm-merge-${s}`)!;
const viewOf = (s: 'a' | 'b') => EditorView.findFromDOM(side(s))!;
const docOf = (s: 'a' | 'b') => viewOf(s).state.doc.toString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dirListeners.length = 0;
  setLocale('zh');
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  mocks.readFile.mockResolvedValue({ ok: true, data: DISK });
  setTab(PATH, MINE);
});
afterEach(() => cleanup());

describe('两侧内容与高亮', () => {
  it('左 = 磁盘版本(只读),右 = 你的版本;逐行与行内差异高亮;读屏名称', async () => {
    renderPanel();
    await flush();
    expect(mocks.readFile).toHaveBeenCalledWith(PATH);
    expect(docOf('a')).toBe(DISK);
    expect(docOf('b')).toBe(MINE);
    expect(viewOf('a').state.readOnly).toBe(true);
    expect(viewOf('b').state.readOnly).toBe(false);
    expect(side('a').querySelectorAll('.cm-changedLine').length).toBeGreaterThan(0);
    expect(side('b').querySelectorAll('.cm-changedLine').length).toBeGreaterThan(0);
    expect(side('b').querySelector('.cm-changedText')).not.toBeNull();
    expect(side('a').querySelector('.cm-content')!.getAttribute('aria-label')).toBe(
      'conflict.txt（在磁盘上，只读），编辑器',
    );
    expect(side('b').querySelector('.cm-content')!.getAttribute('aria-label')).toBe('conflict.txt（你的版本），编辑器');
    expect(screen.getByRole('toolbar', { name: t('panels.editor.conflict_diff.toolbar') })).toBeTruthy();
    expect(screen.getByText('2 处差异')).toBeTruthy();
  });

  it('右侧输入即改原 tab;原 tab 的修改同步到右侧', async () => {
    renderPanel();
    await flush();
    act(() => {
      viewOf('b').dispatch({ changes: { from: 0, insert: 'zero\n' } });
    });
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: `zero\n${MINE}`, dirty: true });
    act(() => {
      useEditorStore.getState().updateContent(PATH, 'from tab\n');
    });
    expect(docOf('b')).toBe('from tab\n');
  });

  it('CRLF 文档:右侧输入回写时保持 CRLF', async () => {
    setTab(PATH, 'a\r\nb\r\n');
    renderPanel();
    await flush();
    act(() => {
      viewOf('b').dispatch({ changes: { from: 0, insert: 'x' } });
    });
    expect(useEditorStore.getState().tabs[0]?.content).toBe('xa\r\nb\r\n');
  });
});

describe('磁盘再次变化 → 左侧更新', () => {
  it('dir-changed 命中该文件 → 重读;别的文件不重读', async () => {
    renderPanel();
    await flush();
    mocks.readFile.mockResolvedValue({ ok: true, data: 'changed again\n' });
    await act(async () => {
      for (const l of [...mocks.dirListeners]) l('/work', ['other.txt']);
    });
    await flush();
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      for (const l of [...mocks.dirListeners]) l('/work', ['conflict.txt']);
    });
    await flush();
    expect(mocks.readFile).toHaveBeenCalledTimes(2);
    expect(docOf('a')).toBe('changed again\n');
    // 右侧不受影响
    expect(docOf('b')).toBe(MINE);
  });

  it('读磁盘失败 → 提示原因', async () => {
    mocks.readFile.mockResolvedValue({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    renderPanel();
    await flush();
    expect(screen.getByRole('status').textContent).toContain('无法读取磁盘上的文件');
  });
});

describe('差异导航', () => {
  it('下一处 / 上一处:跳到差异块、读屏播报位置与行号,工具栏显示第几处', async () => {
    renderPanel();
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.next') }));
    });
    expect(mocks.announce).toHaveBeenLastCalledWith('第 1 处差异，共 2 处，第 2 行', expect.anything());
    expect(screen.getByText('第 1 处差异，共 2 处')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.next') }));
    });
    expect(mocks.announce).toHaveBeenLastCalledWith('第 2 处差异，共 2 处，第 5 行', expect.anything());
    // 循环:再下一处回到第 1 处;上一处回到第 2 处
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.next') }));
    });
    expect(mocks.announce).toHaveBeenLastCalledWith('第 1 处差异，共 2 处，第 2 行', expect.anything());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.previous') }));
    });
    expect(mocks.announce).toHaveBeenLastCalledWith('第 2 处差异，共 2 处，第 5 行', expect.anything());
  });

  it('编辑器内 Alt+F5 = 下一处差异', async () => {
    renderPanel();
    await flush();
    const content = side('b').querySelector<HTMLElement>('.cm-content')!;
    await act(async () => {
      fireEvent.keyDown(content, { key: 'F5', code: 'F5', altKey: true });
    });
    expect(mocks.announce).toHaveBeenLastCalledWith('第 1 处差异，共 2 处，第 2 行', expect.anything());
  });

  it('两侧相同 → 没有差异,导航按钮禁用', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: MINE });
    renderPanel();
    await flush();
    expect(screen.getByText('没有差异')).toBeTruthy();
    expect((screen.getByRole('button', { name: t('panels.editor.conflict_diff.next') }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Markdown 与大文件', () => {
  it('Markdown 按源码文本比较', async () => {
    const md = '/work/notes.md';
    setTab(md, '# Title\n\n**mine**\n');
    mocks.readFile.mockResolvedValue({ ok: true, data: '# Title\n\n**theirs**\n' });
    renderPanel(md);
    await flush();
    expect(docOf('b')).toBe('# Title\n\n**mine**\n');
    expect(docOf('a')).toBe('# Title\n\n**theirs**\n');
    expect(document.querySelector('.milkdown')).toBeNull();
  });

  it('两侧合计超过上限 → 不计算差异,显示提示;动作按钮仍可用', async () => {
    mocks.readFile.mockResolvedValue({ ok: true, data: 'x'.repeat(CONFLICT_DIFF_MAX_CHARS) });
    renderPanel();
    await flush();
    expect(document.querySelector('.cm-mergeView')).toBeNull();
    expect(screen.getByText(t('panels.editor.conflict_diff.too_large'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('panels.editor.conflict_diff.accept') }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('工具栏动作', () => {
  it('接受我的版本 / 使用磁盘版本 → resolveConflict(tab, 组, accept / revert)', async () => {
    renderPanel();
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.accept') }));
    });
    expect(mocks.resolveConflict).toHaveBeenLastCalledWith(PATH, 'editor', 'accept');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.revert') }));
    });
    expect(mocks.resolveConflict).toHaveBeenLastCalledWith(PATH, 'editor', 'revert');
    expect(t('panels.editor.conflict_diff.accept')).toBe('接受我的版本（覆盖磁盘）');
    expect(t('panels.editor.conflict_diff.revert')).toBe('使用磁盘版本（放弃我的更改）');
  });

  it('params 缺失(非 openConflictCompare 打开)→ 不渲染、不读盘', async () => {
    const { container } = render(<ConflictDiffPanel />);
    await flush();
    expect(container.textContent).toBe('');
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('原 tab 已不在 → 不渲染', async () => {
    const { container } = renderPanel('/work/none.txt');
    await flush();
    expect(container.textContent).toBe('');
  });
});

describe('窄宽单栏内联(VSCode useInlineViewWhenSpaceIsLimited,宽 ≤ 900)', () => {
  // jsdom 无布局:差异区宽度由测试给,ResizeObserver 回调手动触发
  let width = 0;
  const observers: Array<() => void> = [];
  const realRect = Element.prototype.getBoundingClientRect;
  const realRO = globalThis.ResizeObserver;
  beforeEach(() => {
    width = 0;
    observers.length = 0;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this instanceof HTMLElement && this.hasAttribute('data-conflict-diff-body')) return new DOMRect(0, 0, width, 500);
      return realRect.call(this);
    };
    globalThis.ResizeObserver = class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        observers.push(this.cb);
      }
      unobserve() {}
      disconnect() {
        const i = observers.indexOf(this.cb);
        if (i >= 0) observers.splice(i, 1);
      }
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    globalThis.ResizeObserver = realRO;
  });
  const resize = (w: number) =>
    act(() => {
      width = w;
      for (const cb of [...observers]) cb();
    });

  it('宽 ≤ 900:单个可编辑编辑器 = 你的版本,磁盘版本被改掉的行以只读块显示;标题合成一行;导航照常', async () => {
    width = 600;
    renderPanel();
    await flush();
    expect(document.querySelector('.cm-mergeView')).toBeNull();
    expect(document.querySelector('.cm-merge-a')).toBeNull();
    expect(docOf('b')).toBe(MINE);
    expect(viewOf('b').state.readOnly).toBe(false);
    expect(getOriginalDoc(viewOf('b').state).toString()).toBe(DISK);
    expect(side('b').querySelector('.cm-deletedChunk')!.textContent).toContain('beta');
    // 无逐块接受 / 拒绝按钮(动作只在工具栏)
    expect(side('b').querySelector('.cm-chunkButtons')).toBeNull();
    expect(side('b').querySelector('.cm-content')!.getAttribute('aria-label')).toBe('conflict.txt（你的版本），编辑器');
    expect(screen.getByText('2 处差异')).toBeTruthy();
    expect(document.querySelector('[data-conflict-diff-sides]')!.textContent).toBe(
      `${t('panels.editor.conflict_diff.disk_side', { name: 'conflict.txt' })} ↔ ${t('panels.editor.conflict_diff.mine_side', { name: 'conflict.txt' })}`,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: t('panels.editor.conflict_diff.next') }));
    });
    expect(mocks.announce).toHaveBeenLastCalledWith('第 1 处差异，共 2 处，第 2 行', expect.anything());
  });

  it('宽度跨过阈值随之切换:你的版本内容(含未保存输入)/ 光标 / 焦点不丢,磁盘版本不变', async () => {
    width = 1200;
    renderPanel();
    await flush();
    expect(document.querySelector('.cm-mergeView')).not.toBeNull();
    act(() => {
      viewOf('b').dispatch({ changes: { from: 0, insert: 'typed\n' }, selection: { anchor: 3 } });
      viewOf('b').focus();
    });
    resize(700);
    expect(document.querySelector('.cm-mergeView')).toBeNull();
    expect(docOf('b')).toBe(`typed\n${MINE}`);
    expect(viewOf('b').state.selection.main.head).toBe(3);
    expect(viewOf('b').hasFocus).toBe(true);
    expect(getOriginalDoc(viewOf('b').state).toString()).toBe(DISK);
    // 内联时继续输入 → 原 tab
    act(() => {
      viewOf('b').dispatch({ changes: { from: 0, insert: 'more ' } });
    });
    expect(useEditorStore.getState().tabs[0]?.content).toBe(`more typed\n${MINE}`);
    resize(1000);
    expect(document.querySelector('.cm-mergeView')).not.toBeNull();
    expect(docOf('a')).toBe(DISK);
    expect(docOf('b')).toBe(`more typed\n${MINE}`);
    expect(viewOf('b').hasFocus).toBe(true);
    expect(useEditorStore.getState().tabs[0]?.content).toBe(`more typed\n${MINE}`);
  });

  it('宽度 0(dock tab 隐藏)不切换', async () => {
    width = 600;
    renderPanel();
    await flush();
    resize(0);
    expect(document.querySelector('.cm-mergeView')).toBeNull();
    expect(document.querySelector('.cm-deletedChunk')).not.toBeNull();
  });

  it('内联时磁盘再次变化 → 被删 / 改的只读块随之更新;CRLF 文档输入回写保持 CRLF', async () => {
    setTab(PATH, 'a\r\nb\r\n');
    mocks.readFile.mockResolvedValue({ ok: true, data: 'a\r\nOLD\r\n' });
    width = 500;
    renderPanel();
    await flush();
    expect(side('b').querySelector('.cm-deletedChunk')!.textContent).toContain('OLD');
    mocks.readFile.mockResolvedValue({ ok: true, data: 'a\r\nNEWER\r\n' });
    await act(async () => {
      for (const l of [...mocks.dirListeners]) l('/work', ['conflict.txt']);
    });
    await flush();
    expect(getOriginalDoc(viewOf('b').state).toString()).toBe('a\nNEWER\n');
    expect(side('b').querySelector('.cm-deletedChunk')!.textContent).toContain('NEWER');
    act(() => {
      viewOf('b').dispatch({ changes: { from: 0, insert: 'x' } });
    });
    expect(useEditorStore.getState().tabs[0]?.content).toBe('xa\r\nb\r\n');
  });
});

describe('工具栏窄宽', () => {
  it('工具栏可换行、按钮组靠右整体换到下一行;状态文字可截断;放不下时横向滚动而不是盖住代码', async () => {
    renderPanel();
    await flush();
    const bar = screen.getByRole('toolbar', { name: t('panels.editor.conflict_diff.toolbar') });
    expect(bar.className).toContain('flex-wrap');
    expect(bar.className).toContain('overflow-x-auto');
    expect(bar.className).not.toMatch(/(^|\s)h-9(\s|$)/);
    const accept = screen.getByRole('button', { name: t('panels.editor.conflict_diff.accept') });
    const group = accept.parentElement!;
    expect(group).toContain(screen.getByRole('button', { name: t('panels.editor.conflict_diff.revert') }));
    expect(group.className).toContain('ml-auto');
    expect(group.className).toContain('flex-wrap');
    expect(screen.getByText('2 处差异').className).toContain('truncate');
  });
});

// React 未使用警告防护(JSX 运行时)
void React;
