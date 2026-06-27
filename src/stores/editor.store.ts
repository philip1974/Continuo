// M-Editor Step E1:编辑器全局 store。
// 从 MindAutonAgent 移植 + Jotai → Zustand 重写;沿用 ADR-007 vanilla 模式。
//
// 持久化由 Step E5+ 接入(目前内存态,Editor MVP 不接 explorer.json,
// session 恢复留下里程碑)。

import { create } from 'zustand';
import type { EditorView } from '@codemirror/view';
import { isMilkdownUnsafe } from '@/panels/Editor/milkdown-roundtrip-safety';
import { isMarkdownPath } from '@/panels/Editor/editor-path-utils';
import { isSameOrInsidePath } from '@/lib/path-cross';
import {
  PATH_ARRAY_MAX,
  PATH_STR_MAX,
} from '../../electron/shared/explorer-persistence-schema';

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

  const remaining: EditorTab[] = [];
  for (let i = 0; i < tabs.length; i++) {
    if (i !== idx) remaining.push(tabs[i]!);
  }
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
  // 跨平台(codex 复查 P2,同 remove/close 族,单一来源 path-cross.isSameOrInsidePath):
  // 匹配平台感知大小写(Windows 运行时 `C:\Repo\dir` 匹配 tab `c:\repo\dir\a.md`,否则 tab
  // 指向失效旧路径)。后缀切片用**原** filePath + oldPath.length —— 大小写折叠不改长度,
  // oldPath 无尾分隔符故 slice 点正确;精确匹配时 slice 得 '' → newPath。
  const rewrite = (filePath: string): string | null =>
    isSameOrInsidePath(oldPath, filePath)
      ? newPath + filePath.slice(oldPath.length)
      : null;

  let newTabs: EditorTab[] | null = null;
  let nextActive = activeTabId;

  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i]!;
    if (t.filePath === null) {
      if (newTabs !== null) newTabs.push(t);
      continue;
    }
    const np = rewrite(t.filePath);
    let nextTab = t;

    if (np !== null) {
      if (newTabs === null) {
        newTabs = [];
        for (let j = 0; j < i; j++) newTabs.push(tabs[j]!);
      }
      // perf P4:filePath 变(可能改变 markdown 判定)→ 重算派生缓存(content 不变)。
      nextTab = {
        ...t,
        id: np,
        filePath: np,
        milkdownUnsafe: computeMilkdownUnsafe(np, t.content),
      };
      if (t.id === activeTabId) nextActive = nextTab.id;
    }

    if (newTabs !== null) newTabs.push(nextTab);
  }

  if (newTabs === null) return { tabs, activeTabId };
  return { tabs: newTabs, activeTabId: nextActive };
}

/**
 * 工作区 root 切换后的 tab 状态:
 * - untitled(filePath=null)tab 与 root 无关,始终保留
 * - **dirty(未保存编辑)tab 始终保留** —— 切 root 不得静默丢弃用户改动(审计):
 *   旧实现只按 filePath 位置判定,root 外的脏真实文件 tab 被直接关闭、编辑丢失
 * - filePath 等于 root 或位于其下(见 isSameOrInsidePath:跨平台分隔符 + 大小写)→ 保留
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
    return isSameOrInsidePath(root, tab.filePath);
  };

  const remaining: EditorTab[] = [];
  const removingIds = new Set<string>();
  let activeKept = false;
  let activeIdx = -1;

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    if (tab.id === activeTabId) activeIdx = i;
    if (keep(tab)) {
      remaining.push(tab);
      if (tab.id === activeTabId) activeKept = true;
    } else {
      removingIds.add(tab.id);
    }
  }

  if (remaining.length === tabs.length) return { tabs, activeTabId };
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (activeTabId !== null && activeKept) {
    return { tabs: remaining, activeTabId };
  }
  // active 被关:取原序后向第一个 remaining,否则前向,否则首个
  if (activeTabId !== null && activeIdx >= 0) {
    for (let i = activeIdx + 1; i < tabs.length; i++) {
      if (!removingIds.has(tabs[i]!.id)) {
        return { tabs: remaining, activeTabId: tabs[i]!.id };
      }
    }
    for (let i = activeIdx - 1; i >= 0; i--) {
      if (!removingIds.has(tabs[i]!.id)) {
        return { tabs: remaining, activeTabId: tabs[i]!.id };
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
  // 跨平台(codex 复查 P2):删除匹配走 isSameOrInsidePath —— Windows case-fold(`C:\Repo\dir`
  // 匹配 `c:\repo\dir\a.md`),否则 clean tab 不随删除/trash 关闭 → 用户基于已删旧路径保存
  // 复活文件;POSIX 保持大小写敏感。同前缀但非子(`/x/foo` 删 vs `/x/foobar.md`)仍不误匹配。
  const isMatch = (filePath: string | null): boolean =>
    filePath !== null && isSameOrInsidePath(removedPath, filePath);

  // 数据安全:dirty(未保存编辑)tab 不随文件删除/trash 自动关闭 —— 否则会绕过
  // EditorPanel 的 dirty 关闭确认,静默丢失内存里的未保存增量(磁盘旧版本进废纸篓
  // 可恢复,但内存增量无处可寻)。参考 VSCode:删除有未保存改动的文件保留 dirty
  // 编辑器。仅 clean tab 自动关闭;dirty tab 留给用户显式保存或经确认丢弃。
  const remaining: EditorTab[] = [];
  let changed = false;
  let activeKept = false;
  let activeRemoved = false;
  let seenActive = activeTabId === null;
  let lastKeptBeforeActive: EditorTab | null = null;
  let firstKeptAfterActive: EditorTab | null = null;

  for (const tab of tabs) {
    const isActive = tab.id === activeTabId;
    if (isActive) seenActive = true;
    const shouldRemove = isMatch(tab.filePath) && !tab.dirty;

    if (shouldRemove) {
      changed = true;
      if (isActive) activeRemoved = true;
      continue;
    }

    remaining.push(tab);
    if (isActive) {
      activeKept = true;
    } else if (!seenActive) {
      lastKeptBeforeActive = tab;
    } else if (firstKeptAfterActive === null) {
      firstKeptAfterActive = tab;
    }
  }

  if (!changed) return { tabs, activeTabId };
  if (remaining.length === 0) return { tabs: remaining, activeTabId: null };
  if (activeTabId === null || activeKept || !activeRemoved) {
    return { tabs: remaining, activeTabId };
  }
  const next = firstKeptAfterActive ?? lastKeptBeforeActive;
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
  /**
   * 性能 P12/P14:EditorHeader / TitleBar 派生状态的版本号 —— 覆盖每个 tab 的
   * id/filePath/dirty(chrome 条)+ **milkdownUnsafe**(影响 action 区 effectiveMode)
   * + 增删/改名。仅在这些真变化时递增(open/close/rename/setFilePath / markSaved-dirty /
   * updateContent·reloadFromDisk 的 **dirty 或 milkdownUnsafe 翻转**)。EditorHeader
   * (chrome + activeAction)与 TitleBar 订阅本 number(O(1) 比较)替代每按键
   * `tabs.find/map + JSON.stringify`(O(tab 数) 分配+序列化)。content 变但这些都不变时
   * 不递增 → 三处 selector 均命中、O(1) 跳过。runtime only,不持久化。
   */
  chromeVersion: number;
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

// perf P12:getStateAfter* 返回的新状态——tabs 引用变化(增删/改名)即 chrome 变,
// bump chromeVersion;无变化(返回原 tabs 引用)则原样返回,不触发 header 重算。
function bumpChromeIfTabsChanged(
  prev: { tabs: EditorTab[]; chromeVersion: number },
  next: CloseTabResult,
): CloseTabResult & { chromeVersion?: number } {
  return next.tabs !== prev.tabs
    ? { ...next, chromeVersion: prev.chromeVersion + 1 }
    : next;
}

export const useEditorStore = create<EditorState>((set, get, api) => ({
  tabs: [],
  activeTabId: null,
  mode: 'source',
  editorFocusPulse: 0,
  chromeVersion: 0,
  viewRefs: new Map(),

  openTab: (tab) =>
    set((s) => {
      const pulse = s.editorFocusPulse + 1;
      const exists = s.tabs.some((t) => t.id === tab.id);
      if (exists) return { activeTabId: tab.id, editorFocusPulse: pulse };
      // 边界(E278,E276/E277 同族 / 运行时状态守持久化契约):file tab 经 snapshotFromStores 序列化成
      // editor.openFilePaths(持久化 PATH_ARRAY_MAX=100000 cap + 单条 PATH_STR_MAX)。插件经 SDK openFile
      // 循环开海量文件 → tabs 超量 → openFilePaths 超上限 → explorer:write 拒整份 → 全 explorer 持久化失败。
      // 总 tab 数 ≥ PATH_ARRAY_MAX(untitled 极少,近似 file-tab 数)或 filePath 超 PATH_STR_MAX → 拒开(no-op)。
      if (
        s.tabs.length >= PATH_ARRAY_MAX ||
        (tab.filePath !== null && tab.filePath.length > PATH_STR_MAX)
      ) {
        return s;
      }
      return {
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        editorFocusPulse: pulse,
        chromeVersion: s.chromeVersion + 1, // perf P12:新增 tab → chrome 变
      };
    }),

  // perf P12:getStateAfter* 在无变化时返回原 tabs 引用,变化时返回新数组;据此
  // 决定是否 bump chromeVersion(增删/改名都改 chrome)。
  closeTab: (id) =>
    set((s) =>
      bumpChromeIfTabsChanged(s, getStateAfterClosingTab(s.tabs, s.activeTabId, id)),
    ),

  removePath: (path) =>
    set((s) =>
      bumpChromeIfTabsChanged(
        s,
        getStateAfterRemovingPath(s.tabs, s.activeTabId, path),
      ),
    ),

  renamePath: (oldPath, newPath) =>
    set((s) =>
      bumpChromeIfTabsChanged(
        s,
        getStateAfterRenamingPath(s.tabs, s.activeTabId, oldPath, newPath),
      ),
    ),

  closeTabsOutsideRoot: (root) =>
    set((s) =>
      bumpChromeIfTabsChanged(
        s,
        getStateAfterClosingTabsOutsideRoot(s.tabs, s.activeTabId, root),
      ),
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
      // perf P14:外部 reload 改 content,chrome(id/filePath/dirty)不变,但若 milkdownUnsafe
      // 翻转则 effectiveMode 变 → bump 让 EditorHeader action 区更新;否则不 bump。
      return !!next.milkdownUnsafe !== !!cur.milkdownUnsafe
        ? { tabs, chromeVersion: s.chromeVersion + 1 }
        : { tabs };
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
      // perf P12/P14:dirty 翻转 或 milkdownUnsafe 翻转(影响 EditorHeader action 区的
      // effectiveMode)才 bump;持续在已脏 tab 输入(dirty 恒 true、unsafe 不变)不 bump
      // → header chrome + action selector 均 O(1) 跳过。`!!` 归一化避免 undefined→false 误判。
      return next.dirty !== cur.dirty ||
        !!next.milkdownUnsafe !== !!cur.milkdownUnsafe
        ? { tabs, chromeVersion: s.chromeVersion + 1 }
        : { tabs };
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
      // perf P12:markSaved 改 dirty(脏标→已存)即 chrome 变;dirty 未变则不 bump。
      return next.dirty !== cur.dirty
        ? { tabs, chromeVersion: s.chromeVersion + 1 }
        : { tabs };
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
        chromeVersion: s.chromeVersion + 1, // perf P12:filePath 变 → chrome 变
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

// 性能 P4/P5:tab 是否 milkdown-unsafe 的**单一读取口径**。优先读派生缓存,缺省
// (旧构造 / 未迁移路径)回退现场计算 —— 与历史逐字节等价。getEffectiveMode 与
// EditorPanel 都经此读,避免任一处直接对 content 重跑未锚定 wiki-link 正则。
export function isTabMilkdownUnsafe(tab: EditorTab | null): boolean {
  if (!tab) return false;
  return tab.milkdownUnsafe ?? computeMilkdownUnsafe(tab.filePath, tab.content);
}

export function getEffectiveMode(tab: EditorTab | null): EditorMode {
  const requestedMode = useEditorStore.getState().mode;
  return isTabMilkdownUnsafe(tab) ? 'source' : requestedMode;
}
