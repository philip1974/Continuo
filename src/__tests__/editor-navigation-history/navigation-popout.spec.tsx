// @vitest-environment jsdom
// BDD: editor-navigation-history 第 5 条 —— 原编辑器组已不在 → 在触发窗口的编辑器组打开(活动编辑器组仍在 popout 子窗时,
// 主窗里按 ⌃- 落在主窗的组,不落进子窗)。见同目录 README。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';

vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: vi.fn(), writeFile: vi.fn() } },
}));

import { setDockApi } from '../../shell/dock/dock-api-ref';
import { trackGroupMru } from '../../shell/dock/group-mru';
import { runInCommandDocument, trackPopoutDocuments } from '../../shell/dock/popout-documents';
import { trackEditorGroups } from '../../shell/dock/editor-groups-dock-sync';
import { createTab, groupActiveTabIdOf, useEditorStore } from '../../stores/editor.store';
import { navigateBack, navigationStack, resetNavigationHistory } from '../../panels/Editor/navigation-history';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const [A, B, C] = ['/w/a.ts', '/w/b.ts', '/w/c.ts'] as const;
const disposers: { dispose(): void }[] = [];

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  setDockApi(dock.api);
  return dock.api;
}

function popOut(group: IDockviewPanel['group'], win: Window): void {
  (group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
}

afterEach(() => {
  cleanup();
  for (const d of disposers.splice(0)) d.dispose();
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('原组已不在 → 触发窗口的编辑器组', () => {
  it('活动编辑器组在子窗、主窗里后退 → 在主窗的组打开,不落进子窗', async () => {
    useEditorStore.setState({
      tabs: [A, B, C].map((p) => createTab(p, p)),
      groups: [
        { id: 'editor', tabIds: [A], activeTabId: A },
        { id: 'editor:2', tabIds: [B, C], activeTabId: B },
      ],
      activeGroupId: 'editor',
      activeTabId: A,
      viewRefs: new Map(),
    });
    const api = createDock();
    const main = api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const child = api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor', position: { direction: 'right' } });
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    disposers.push(trackGroupMru(api), trackPopoutDocuments(api), trackEditorGroups(api));
    act(() => popOut(child.group, frame.contentWindow!));
    main.api.setActive();
    child.api.setActive();
    expect(useEditorStore.getState().activeGroupId).toBe('editor:2');

    resetNavigationHistory();
    // 栈:已关闭的组 editor:9 里的 C → 子窗的 B
    navigationStack().notify({ groupId: 'editor:9', path: C });
    navigationStack().notify({ groupId: 'editor:2', path: B });
    await runInCommandDocument(document, () => navigateBack());
    const s = useEditorStore.getState();
    expect(s.activeGroupId).toBe('editor');
    expect(groupActiveTabIdOf(s, 'editor')).toBe(C);
    expect(groupActiveTabIdOf(s, 'editor:2')).toBe(B);
  });
});
