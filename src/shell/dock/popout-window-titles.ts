// popout 子窗的原生窗口标题(Dock / 窗口菜单 / ⌘` 切换时显示)= 子窗自己的活动面板:编辑器组 → 其活动文件(未保存加 ●)、
// 其它面板 → 面板名,后接工作区名(格式同主窗,formatWindowTitle)。dockview 开子窗时只把主窗当时的 document.title 抄过去、
// 之后不再更新 → 子窗标题是主窗某一时刻的文件,重启恢复后主 / 子窗标题对调(VSCode:窗口标题按窗口分别计算)。
// 子窗面板由主窗 React 经 portal 渲染,这里在主窗直接写子窗 document.title;只在算出的标题变化时写。
// BDD: src/__tests__/chrome-active-panel/

import type { DockviewApi, IDockviewPanel } from 'dockview-react';
import { groupActiveTabIdOf, useEditorStore } from '@/stores/editor.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { findEditorFileTabById } from '@/panels/Editor/editor-tab-lookup';
import { basenameForChrome } from '@/lib/path-label';
import { editorTabTitle } from '@/panels/Editor/untitled';
import { formatWindowTitle } from '@/shell/window-title';
import { isEditorGroupId } from '../../../electron/shared/editor-group-id';
import { subscribePopoutDocuments } from './popout-documents';

function titleOf(panel: IDockviewPanel | undefined, workspace: string | null): string {
  if (panel && isEditorGroupId(panel.id)) {
    const s = useEditorStore.getState();
    const tab = findEditorFileTabById(s.tabs, groupActiveTabIdOf(s, panel.id));
    return formatWindowTitle(tab ? editorTabTitle(tab.filePath) : null, tab?.dirty ?? false, workspace);
  }
  return formatWindowTitle(panel?.title || null, false, workspace);
}

export function trackPopoutWindowTitles(api: DockviewApi): { dispose: () => void } {
  let titleSubs: { dispose: () => void }[] = [];
  let disposed = false;

  const sync = (): void => {
    if (disposed) return;
    for (const sub of titleSubs) sub.dispose();
    titleSubs = [];
    const root = useWorkspaceStore.getState().root;
    const workspace = root ? basenameForChrome(root) : null;
    for (const group of api.groups) {
      const location = group.api.location;
      if (location.type !== 'popout') continue;
      // 子窗关闭途中 getWindow() 可能已是 null(类型未标)
      const doc = (location.getWindow() as Window | null)?.document;
      if (!doc || doc === document) continue;
      const panel = group.activePanel;
      if (panel) titleSubs.push(panel.api.onDidTitleChange(syncSoon));
      const title = titleOf(panel, workspace);
      if (doc.title !== title) doc.title = title;
    }
  };
  // 组结构 / 面板增删事件先于 location 变化派发 → 延到 microtask
  const syncSoon = (): void => queueMicrotask(sync);

  const subs = [
    api.onDidActivePanelChange(sync),
    api.onDidActiveGroupChange(sync),
    api.onDidLayoutChange(syncSoon),
    api.onDidAddPanel(syncSoon),
    // 面板移动(拖进 / 拖出子窗的组)同样派发移除 / 加入与布局变化
    api.onDidRemovePanel(syncSoon),
  ];
  const offDocs = subscribePopoutDocuments(sync);
  // 只在影响标题的字段变化时重算(持续输入已脏的文档不触发)
  const offEditor = useEditorStore.subscribe((s, prev) => {
    if (s.activeTabId !== prev.activeTabId || s.groups !== prev.groups || s.chromeVersion !== prev.chromeVersion) sync();
  });
  const offWorkspace = useWorkspaceStore.subscribe((s, prev) => {
    if (s.root !== prev.root) sync();
  });
  sync();

  return {
    dispose: () => {
      disposed = true;
      for (const sub of [...subs, ...titleSubs]) sub.dispose();
      titleSubs = [];
      offDocs();
      offEditor();
      offWorkspace();
    },
  };
}
