// @vitest-environment jsdom
// BDD:关闭含脏文件的编辑器组(dock tab × 等所有 api.close 入口)照 VSCode 先确认保存:保存 / 不保存 / 取消,多个脏文件合并一个框;
// 取消 → 组不关;不保存 → 组关闭、脏文档随之关闭(不再移到相邻组);只为只在本组打开的文档确认。见同目录 README。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ writeFile: vi.fn() }));

vi.mock('@/plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ resolved: 'dark' }) }));
vi.mock('../../panels/Editor/CodeEditor', () => ({
  CodeEditor: ({ value }: { value: string }) => <div data-testid="code-editor">{value}</div>,
}));
vi.mock('../../lib/co-api', () => ({
  coApi: {
    fs: {
      // 磁盘内容 = 打开时的内容(保存前比对磁盘未被外部修改)
      readFile: vi.fn(async (p: string) => ({ ok: true, data: p.endsWith('a.ts') ? 'a' : p.endsWith('b.ts') ? 'b' : 'c' })),
      writeFile: mocks.writeFile,
      onDirChanged: vi.fn(() => vi.fn()),
    },
    shell: { openExternal: vi.fn() },
  },
}));

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { createTab, editorGroupIdsOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { EditorPanel } from '../../panels/Editor/EditorPanel';
import { editorGroupCloseGuard } from '../../panels/Editor/editor-commands';
import { trackEditorGroups } from '../../shell/dock/editor-groups-dock-sync';
import { setLocale } from '../../i18n';

const A = '/w/a.ts';
const B = '/w/b.ts';
const C = '/w/c.ts';
const st = () => useEditorStore.getState();

function api(id: string) {
  return { id, onDidLocationChange: () => ({ dispose: () => {} }) };
}

/** editor: A;editor:2: B C(活动组)。 */
function setup(): void {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    groupMru: ['editor'],
    stickyTabs: new Map(),
    previewTabs: new Map(),
    tabMru: new Map(),
    mode: 'source',
    viewRefs: new Map(),
  });
  st().openTab(createTab(A, 'a'));
  st().splitGroup('editor', 'editor:2', null);
  st().openTab(createTab(B, 'b'));
  st().openTab(createTab(C, 'c'));
  render(
    <div>
      <EditorPanel api={api('editor')} />
      <EditorPanel api={api('editor:2')} />
    </div>,
  );
}

/** dock 面板被移除(guard 放行后 dockview 真正关闭面板)→ trackEditorGroups 的 onDidRemovePanel。 */
async function removeDockPanel(id: string): Promise<void> {
  let onRemove: ((p: IDockviewPanel) => void) | undefined;
  const fake = {
    getPanel: () => undefined,
    onDidRemovePanel: (cb: (p: IDockviewPanel) => void) => {
      onRemove = cb;
      return { dispose: () => {} };
    },
    onDidActivePanelChange: () => ({ dispose: () => {} }),
  } as unknown as DockviewApi;
  const sub = trackEditorGroups(fake);
  onRemove!({ id, view: { contentComponent: 'editor' } } as unknown as IDockviewPanel);
  await act(() => Promise.resolve());
  sub.dispose();
}

beforeEach(() => {
  setLocale('en');
  mocks.writeFile.mockReset();
  mocks.writeFile.mockResolvedValue({ ok: true, data: undefined });
});
afterEach(() => cleanup());

describe('关闭含脏文件的编辑器组', () => {
  it('没有脏文件 → 直接放行(同步 true)', () => {
    setup();
    expect(editorGroupCloseGuard('editor:2')).toBe(true);
  });

  it('唯一的组 / 组已不在 store → 放行(唯一组的文档保留,与此前一致)', () => {
    setup();
    act(() => st().updateContent(A, 'dirty'));
    expect(editorGroupCloseGuard('editor:9')).toBe(true);
    act(() => st().removeGroup('editor:2', 'all'));
    expect(editorGroupCloseGuard('editor')).toBe(true);
  });

  it('一个脏文件:弹「保存 / 不保存 / 取消」;取消 → false,组与修改都在', async () => {
    setup();
    act(() => st().updateContent(B, 'changed'));
    let verdict: Promise<boolean> | boolean = true;
    act(() => {
      verdict = editorGroupCloseGuard('editor:2');
    });
    expect(await screen.findByText('Do you want to save the changes you made to b.ts?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await verdict).toBe(false);
    expect(editorGroupIdsOf(st())).toEqual(['editor', 'editor:2']);
    expect(st().tabs.find((t) => t.id === B)?.dirty).toBe(true);
  });

  it('不保存 → true;面板移除时脏文档随之关闭(不移到相邻组)', async () => {
    setup();
    act(() => st().updateContent(B, 'changed'));
    let verdict: Promise<boolean> | boolean = false;
    act(() => {
      verdict = editorGroupCloseGuard('editor:2');
    });
    fireEvent.click(await screen.findByRole('button', { name: "Don't Save" }));
    expect(await verdict).toBe(true);
    await removeDockPanel('editor:2');
    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(groupTabsOf(st(), 'editor').map((t) => t.id)).toEqual([A]);
  });

  it('保存 → 写盘后 true,文档不再脏', async () => {
    setup();
    act(() => st().updateContent(B, 'changed'));
    let verdict: Promise<boolean> | boolean = false;
    act(() => {
      verdict = editorGroupCloseGuard('editor:2');
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await verdict).toBe(true);
    expect(mocks.writeFile.mock.calls[0]?.slice(0, 2)).toEqual([B, 'changed']);
    expect(st().tabs.find((t) => t.id === B)?.dirty).toBe(false);
  });

  it('多个脏文件 → 一个合并框「全部保存 / 不保存 / 取消」', async () => {
    setup();
    act(() => {
      st().updateContent(B, 'b2');
      st().updateContent(C, 'c2');
    });
    let verdict: Promise<boolean> | boolean = true;
    act(() => {
      verdict = editorGroupCloseGuard('editor:2');
    });
    expect(await screen.findByText('Do you want to save the changes to the following 2 files?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save All' }));
    expect(await verdict).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it('脏文档还在别的组打开 → 不算随之关闭,不确认', () => {
    setup();
    act(() => {
      st().openTab(createTab(B, 'b'), { groupId: 'editor' });
      st().updateContent(B, 'changed');
    });
    expect(editorGroupCloseGuard('editor:2')).toBe(true);
  });
});
