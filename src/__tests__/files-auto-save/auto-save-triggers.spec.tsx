// @vitest-environment jsdom
// BDD: files-auto-save 第 2 / 3 条 —— afterDelay 对代码文件生效;onFocusChange 在编辑器失焦 / 切 tab / 窗口失焦时保存,onWindowChange
// 只在窗口失焦时保存;窗口失焦保存组内全部符合条件的脏 tab;失焦保存前先回写 Markdown 编辑视图;失败只提示一次。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { useAutoSave, type UseAutoSaveOptions } from '@/panels/Editor/useAutoSave';
import { DEFAULT_AUTO_SAVE_SETTINGS, resolveAutoSave, type AutoSaveSettings } from '@/panels/Editor/auto-save-config';
import { registerEditorWriteBack } from '@/panels/Editor/editor-writeback-registry';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import { notify } from '@/notifications/notify';

type SaveTab = (tabId: string, opts?: unknown) => Promise<unknown>;

function Probe({ saveTab, opts }: { saveTab: SaveTab; opts: Omit<UseAutoSaveOptions, 'rootRef'> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoSave(saveTab, { ...opts, rootRef, hostWindow: window });
  return (
    <div ref={rootRef}>
      <textarea data-testid="editor" />
      <button data-testid="tab">tab</button>
    </div>
  );
}

const tab = (filePath: string, dirty: boolean, extra: Partial<EditorTab> = {}): EditorTab =>
  ({ id: filePath, filePath, content: dirty ? 'new' : 'old', originalContent: 'old', dirty, ...extra }) as EditorTab;

/** 保存成功:清 dirty(同 markSaved)。 */
function okSave(): ReturnType<typeof vi.fn<SaveTab>> {
  return vi.fn<SaveTab>(async (id) => {
    useEditorStore.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty: false } : t)) }));
    return { ok: true };
  });
}

const settings = (over: Partial<AutoSaveSettings>): AutoSaveSettings => ({ ...DEFAULT_AUTO_SAVE_SETTINGS, ...over });

/** EditorPanel 同款:按活动 tab 的生效模式得出 useAutoSave 参数。 */
function optsFor(filePath: string, s: AutoSaveSettings): Omit<UseAutoSaveOptions, 'rootRef'> {
  const r = resolveAutoSave(filePath, s);
  return {
    enabled: r.mode !== 'off',
    delayMs: r.mode === 'afterDelay' ? r.delayMs : null,
    saveOn: r.mode === 'onFocusChange' ? 'focusChange' : r.mode === 'onWindowChange' ? 'windowChange' : null,
    settings: s,
  };
}

let outside: HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState({ tabs: [], activeTabId: null });
  outside = document.createElement('button');
  document.body.appendChild(outside);
});

afterEach(() => {
  cleanup();
  outside.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function focus(el: HTMLElement): void {
  act(() => el.focus());
}

function blurWindow(): void {
  act(() => {
    window.dispatchEvent(new FocusEvent('blur'));
  });
}

describe('afterDelay', () => {
  it('代码文件停手 files.autoSaveDelay 后保存', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true)], activeTabId: '/w/a.ts' });
    const save = okSave();
    render(<Probe saveTab={save} opts={optsFor('/w/a.ts', settings({ mode: 'afterDelay', delayMs: 700 }))} />);
    await settle(600);
    expect(save).not.toHaveBeenCalled();
    await settle(150);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('/w/a.ts', { recreateMissing: false });
  });

  it('默认设置下代码文件不自动保存', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true)], activeTabId: '/w/a.ts' });
    const save = okSave();
    render(<Probe saveTab={save} opts={optsFor('/w/a.ts', DEFAULT_AUTO_SAVE_SETTINGS)} />);
    await settle(60_000);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('onFocusChange', () => {
  const s = settings({ mode: 'onFocusChange' });

  it('不按延迟保存;焦点移出编辑器组面板 → 保存', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true)], activeTabId: '/w/a.ts' });
    const save = okSave();
    const view = render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    focus(view.getByTestId('editor'));
    await settle(60_000);
    expect(save).not.toHaveBeenCalled();
    focus(outside);
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('/w/a.ts', { recreateMissing: false });
  });

  it('焦点在面板内移动(编辑区 → tab 行)不保存', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true)], activeTabId: '/w/a.ts' });
    const save = okSave();
    const view = render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    focus(view.getByTestId('editor'));
    focus(view.getByTestId('tab'));
    await settle();
    expect(save).not.toHaveBeenCalled();
  });

  it('切到同组另一个 tab → 保存被切走的 tab', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true), tab('/w/b.ts', false)], activeTabId: '/w/a.ts' });
    const save = okSave();
    const view = render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    act(() => useEditorStore.setState({ activeTabId: '/w/b.ts' }));
    view.rerender(<Probe saveTab={save} opts={optsFor('/w/b.ts', s)} />);
    await settle();
    expect(save).toHaveBeenCalledWith('/w/a.ts', { recreateMissing: false });
  });

  it('失焦保存前先同步回写编辑视图尚未上抛的输入', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.md', false)], activeTabId: '/w/a.md' });
    const offWriteBack = registerEditorWriteBack('/w/a.md', () =>
      useEditorStore.setState((st) => ({
        tabs: st.tabs.map((t) => (t.id === '/w/a.md' ? { ...t, content: 'typed', dirty: true } : t)),
      })),
    );
    let savedContent: string | undefined;
    const save = vi.fn<SaveTab>(async (id) => {
      savedContent = useEditorStore.getState().tabs.find((t) => t.id === id)?.content;
      return { ok: true };
    });
    const view = render(<Probe saveTab={save} opts={optsFor('/w/a.md', settings({ mode: 'onFocusChange', markdown: false }))} />);
    focus(view.getByTestId('editor'));
    focus(outside);
    await settle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(savedContent).toBe('typed');
    offWriteBack();
  });

  it('保存失败只提示一次(继续编辑后再次失焦失败不再提示)', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true)], activeTabId: '/w/a.ts' });
    const warn = vi.spyOn(notify, 'warn').mockImplementation(() => undefined as never);
    const save = vi.fn<SaveTab>(async () => ({ ok: false, code: 'FS_ENOSPC', message: 'no space' }));
    const view = render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    focus(view.getByTestId('editor'));
    focus(outside);
    await settle();
    act(() =>
      useEditorStore.setState((st) => ({ tabs: st.tabs.map((t) => ({ ...t, content: 'newer' })) })),
    );
    focus(view.getByTestId('editor'));
    focus(outside);
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('onWindowChange', () => {
  const s = settings({ mode: 'onWindowChange' });

  it('焦点移出编辑器 / 切 tab 不保存;窗口失焦 → 保存', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true), tab('/w/b.ts', false)], activeTabId: '/w/a.ts' });
    const save = okSave();
    const view = render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    focus(view.getByTestId('editor'));
    focus(outside);
    await settle(60_000);
    expect(save).not.toHaveBeenCalled();
    act(() => useEditorStore.setState({ activeTabId: '/w/b.ts' }));
    view.rerender(<Probe saveTab={save} opts={optsFor('/w/b.ts', s)} />);
    await settle();
    expect(save).not.toHaveBeenCalled();
    blurWindow();
    await settle();
    // 被切走的 a.ts(后台脏 tab)在窗口失焦时保存
    expect(save).toHaveBeenCalledWith('/w/a.ts', { recreateMissing: false });
  });

  it('窗口失焦保存组内全部符合条件的脏 tab:跳过干净 / 无标题 / 已删除 / 不自动保存的', async () => {
    useEditorStore.setState({
      tabs: [
        tab('/w/a.ts', true),
        tab('/w/b.ts', true),
        tab('/w/clean.ts', false),
        tab('untitled:Untitled-1', true),
        tab('/w/gone.ts', true, { orphaned: true }),
      ],
      activeTabId: '/w/a.ts',
    });
    const save = okSave();
    render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    blurWindow();
    await settle();
    expect(save.mock.calls.map((c) => c[0]).sort()).toEqual(['/w/a.ts', '/w/b.ts']);
  });

  it('Markdown(覆盖开启 = afterDelay)不在窗口失焦时被代码模式带着保存,仍按自己的延迟', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true), tab('/w/n.md', true)], activeTabId: '/w/a.ts' });
    const save = okSave();
    render(<Probe saveTab={save} opts={optsFor('/w/a.ts', s)} />);
    blurWindow();
    await settle();
    expect(save.mock.calls.map((c) => c[0])).toEqual(['/w/a.ts']);
  });

  it('活动 tab 是 Markdown(afterDelay)时窗口失焦仍保存后台脏的代码 tab', async () => {
    useEditorStore.setState({ tabs: [tab('/w/n.md', false), tab('/w/a.ts', true)], activeTabId: '/w/n.md' });
    const save = okSave();
    render(<Probe saveTab={save} opts={optsFor('/w/n.md', s)} />);
    blurWindow();
    await settle();
    expect(save.mock.calls.map((c) => c[0])).toEqual(['/w/a.ts']);
  });

  it('关闭确认框等暂停期间(enabled=false)窗口失焦不保存', async () => {
    useEditorStore.setState({ tabs: [tab('/w/a.ts', true)], activeTabId: '/w/a.ts' });
    const save = okSave();
    render(<Probe saveTab={save} opts={{ ...optsFor('/w/a.ts', s), enabled: false, paused: true }} />);
    blurWindow();
    await settle();
    expect(save).not.toHaveBeenCalled();
  });
});
