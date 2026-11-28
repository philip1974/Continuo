// @vitest-environment jsdom
// 后台打开(OpenFileOptions.requestFocus:false,agent 引起的调试停下改投另一个编辑器组用):在目标组显示该文件,但不换活动编辑器组、
// 不递增 editorFocusPulse(DockShell 不激活 dock 面板)、不计入用户激活代际。见同目录 README「停下时自动定位」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, getUserActivationGen, groupTabsOf, useEditorStore } from '@/stores/editor.store';
import { openFileByPath, type EditorFileDeps } from '@/panels/Editor/editor-file-actions';

const deps = {
  fs: { readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `disk ${p}` })), writeFile: vi.fn() },
} as unknown as EditorFileDeps;
const st = () => useEditorStore.getState();

beforeEach(() => {
  st().openTab(createTab('/w/lib.js', 'lib'));
  expect(st().splitGroup('editor', 'editor:2', null)).toBeTruthy();
  useEditorStore.setState({ activeGroupId: 'editor', activeTabId: '/w/lib.js' });
});

afterEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
  });
});

describe('后台打开到另一个编辑器组', () => {
  it('新文件:在目标组激活显示,活动组 / 活动 tab / focus pulse / 用户激活代际都不变', async () => {
    const pulse = st().editorFocusPulse;
    const gen = getUserActivationGen();
    const r = await openFileByPath('/w/app.js', deps, { preview: true, groupId: 'editor:2', requestFocus: false });
    expect(r.ok).toBe(true);
    expect(groupTabsOf(st(), 'editor:2').map((t) => t.id)).toContain('/w/app.js');
    expect(st().groups.find((g) => g.id === 'editor:2')!.activeTabId).toBe('/w/app.js');
    expect(st().activeGroupId).toBe('editor');
    expect(st().activeTabId).toBe('/w/lib.js');
    expect(st().editorFocusPulse).toBe(pulse);
    expect(getUserActivationGen()).toBe(gen);
  });

  it('已开着的文件:同样只在目标组切到它,不换活动组、不递增 pulse', async () => {
    await openFileByPath('/w/app.js', deps, { groupId: 'editor:2', requestFocus: false });
    useEditorStore.setState({ activeGroupId: 'editor', activeTabId: '/w/lib.js' });
    const pulse = st().editorFocusPulse;
    const gen = getUserActivationGen();
    await openFileByPath('/w/lib.js', deps, { preview: true, groupId: 'editor:2', requestFocus: false });
    expect(st().groups.find((g) => g.id === 'editor:2')!.activeTabId).toBe('/w/lib.js');
    expect(st().activeGroupId).toBe('editor');
    expect(st().editorFocusPulse).toBe(pulse);
    expect(getUserActivationGen()).toBe(gen);
  });
});
