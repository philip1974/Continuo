// M-Editor Step E1:编辑器全局 store。
// 从 MindAutonAgent 移植 + Jotai → Zustand 重写;沿用 ADR-007 vanilla 模式。
//
// 持久化由 Step E5+ 接入(目前内存态,Editor MVP 不接 explorer.json,
// session 恢复留下里程碑)。

import { create } from 'zustand';
import type { EditorView } from '@codemirror/view';
import { isMilkdownUnsafe } from '@/panels/Editor/milkdown-roundtrip-safety';
import { isMarkdownPath } from '@/panels/Editor/editor-path-utils';

// ── 类型 ─────────────────────────────────────────────────────

export type EditorMode = 'edit' | 'source' | 'preview';

export interface EditorTab {
  /** filePath 或 `untitled-${uuid}`. */
  readonly id: string;
  /** null = 未保存草稿. */
  readonly filePath: string | null;
  /** 当前内容(编辑器实时同步). */
  readonly content: string;
  /** 上次磁盘内容(dirty 比对依据). */
  readonly originalContent: string;
  /** = content !== originalContent. */
  readonly dirty: boolean;
  /**
   * 外部重载计数:仅 reloadFromDisk(外部进程改文件后同步)递增。用户输入 / 保存
   * **不**动它。Milkdown 视图 defaultValue 只在 mount 时读、靠 key remount 刷新,
   * 把本计数并入 key 才能在外部修改时 remount 拿到新内容(否则编辑会覆盖外部改动)。
   * optional:不破坏既有 tab 字面构造,缺省按 0。
   */
  readonly reloadEpoch?: number;
  /**
   * 性能 P4:派生缓存 = `isMarkdownFilePath(filePath) && isMilkdownUnsafe(content)`。
   * 仅在 content / filePath 变更时(createTab / updateContent / reloadFromDisk /
   * setFilePath)算一次,避免 getEffectiveMode 在每次渲染 / Header selector 里对
   * 全文重复跑未锚定的 wiki-link 正则(长 Markdown 输入时 ~3 次 O(file)/按键)。
   * optional:缺省时 getEffectiveMode 回退到现场计算(行为等价,不破坏旧构造)。
   */
  readonly milkdownUnsafe?: boolean;
}

// ── 纯函数 helpers(便于单测) ────────────────────────────────

export function createTab(
  filePath: string | null,
  content: string,
): EditorTab {
  return {
    id: filePath ?? `untitled-${crypto.randomUUID()}`,
    filePath,
    content,
    originalContent: content,
    dirty: false,
    milkdownUnsafe: computeMilkdownUnsafe(filePath, content), // perf P4
  };
}

export interface CloseTabResult {
  tabs: EditorTab[];
  activeTabId: string | null;
}

/**
 * 关闭 tab 后的新状态:
 * - 关不存在的 id → 状态不变
 * - 关非活跃 → tabs 减,active 不变
 * - 关活跃且后面有 → 切到下一个
 * - 关活跃且后面没 → 切到前一个
 * - 关最后一个 → active null
 */
export function getStateAfterClosingTab(
  tabs: EditorTab[],
  activeTabId: string | null,
  closingTabId: string,
): CloseTabResult {
  const idx = tabs.findIndex((t) => t.id === closingTabId);
  if (idx === -1) return { tabs, activeTabId };

  const remaining = tabs.filter((t) => t.id !== closingTabId);
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (closingTabId !== activeTabId) {
    return { tabs: remaining, activeTabId };
  }
  // 关的是活跃 tab:取原索引位的下一个,溢出则取前一个
  const nextIdx = Math.min(idx, remaining.length - 1);
  return {
    tabs: remaining,
    activeTabId: remaining[nextIdx]?.id ?? null,
  };
}

/**
 * 文件 / 目录被重命名 / 移动后的 tab 状态:
 * - 精确匹配 filePath === oldPath → 改 id+filePath 为 newPath
 * - 子文件(`oldPath/` 或 `oldPath\\` 前缀)→ 前缀 rewrite
 * - untitled(filePath=null)tab 不受影响
 * - dirty / content / originalContent 全部保留
 * - activeTabId 跟随目标 tab id 改变
 */
export function getStateAfterRenamingPath(
  tabs: EditorTab[],
  activeTabId: string | null,
  oldPath: string,
  newPath: string,
): CloseTabResult {
  const rewrite = (filePath: string): string | null => {
    if (filePath === oldPath) return newPath;
    if (filePath.startsWith(oldPath + '/')) {
      return newPath + filePath.slice(oldPath.length);
    }
    if (filePath.startsWith(oldPath + '\\')) {
      return newPath + filePath.slice(oldPath.length);
    }
    return null;
  };

  let changed = false;
  const newTabs = tabs.map((t) => {
    if (t.filePath === null) return t;
    const np = rewrite(t.filePath);
    if (np === null) return t;
    changed = true;
    // perf P4:filePath 变(可能改变 markdown 判定)→ 重算派生缓存(content 不变)。
    return {
      ...t,
      id: np,
      filePath: np,
      milkdownUnsafe: computeMilkdownUnsafe(np, t.content),
    };
  });
  if (!changed) return { tabs, activeTabId };

  let nextActive = activeTabId;
  if (activeTabId !== null) {
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx >= 0) nextActive = newTabs[idx]!.id;
  }
  return { tabs: newTabs, activeTabId: nextActive };
}

/**
 * 工作区 root 切换后的 tab 状态:
 * - untitled(filePath=null)tab 与 root 无关,始终保留
 * - **dirty(未保存编辑)tab 始终保留** —— 切 root 不得静默丢弃用户改动(审计):
 *   旧实现只按 filePath 位置判定,root 外的脏真实文件 tab 被直接关闭、编辑丢失
 * - filePath 等于 root 或位于其下(`root/` 或 `root\\` 前缀)→ 保留
 * - 其余(包括 root=null 时所有 clean file tab)→ 关闭
 * - active tab 被关时 → 取剩余第一个(优先剩余中原序更靠后的相邻);全清则 null
 */
export function getStateAfterClosingTabsOutsideRoot(
  tabs: EditorTab[],
  activeTabId: string | null,
  root: string | null,
): CloseTabResult {
  const keep = (tab: EditorTab): boolean => {
    if (tab.filePath === null) return true; // untitled 永远保留
    if (tab.dirty) return true; // 未保存编辑 → 保留,切 root 不静默丢数据
    if (root === null) return false;
    if (tab.filePath === root) return true;
    return (
      tab.filePath.startsWith(root + '/') ||
      tab.filePath.startsWith(root + '\\')
    );
  };

  const remaining = tabs.filter(keep);
  if (remaining.length === tabs.length) return { tabs, activeTabId };
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (activeTabId !== null && remaining.some((t) => t.id === activeTabId)) {
    return { tabs: remaining, activeTabId };
  }
  // active 被关:取原序后向第一个 remaining,否则前向,否则首个
  if (activeTabId !== null) {
    const oldIdx = tabs.findIndex((t) => t.id === activeTabId);
    if (oldIdx >= 0) {
      const removingIds = new Set(
        tabs.filter((t) => !keep(t)).map((t) => t.id),
      );
      for (let i = oldIdx + 1; i < tabs.length; i++) {
        if (!removingIds.has(tabs[i]!.id)) {
          return { tabs: remaining, activeTabId: tabs[i]!.id };
        }
      }
      for (let i = oldIdx - 1; i >= 0; i--) {
        if (!removingIds.has(tabs[i]!.id)) {
          return { tabs: remaining, activeTabId: tabs[i]!.id };
        }
      }
    }
  }
  return { tabs: remaining, activeTabId: remaining[0]!.id };
}

/**
 * 文件 / 目录被删除后的 tab 状态:
 * - 精确匹配 filePath === removedPath
 * - 或位于该目录下(`removedPath/` 或 `removedPath\\` 前缀)
 * - untitled(filePath=null)tab 不受影响
 * - 同前缀但非子(如 `/x/foo` 删 vs `/x/foobar.md`)不误关
 * - active 被关 → 取原序后向第一个 remaining,否则前一个,否则 null
 */
export function getStateAfterRemovingPath(
  tabs: EditorTab[],
  activeTabId: string | null,
  removedPath: string,
): CloseTabResult {
  const isMatch = (filePath: string | null): boolean => {
    if (filePath === null) return false;
    if (filePath === removedPath) return true;
    return (
      filePath.startsWith(removedPath + '/') ||
      filePath.startsWith(removedPath + '\\')
    );
  };

  const removingIds = new Set<string>();
  for (const t of tabs) if (isMatch(t.filePath)) removingIds.add(t.id);
  if (removingIds.size === 0) return { tabs, activeTabId };

  const remaining = tabs.filter((t) => !removingIds.has(t.id));
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (activeTabId === null || !removingIds.has(activeTabId)) {
    return { tabs: remaining, activeTabId };
  }
  const oldIdx = tabs.findIndex((t) => t.id === activeTabId);
  let next: EditorTab | null = null;
  for (let i = oldIdx + 1; i < tabs.length; i++) {
    if (!removingIds.has(tabs[i]!.id)) {
      next = tabs[i]!;
      break;
    }
  }
  if (!next) {
    for (let i = oldIdx - 1; i >= 0; i--) {
      if (!removingIds.has(tabs[i]!.id)) {
        next = tabs[i]!;
        break;
      }
    }
  }
  return { tabs: remaining, activeTabId: next?.id ?? null };
}

// ── Zustand store ────────────────────────────────────────────

type EditorState = {
  tabs: EditorTab[];
  activeTabId: string | null;
  mode: EditorMode;
  /**
   * 递增 token:每次"请求 editor 在 dock 内激活"时 +1。即便 activeTabId 不变
   * (如同一文件被资源管理器再次单击),pulse 也会变,DockShell useEffect 据此
   * 重新调 setActive('editor'),保证从其它 panel(terminal 等)切回 editor。
   * 见 issue #22。
   */
  editorFocusPulse: number;
  /** runtime only, not persisted - CodeMirror EditorView refs per tab */
  viewRefs: Map<string, EditorView>;

  /** 已存在则切换 active,新加则推入. */
  openTab: (tab: EditorTab) => void;
  closeTab: (id: string) => void;
  /** 文件/目录被删除时调用:精确匹配或前缀匹配的 tab 统一关闭. */
  removePath: (path: string) => void;
  /** 文件/目录被重命名 / 移动时调用:精确或前缀匹配的 tab 同步路径. */
  renamePath: (oldPath: string, newPath: string) => void;
  /** 外部修改时调用:非 dirty tab 同步 content+originalContent;dirty 跳过. */
  reloadFromDisk: (tabId: string, content: string) => void;
  /** 工作区切换时调用:关闭 root 外的 file tabs;untitled 始终保留. */
  closeTabsOutsideRoot: (root: string | null) => void;
  switchTab: (id: string) => void;
  /** 编辑器 onChange 时调用;dirty 自动比对. */
  updateContent: (id: string, content: string) => void;
  /**
   * 保存成功后调用。`savedContent` 是实际写盘的内容快照:
   *   - 期间无并发编辑(cur.content === savedContent)→ originalContent ← savedContent,
   *     dirty=false(正常路径)。
   *   - 写盘 await 期间用户继续键入(cur.content !== savedContent)→ originalContent
   *     推进到 savedContent 但**保留 dirty=true**,使这段增量不被静默吞掉、后续
   *     autosave 会再写。省略 savedContent 时退化为旧语义(originalContent ← content)。
   */
  markSaved: (id: string, savedContent?: string) => void;
  /** 另存为后:把 tab 的 filePath 与 id 同步改为 newPath. */
  setFilePath: (id: string, newPath: string) => void;
  setMode: (mode: EditorMode) => void;
  registerView: (tabId: string, view: EditorView) => void;
  unregisterView: (tabId: string, expectedView: EditorView) => void;
  waitForViewRef: (
    tabId: string,
    timeoutMs?: number,
  ) => Promise<EditorView | null>;
};

export const useEditorStore = create<EditorState>((set, get, api) => ({
  tabs: [],
  activeTabId: null,
  mode: 'source',
  editorFocusPulse: 0,
  viewRefs: new Map(),

  openTab: (tab) =>
    set((s) => {
      const pulse = s.editorFocusPulse + 1;
      const exists = s.tabs.some((t) => t.id === tab.id);
      if (exists) return { activeTabId: tab.id, editorFocusPulse: pulse };
      return {
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        editorFocusPulse: pulse,
      };
    }),

  closeTab: (id) =>
    set((s) => getStateAfterClosingTab(s.tabs, s.activeTabId, id)),

  removePath: (path) =>
    set((s) => getStateAfterRemovingPath(s.tabs, s.activeTabId, path)),

  renamePath: (oldPath, newPath) =>
    set((s) =>
      getStateAfterRenamingPath(s.tabs, s.activeTabId, oldPath, newPath),
    ),

  closeTabsOutsideRoot: (root) =>
    set((s) =>
      getStateAfterClosingTabsOutsideRoot(s.tabs, s.activeTabId, root),
    ),

  reloadFromDisk: (tabId, content) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      // dirty:保留用户改动,不覆盖
      if (cur.dirty) return s;
      // 内容没变(stat 触发但实际未改):无需重渲
      if (cur.originalContent === content) return s;
      const next: EditorTab = {
        ...cur,
        content,
        originalContent: content,
        dirty: false,
        // 外部内容已变 → 递增 epoch,让 Milkdown 视图按 key remount 拿新内容
        reloadEpoch: (cur.reloadEpoch ?? 0) + 1,
        milkdownUnsafe: computeMilkdownUnsafe(cur.filePath, content), // perf P4
      };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return { tabs };
    }),

  switchTab: (id) =>
    set((s) => ({
      activeTabId: id,
      editorFocusPulse: s.editorFocusPulse + 1,
    })),

  updateContent: (id, content) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      const next: EditorTab = {
        ...cur,
        content,
        dirty: content !== cur.originalContent,
        milkdownUnsafe: computeMilkdownUnsafe(cur.filePath, content), // perf P4
      };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return { tabs };
    }),

  markSaved: (id, savedContent) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      // 已写盘内容 = savedContent(省略则退化为当前内容)。dirty 反映"当前内容是否
      // 仍与磁盘一致":写盘 await 期间并发键入会让 cur.content 领先 savedContent,
      // 此时必须保留 dirty,否则那段增量既没落盘又不再触发 autosave → 静默丢失。
      const onDisk = savedContent ?? cur.content;
      const next: EditorTab = {
        ...cur,
        originalContent: onDisk,
        dirty: cur.content !== onDisk,
      };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return { tabs };
    }),

  setFilePath: (id, newPath) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      // perf P4:filePath 变(可能 .md↔.txt 改变 markdown 判定)→ 重算派生缓存。
      const next: EditorTab = {
        ...cur,
        id: newPath,
        filePath: newPath,
        milkdownUnsafe: computeMilkdownUnsafe(newPath, cur.content),
      };
      const tabs = s.tabs.slice();
      tabs[idx] = next;
      return {
        tabs,
        activeTabId: s.activeTabId === id ? newPath : s.activeTabId,
      };
    }),

  setMode: (mode) => set(() => ({ mode })),

  registerView: (tabId, view) =>
    set((s) => {
      const viewRefs = new Map(s.viewRefs);
      viewRefs.set(tabId, view);
      return { viewRefs };
    }),

  unregisterView: (tabId, expectedView) =>
    set((s) => {
      if (s.viewRefs.get(tabId) !== expectedView) return s;
      const viewRefs = new Map(s.viewRefs);
      viewRefs.delete(tabId);
      return { viewRefs };
    }),

  waitForViewRef: (tabId, timeoutMs = 500) => {
    const existing = get().viewRefs.get(tabId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      const finish = (view: EditorView | null) => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        clearTimeout(timeout);
        resolve(view);
      };
      const timeout = setTimeout(() => {
        finish(get().viewRefs.get(tabId) ?? null);
      }, timeoutMs);

      unsubscribe = api.subscribe((state) => {
        const view = state.viewRefs.get(tabId);
        if (view) finish(view);
      });

      const finalView = get().viewRefs.get(tabId);
      if (finalView) finish(finalView);
    });
  },
}));

function isMarkdownFilePath(filePath: string | null): boolean {
  // 可维护性 M13:markdown 扩展名判定共用 editor-path-utils.isMarkdownPath。
  if (!filePath) return false;
  return isMarkdownPath(filePath);
}

// 性能 P4:milkdownUnsafe 派生值的单一计算口径。content / filePath 任一变更时调一次,
// 结果缓存进 tab.milkdownUnsafe。isMilkdownUnsafe 跑未锚定 wiki-link 正则(O(file)),
// 故只在 markdown 文件上算(非 markdown 短路为 false,不扫描)。
export function computeMilkdownUnsafe(
  filePath: string | null,
  content: string,
): boolean {
  return isMarkdownFilePath(filePath) && isMilkdownUnsafe(content);
}

export function getEffectiveMode(tab: EditorTab | null): EditorMode {
  const requestedMode = useEditorStore.getState().mode;
  if (!tab) return requestedMode;
  // 读派生缓存;缺省(旧构造 / 未迁移路径)回退现场计算 —— 与历史逐字节等价。
  const unsafe =
    tab.milkdownUnsafe ?? computeMilkdownUnsafe(tab.filePath, tab.content);
  return unsafe ? 'source' : requestedMode;
}
