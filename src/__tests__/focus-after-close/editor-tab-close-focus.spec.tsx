// @vitest-environment jsdom
// BDD:关闭编辑器文件 tab(⌘W / 点 ×)后,焦点在编辑器面板里(或已丢到 body)→ 新的活动 tab 的编辑器获焦;
// 焦点原本不在编辑器面板里 → 不抢焦点。见同目录 README 第 2 条。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewApi } from 'dockview-react';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { closeActiveEditor } from '../../panels/Editor/editor-commands';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { t } from '../../i18n';

// CodeEditor 替身:视图就绪时按 tab 登记聚焦句柄(同真实引擎)
vi.mock('../../panels/Editor/CodeEditor', async () => {
  const { useEffect, useRef } = await import('react');
  const { registerEditorFocus } = await import('../../panels/Editor/editor-focus-registry');
  return {
    CodeEditor: ({ value, tabId }: { value: string; tabId: string }) => {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => registerEditorFocus(tabId, () => ref.current?.focus()), [tabId]);
      return (
        <div ref={ref} data-testid="code-editor" data-tab={tabId} tabIndex={-1}>
          {value}
        </div>
      );
    },
  };
});
vi.mock('../../panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: vi.fn(async () => ({ ok: true, data: 'orig' })),
      writeFile: vi.fn(async () => ({ ok: true, data: undefined })),
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
    window: { close: vi.fn() },
  },
}));
vi.mock('../../notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const A = '/work/a.ts';
const B = '/work/b.ts';
const C = '/work/c.ts';

function tab(path: string, dirty = false): EditorTab {
  return { id: path, filePath: path, content: dirty ? 'mine' : 'orig', originalContent: 'orig', dirty };
}

/** 等编辑器聚焦请求(下一帧)兑现。 */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

function mount() {
  render(
    <>
      <EditorPanel />
      <button type="button">explorer-row</button>
    </>,
  );
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [tab(A), tab(B), tab(C)], activeTabId: A, mode: 'source' });
  setDockApi({ activePanel: { id: 'editor', view: { contentComponent: 'editor' }, api: { close: vi.fn() } } } as unknown as DockviewApi);
});
afterEach(() => {
  cleanup();
  setDockApi(null);
});

describe('关闭活动编辑器 tab 后焦点交给新的活动 tab', () => {
  it('焦点在编辑器里 ⌘W(closeActiveEditor)→ 新活动 tab 的编辑器获焦', async () => {
    mount();
    (await screen.findByTestId('code-editor')).focus();

    act(() => closeActiveEditor());
    await act(nextFrame);
    await act(nextFrame);

    const next = useEditorStore.getState().activeTabId;
    expect(next).not.toBe(A);
    expect(document.activeElement).toBe(screen.getByTestId('code-editor'));
    expect(screen.getByTestId('code-editor').dataset.tab).toBe(next);
  });

  it('焦点已丢到 body → 同样交给新活动 tab 的编辑器', async () => {
    mount();
    await screen.findByTestId('code-editor');
    (document.activeElement as HTMLElement | null)?.blur();

    act(() => closeActiveEditor());
    await act(nextFrame);
    await act(nextFrame);

    expect(document.activeElement).toBe(screen.getByTestId('code-editor'));
  });

  it('脏 tab 经「不保存」确认关闭 → 新活动 tab 的编辑器获焦', async () => {
    useEditorStore.setState({ tabs: [tab(A, true), tab(B), tab(C)], activeTabId: A });
    mount();
    (await screen.findByTestId('code-editor')).focus();

    act(() => closeActiveEditor());
    fireEvent.click(await screen.findByRole('button', { name: t('dialog.unsaved_close.dont_save') }));
    await act(nextFrame);
    await act(nextFrame);

    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([B, C]);
    expect(document.activeElement).toBe(screen.getByTestId('code-editor'));
  });

  it('关闭非活动 tab → 不动焦点(焦点在活动 tab 的标签上也不被拉进编辑区)', async () => {
    mount();
    await screen.findByTestId('code-editor');
    const activeTab = screen.getByRole('tab', { name: /a\.ts/ });
    activeTab.focus();

    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'c.ts' }) }));
    await act(nextFrame);
    await act(nextFrame);

    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([A, B]);
    expect(document.activeElement).toBe(activeTab);
  });

  it('焦点在编辑器面板外(如 Explorer)→ 关闭 tab 不抢焦点', async () => {
    mount();
    await screen.findByTestId('code-editor');
    const outside = screen.getByRole('button', { name: 'explorer-row' });
    outside.focus();

    act(() => closeActiveEditor());
    await act(nextFrame);
    await act(nextFrame);

    expect(useEditorStore.getState().tabs.map((x) => x.id)).toEqual([B, C]);
    expect(document.activeElement).toBe(outside);
  });
});
