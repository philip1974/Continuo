// @vitest-environment jsdom
// BDD:关掉最后一个编辑器 tab 后焦点留在空编辑器组(编辑器面板根),不掉到 body(VSCode 同)。见同目录 README 第 5 条。
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

const panelRoot = () => document.querySelector<HTMLElement>('[data-editor-panel-root]');

beforeEach(() => {
  useEditorStore.setState({ tabs: [tab(A)], activeTabId: A, mode: 'source' });
  setDockApi({ activePanel: { id: 'editor', view: { contentComponent: 'editor' }, api: { close: vi.fn() } } } as unknown as DockviewApi);
});
afterEach(() => {
  cleanup();
  setDockApi(null);
});

describe('关掉最后一个编辑器 tab', () => {
  it('焦点在编辑器里 ⌘W → 焦点留在编辑器面板根(可继续 ⌘W 关面板 / F6 切区域)', async () => {
    mount();
    (await screen.findByTestId('code-editor')).focus();

    act(() => closeActiveEditor());
    await act(nextFrame);

    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(panelRoot()).not.toBeNull();
    expect(document.activeElement).toBe(panelRoot());
  });

  it('点活动 tab 的 × → 同样留在面板根', async () => {
    mount();
    (await screen.findByTestId('code-editor')).focus();

    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'a.ts' }) }));
    await act(nextFrame);

    expect(document.activeElement).toBe(panelRoot());
  });

  it('焦点在面板外 → 不抢焦点', async () => {
    mount();
    await screen.findByTestId('code-editor');
    const outside = screen.getByRole('button', { name: 'explorer-row' });
    outside.focus();

    act(() => closeActiveEditor());
    await act(nextFrame);

    expect(document.activeElement).toBe(outside);
  });
});
