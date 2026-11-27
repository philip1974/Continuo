// @vitest-environment jsdom
// BDD:保存冲突确认框的「比较」按钮。见同目录 README 契约 1。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockviewComponent } from 'dockview-react';
import { useEditorStore } from '@/stores/editor.store';
import { EditorPanel } from '@/panels/Editor/EditorPanel';
import { saveActiveEditor } from '@/panels/Editor/editor-commands';
import { conflictDiffPanelId } from '@/panels/Editor/conflict-diff-constants';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { setLocale, t } from '@/i18n';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';
import { createDock } from '../dock-terminal-vscode-focus/dock-fixtures';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@/panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));
vi.mock('@/panels/Editor/MilkdownEditor', () => ({
  MilkdownEditor: () => <div data-testid="milkdown-editor" />,
}));
vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    fs: {
      readFile: mocks.readFile,
      writeFile: mocks.writeFile,
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));
vi.mock('@/notifications/notify', () => ({
  notify: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const PATH = '/work/conflict.txt';
let dock: DockviewComponent;

beforeEach(() => {
  vi.clearAllMocks();
  setLocale('zh');
  mocks.readFile.mockResolvedValue({ ok: true, data: 'theirs' });
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'mine', originalContent: 'orig', dirty: true }],
    activeTabId: PATH,
    mode: 'source',
  });
  dock = createDock();
  dock.api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  setDockApi(dock.api);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  cleanup();
  setDockApi(null);
  dock.dispose();
  vi.restoreAllMocks();
});

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

async function saveIntoConflict() {
  render(<EditorPanel />);
  await screen.findByTestId('code-editor');
  await act(async () => {
    await saveActiveEditor();
  });
  return screen.getByRole('alertdialog');
}

const compareButton = () => screen.getByRole('button', { name: t('panels.editor.disk_changed_compare') });

describe('冲突确认框的「比较」', () => {
  it('按钮依次 [比较, 放弃更改并重新加载, 取消, 覆盖],初始焦点仍在取消;三语按钮名', async () => {
    const dialog = await saveIntoConflict();
    const buttons = Array.from(dialog.querySelectorAll('button'));
    expect(buttons.map((b) => b.textContent)).toEqual([
      t('panels.editor.disk_changed_compare'),
      t('panels.editor.disk_changed_revert'),
      t('panels.explorer.confirm.cancel'),
      t('panels.editor.disk_changed_confirm'),
    ]);
    expect(buttons.filter((b) => b.hasAttribute('data-autofocus')).map((b) => b.textContent)).toEqual([
      t('panels.explorer.confirm.cancel'),
    ]);
    const k = 'panels.editor.disk_changed_compare';
    expect([en[k], zh[k], ko[k]]).toEqual(['Compare', '比较', '비교']);
    // 说明文案提到比较(VSCode:Please compare your version with the file contents or overwrite …)
    expect(dialog.textContent).toContain('比较');
  });

  it('比较 → 确认框关闭,不写盘、tab 仍脏,打开差异 tab', async () => {
    await saveIntoConflict();
    await click(compareButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'mine', dirty: true });
    const panel = dock.api.getPanel(conflictDiffPanelId(PATH));
    expect(panel?.params).toMatchObject({ tabId: PATH, groupId: 'editor' });
  });

  it('来自关闭脏 tab 的「保存」遇冲突 → 比较:这批关闭结束,tab 不关', async () => {
    render(<EditorPanel />);
    await screen.findByTestId('code-editor');
    fireEvent.click(screen.getByRole('button', { name: t('shell.tab.close', { title: 'conflict.txt' }) }));
    await click(screen.getByRole('button', { name: t('common.save') }));
    await click(compareButton());
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(dock.api.getPanel(conflictDiffPanelId(PATH))).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
