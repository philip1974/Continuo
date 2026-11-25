// M-Editor Step E1:编辑器全局 store。
// 由早期项目的 Jotai 实现改写为 Zustand(`zustand` 的 create)。
//
// 打开的文件 tab 随 explorer.json 的窗口段持久化与恢复(见 lib/persist/explorer-persist 的
// collectEditorSnapshot / hydrateEditorTabs);内容本身不持久化,恢复时重新读盘。

import { create } from 'zustand';
import type { EditorView } from '@codemirror/view';
import { isMilkdownUnsafe } from '@/panels/Editor/milkdown-roundtrip-safety';
import { isMarkdownPath } from '@/panels/Editor/editor-path-utils';
import {
  containmentFold,
  containmentKey,
  isSameOrInsidePath,
  someContainmentCandidate,
} from '@/lib/path-cross';
import {
  PATH_ARRAY_MAX,
  PATH_STR_MAX,
} from '../../electron/shared/explorer-persistence-schema';
import { flushEditorWriteBacks } from '@/panels/Editor/editor-writeback-registry';
import {
  renameEditorViewStates,
  retainEditorViewStates,
} from '@/panels/Editor/editor-view-state-cache';
import { EDITOR_GROUPS_MAX, PRIMARY_EDITOR_GROUP_ID } from '../../electron/shared/editor-group-id';

// ── 类型 ─────────────────────────────────────────────────────

export type EditorMode = 'edit' | 'source' | 'preview';

export interface EditorTab {
  /** = filePath(打开时的路径拼写). */
  readonly id: string;
  readonly filePath: string;
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
   * 性能 P4:派生缓存 = `isMarkdownPath(filePath) && isMilkdownUnsafe(content)`。
   * 仅在 content / filePath 变更时(createTab / updateContent / reloadFromDisk /
   * 改名)算一次,避免 getEffectiveMode 在每次渲染 / Header selector 里对
   * 全文重复跑未锚定的 wiki-link 正则(长 Markdown 输入时 ~3 次 O(file)/按键)。
   * optional:缺省时 getEffectiveMode 回退到现场计算(行为等价,不破坏旧构造)。
   */
  readonly milkdownUnsafe?: boolean;
  /**
   * 变脏代际:取自模块级全局单调计数器(进程内唯一、永不复用),在 clean→dirty 跃迁、以及 markSaved 推进了
   * 已落盘基线但 tab 仍脏(保存期间继续输入)时赋新值;持续输入不变。关窗脏确认按 `${id}#${dirtyGen}` 上报身份
   * —— 「不保存」后保存再编辑、关闭重开同一路径再编辑、保存期间的新增量都是新改动,不在已接受范围内(复审)。
   * optional:缺省按 0。
   */
  readonly dirtyGen?: number;
  /**
   * 用户已对本 tab 确认「仍然切换」:milkdownUnsafe 的内容也允许进 Milkdown Edit。
   * 只由 acceptUnsafeEdit 置 true;按 tab 记,不影响其它 unsafe tab。runtime only。
   */
  readonly unsafeEditAccepted?: boolean;
  /**
   * filePath 为符号链接时其真实目标(main readFile 解析,见 shared FsReadFileData)。外部同步据此按目标
   * 目录 / 文件名匹配 dir-changed(FSEvents/inotify 报的是被实际修改的目录项名)。打开 / 会话恢复 /
   * reloadFromDisk 时随读盘结果更新;runtime only,不持久化(collectEditorSnapshot 只取 filePath)。
   */
  readonly realPath?: string;
  /**
   * 保存代际(性能:保存回声识别,见 panels/Editor/saved-disk-stat):markSaved 时写入本次保存记录的代际,
   * 外部同步只在 tab.savedGen 与记录代际一致时才信任该记录(tab 当前基线 = 那次写盘内容)。
   * 外部 reload 换了内容 → 清除;关闭重开的新 tab 无此值。runtime only,不持久化。
   */
  readonly savedGen?: number;
  /**
   * 安全:插件经 editor.openFile 打开的标签(openFileWithContent 建标签时设置)= 主进程为它记下的 canonical 路径。
   * 主进程对这类路径的宿主读 / 写先确认路径没被换入链接,但那份记录只在内存里:这类标签**不进会话快照**
   *(collectEditorSnapshot 跳过),否则重启后按路径恢复时不再受保护。标签关闭时释放主进程的记录
   *(见 plugin-opened-tabs)。之后用户自己再打开同一路径只是切换到这个标签,标记一直保留到标签关闭。runtime only。
   */
  readonly pluginOpenedPath?: string;
  /**
   * 文件已被删除(Explorer 删除 / 外部删除确认后仍不存在)而 tab 因有未保存修改保留(VSCode orphaned:tab 显示
   * 「(已删除)」+ 删除线)。置位后自动保存跳过(否则删除后几秒文件被写回);手动保存照常按路径重建并清除,
   * 重命名 / 移动、文件重新出现、还原也清除。runtime only,不持久化。
   */
  readonly orphaned?: boolean;
}

/**
 * 编辑器组(多实例编辑器 dock 面板;VSCode editor group):自己的 tab 顺序与活动 tab。文档本身(内容 / 脏态)在
 * `tabs` 里只有一份,所有组共享。**只有一个组时**,组的列表 / 活动 tab 就是 `tabs` / `activeTabId`(这里的
 * tabIds / activeTabId 不使用);多个组时由这里决定,`activeTabId` 镜像活动组的活动 tab。
 * BDD: src/__tests__/editor-groups/
 */
export interface EditorGroup {
  /** = dock 面板 id(`editor`、`editor:2`…)。 */
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

/** restoreGroups 的输入(会话恢复)。 */
export interface EditorGroupLayout {
  readonly id: string;
  readonly tabIds: readonly string[];
  readonly activeTabId: string | null;
}

// 变脏代际的全局单调计数器:按 tab 实例计数会在关闭重开同一路径后从 1 重算,与已接受的旧身份撞号(复审)。
let dirtyGenCounter = 0;

/**
 * 需要新身份时赋新变脏代际(见 EditorTab.dirtyGen):clean→dirty 跃迁,或已落盘基线推进后仍脏;否则不改。
 */
function withDirtyGen(cur: EditorTab, next: EditorTab): EditorTab {
  const fresh =
    next.dirty && (!cur.dirty || next.originalContent !== cur.originalContent);
  return fresh ? { ...next, dirtyGen: ++dirtyGenCounter } : next;
}

const EMPTY_EDITOR_TABS: EditorTab[] = [];

// ── 纯函数 helpers(便于单测) ────────────────────────────────

export function createTab(
  filePath: string,
  content: string,
  realPath?: string,
): EditorTab {
  const tab: EditorTab = {
    id: filePath,
    filePath,
    content,
    originalContent: content,
    dirty: false,
    milkdownUnsafe: computeMilkdownUnsafe(filePath, content), // perf P4
  };
  return realPath === undefined ? tab : { ...tab, realPath };
}

/** 按最新读盘结果设置 / 移除 realPath(未变则原样返回,保持对象 identity). */
function withRealPath(tab: EditorTab, realPath: string | undefined): EditorTab {
  if (tab.realPath === realPath) return tab;
  if (realPath !== undefined) return { ...tab, realPath };
  const { realPath: _drop, ...rest } = tab;
  return rest;
}

export function replaceTabAt(
  tabs: readonly EditorTab[],
  index: number,
  nextTab: EditorTab,
): EditorTab[] {
  if (tabs[index] === nextTab) return tabs as EditorTab[];
  const next = new Array<EditorTab>(tabs.length);
  for (let i = 0; i < tabs.length; i++) {
    next[i] = i === index ? nextTab : tabs[i]!;
  }
  return next;
}

export function appendEditorTab(
  tabs: readonly EditorTab[],
  tab: EditorTab,
): EditorTab[] {
  const next = new Array<EditorTab>(tabs.length + 1);
  for (let i = 0; i < tabs.length; i++) next[i] = tabs[i]!;
  next[tabs.length] = tab;
  return next;
}

export function findEditorTabIndexById(
  tabs: readonly EditorTab[],
  id: string,
): number {
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i]!.id === id) return i;
  }
  return -1;
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
  const closingIndex = findEditorTabIndexById(tabs, closingTabId);
  if (closingIndex < 0) return { tabs, activeTabId };

  const remaining = new Array<EditorTab>(tabs.length - 1);
  for (let i = 0; i < closingIndex; i++) remaining[i] = tabs[i]!;
  for (let i = closingIndex + 1; i < tabs.length; i++) {
    remaining[i - 1] = tabs[i]!;
  }

  if (remaining.length === 0) {
    return { tabs: EMPTY_EDITOR_TABS, activeTabId: null };
  }
  if (closingTabId !== activeTabId) {
    return { tabs: remaining, activeTabId };
  }
  // 关的是活跃 tab:优先取原序后向第一个,否则前一个。
  const next = tabs[closingIndex + 1] ?? tabs[closingIndex - 1] ?? null;
  return {
    tabs: remaining,
    activeTabId: next?.id ?? null,
  };
}

/**
 * 只回写某个 tab 变更(关闭 / 换 id)会影响到的 tab:按 pre-flush 的 tabs 跑一遍纯函数 `change`,
 * 结果里不再出现的旧 id 即受影响者。无受影响 tab 时不调用回写。
 */
function flushWriteBacksForAffectedTabs(
  tabs: EditorTab[],
  change: (tabs: EditorTab[], activeTabId: string | null) => CloseTabResult,
): void {
  const next = change(tabs, null).tabs;
  if (next === tabs) return;
  const kept = new Set<string>();
  for (const t of next) kept.add(t.id);
  const affected: string[] = [];
  for (const t of tabs) if (!kept.has(t.id)) affected.push(t.id);
  if (affected.length > 0) flushEditorWriteBacks(affected);
}

/**
 * 文件 / 目录被重命名 / 移动后的 tab 状态:
 * - 精确匹配 filePath === oldPath → 改 id+filePath 为 newPath
 * - 子文件(`oldPath/` 或 `oldPath\\` 前缀)→ 前缀 rewrite
 * - dirty / content / originalContent 全部保留
 * - activeTabId 跟随目标 tab id 改变
 */
export function getStateAfterRenamingPath(
  tabs: EditorTab[],
  activeTabId: string | null,
  oldPath: string,
  newPath: string,
): CloseTabResult {
  // 跨平台(复查 P2,同 remove/close 族,单一来源 path-cross.isSameOrInsidePath):
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
    const np = rewrite(t.filePath);
    let nextTab = t;

    if (np !== null) {
      if (newTabs === null) {
        newTabs = new Array<EditorTab>(tabs.length);
        for (let j = 0; j < i; j++) newTabs[j] = tabs[j]!;
      }
      // perf P4:filePath 变(可能改变 markdown 判定)→ 重算派生缓存(content 不变)。
      // 改名 / 移动到新路径 = 文件在新位置存在 → 清除已删除标记
      const { orphaned: _gone, ...rest } = t;
      nextTab = {
        ...rest,
        id: np,
        filePath: np,
        milkdownUnsafe: computeMilkdownUnsafe(np, t.content),
      };
      if (t.id === activeTabId) nextActive = nextTab.id;
    }

    if (newTabs !== null) newTabs[i] = nextTab;
  }

  if (newTabs === null) return { tabs, activeTabId };
  return { tabs: newTabs, activeTabId: nextActive };
}

interface TabFilterResult {
  /** 保留下来的 tab(原序);`changed=false` 时为空数组,调用方应直接沿用原 tabs。 */
  readonly remaining: EditorTab[];
  /** 是否有 tab 被移除。 */
  readonly changed: boolean;
  /** activeTabId 对应的 tab 在 tabs 里。 */
  readonly activeFound: boolean;
  /** active tab 被保留。 */
  readonly activeKept: boolean;
  /** active 被移除时的接替者:原序后向第一个保留项,否则前向最近的保留项,都没有则 null。 */
  readonly neighbor: EditorTab | null;
}

const NO_TABS_REMOVED: TabFilterResult = {
  remaining: [],
  changed: false,
  activeFound: false,
  activeKept: false,
  neighbor: null,
};

/**
 * 按 keep 过滤 tabs 的单趟核心(切 root 关 tab / 删除路径关 tab 共用):同时追踪 active tab 的
 * 去留与其相邻保留项,供调用方各自决定新的 activeTabId。无 tab 被移除时不分配数组(返回共享的
 * NO_TABS_REMOVED);首次遇到被移除项才惰性拷贝前缀。
 */
function filterTabsTrackingActive(
  tabs: readonly EditorTab[],
  activeTabId: string | null,
  keep: (tab: EditorTab) => boolean,
): TabFilterResult {
  let remaining: EditorTab[] | null = null;
  let count = 0;
  let activeFound = false;
  let activeKept = false;
  let seenActive = activeTabId === null;
  let lastKeptBeforeActive: EditorTab | null = null;
  let firstKeptAfterActive: EditorTab | null = null;

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i]!;
    const isActive = tab.id === activeTabId;
    if (isActive) {
      activeFound = true;
      seenActive = true;
    }
    if (!keep(tab)) {
      if (remaining === null) {
        remaining = new Array<EditorTab>(tabs.length - 1);
        for (let j = 0; j < count; j++) remaining[j] = tabs[j]!;
      }
      continue;
    }
    if (remaining !== null) remaining[count] = tab;
    count += 1;
    if (isActive) {
      activeKept = true;
    } else if (!seenActive) {
      lastKeptBeforeActive = tab;
    } else if (firstKeptAfterActive === null) {
      firstKeptAfterActive = tab;
    }
  }

  if (remaining === null) return NO_TABS_REMOVED;
  remaining.length = count;
  return {
    remaining,
    changed: true,
    activeFound,
    activeKept,
    neighbor: firstKeptAfterActive ?? lastKeptBeforeActive,
  };
}

/**
 * 工作区 root 切换后的 tab 状态:
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
  return closeCleanFileTabsUnless(tabs, activeTabId, (filePath) =>
    root !== null && isSameOrInsidePath(root, filePath),
  );
}

/**
 * 文件 / 目录被删除后的 tab 状态(单条参照实现;store 走批量版 getStateAfterRemovingPaths,测试用它做对照):
 * - 精确匹配 filePath === removedPath
 * - 或位于该目录下(`removedPath/` 或 `removedPath\\` 前缀)
 * - 同前缀但非子(如 `/x/foo` 删 vs `/x/foobar.md`)不误关
 * - active 被关 → 取原序后向第一个 remaining,否则前一个,否则 null
 */
export function getStateAfterRemovingPath(
  tabs: EditorTab[],
  activeTabId: string | null,
  removedPath: string,
): CloseTabResult {
  // 跨平台(复查 P2):删除匹配走 isSameOrInsidePath —— Windows case-fold(`C:\Repo\dir`
  // 匹配 `c:\repo\dir\a.md`),否则 clean tab 不随删除/trash 关闭 → 用户基于已删旧路径保存
  // 复活文件;POSIX 保持大小写敏感。同前缀但非子(`/x/foo` 删 vs `/x/foobar.md`)仍不误匹配。
  return removeMatchingCleanTabs(tabs, activeTabId, (filePath) =>
    isSameOrInsidePath(removedPath, filePath),
  );
}

/**
 * 批量版 getStateAfterRemovingPath(perf:逐条删除是 O(R·T) 比较 + R 次 set)。
 * 删除集合建祖先索引(containmentFold/Key 与 isSameOrInsidePath 精确等价),每个 tab 只查 O(depth)
 * 个候选键;最终 tabs / activeTabId 与按任意顺序逐条 getStateAfterRemovingPath 完全一致(active 被
 * 关时都落到「原序后向第一个保留项,否则前向最后一个」)。
 */
export function getStateAfterRemovingPaths(
  tabs: EditorTab[],
  activeTabId: string | null,
  removedPaths: readonly string[],
): CloseTabResult {
  if (removedPaths.length === 0) return { tabs, activeTabId };
  const fold = containmentFold();
  const removedKeys = new Set<string>();
  for (const removedPath of removedPaths) removedKeys.add(containmentKey(removedPath, fold));
  if (removedKeys.has('')) {
    return removeMatchingCleanTabs(tabs, activeTabId, () => true); // 纯分隔符根覆盖一切
  }
  const isRemovedKey = (key: string): boolean => removedKeys.has(key);
  return removeMatchingCleanTabs(tabs, activeTabId, (filePath) =>
    someContainmentCandidate(fold(filePath), isRemovedKey),
  );
}

/** 删除这些路径(目录含其下全部)会涉及的有未保存修改的 tab 数(Explorer 删除确认据此追加警告)。 */
export function countDirtyTabsUnder(tabs: readonly EditorTab[], paths: readonly string[]): number {
  let n = 0;
  for (const tab of tabs) {
    if (tab.dirty && paths.some((p) => isSameOrInsidePath(p, tab.filePath))) n++;
  }
  return n;
}

function removeMatchingCleanTabs(
  tabs: EditorTab[],
  activeTabId: string | null,
  isRemoved: (filePath: string) => boolean,
): CloseTabResult {
  const r = closeCleanFileTabsUnless(tabs, activeTabId, (filePath) => !isRemoved(filePath));
  // 留下来的被删路径 tab 都是脏的(未保存修改不丢):标记 orphaned(见 EditorTab.orphaned)。
  let out: EditorTab[] | null = null;
  for (let i = 0; i < r.tabs.length; i++) {
    const t = r.tabs[i]!;
    if (t.orphaned || !isRemoved(t.filePath)) continue;
    out ??= r.tabs.slice();
    out[i] = { ...t, orphaned: true };
  }
  return out === null ? r : { tabs: out, activeTabId: r.activeTabId };
}

/**
 * 按条件关闭 **clean 的文件 tab**(切 root / 删除共用,此前两份逐段同构、活动 tab 回退规则不一):
 * - dirty(未保存编辑)tab 始终保留 —— 否则绕过 dirty 关闭确认、静默丢失内存增量
 *  (参考 VSCode:删除 / 切走有未保存改动的文件保留其编辑器)
 * - 其余 clean 文件 tab 由 keepCleanFile 决定
 * - 活动 tab 被关 → 原序后向第一个保留项,否则前向;活动 tab 本就不在列表里(null / 已失效)而仍有保留项 → 首个
 */
function closeCleanFileTabsUnless(
  tabs: EditorTab[],
  activeTabId: string | null,
  keepCleanFile: (filePath: string) => boolean,
): CloseTabResult {
  const r = filterTabsTrackingActive(
    tabs,
    activeTabId,
    (tab) => tab.dirty || keepCleanFile(tab.filePath),
  );
  if (!r.changed) return { tabs, activeTabId };
  if (r.remaining.length === 0) {
    return { tabs: EMPTY_EDITOR_TABS, activeTabId: null };
  }
  if (r.activeKept) return { tabs: r.remaining, activeTabId };
  if (r.activeFound) return { tabs: r.remaining, activeTabId: r.neighbor?.id ?? null };
  return { tabs: r.remaining, activeTabId: r.remaining[0]!.id };
}

// ── Zustand store ────────────────────────────────────────────

/**
 * openTab / switchTab 选项。`requestFocus: false` = 不是「请求 editor 在 dock 内激活」
 * (持久化会话恢复 hydrateEditorTabs):不递增 editorFocusPulse,DockShell 不据此抢走
 * Dock 恢复出的活动面板。缺省 true(用户打开 / 切换文件,#22 语义不变)。
 */
export interface EditorFocusOpts {
  readonly requestFocus?: boolean;
  /**
   * 目标编辑器组(缺省 = 活动组)。显式指定且 requestFocus 非 false → 该组成为活动组(在某组的 tab 栏点击)。
   * 只有一个组时忽略。BDD: src/__tests__/editor-groups/
   */
  readonly groupId?: string;
  /**
   * 仅 openTab:`false` = 只插入不激活(当前已有活动 tab 时保持 activeTabId 不变;无活动 tab 时仍激活新 tab)。
   * 供迟到的会话恢复在用户已打开/切换 tab 后补入恢复 tab 而不抢回活动 tab。缺省 true。
   */
  readonly activate?: boolean;
}

function nextFocusPulse(pulse: number, opts: EditorFocusOpts | undefined): number {
  return opts?.requestFocus === false ? pulse : pulse + 1;
}

/**
 * 用户激活代际:每次「用户选择要激活哪个 tab」递增 —— switchTab(tab 栏点击 / 打开已开文件,requestFocus
 * 非 false)与 openFileByPath 发起读盘时(beginUserActivation)。openFileByPath 读盘前记下代际、读完比较,
 * 已被更晚的用户选择超越 → 只后台加入,不抢激活/焦点。不计入:会话恢复(requestFocus:false)、openTab 本身
 * (唯一的用户入口 openFileByPath 已在发起读盘时计入)、closeTab(关 tab 后相邻 tab 接替不是对某个文件的
 * 选择,用户刚点的文件读完仍应激活)。runtime only,不进 state(不触发订阅者)。
 */
let userActivationGen = 0;

export function getUserActivationGen(): number {
  return userActivationGen;
}

export function beginUserActivation(): number {
  return ++userActivationGen;
}

type EditorState = {
  tabs: EditorTab[];
  /** 活动组的活动 tab(只有一个组时即该组的活动 tab)。 */
  activeTabId: string | null;
  /** 编辑器组(至少一个);见 EditorGroup。 */
  groups: EditorGroup[];
  /** 最近活动的编辑器组:打开文件落在这里。 */
  activeGroupId: string;
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
   * + 增删/改名。仅在这些真变化时递增(open/close/rename / markSaved-dirty /
   * updateContent·reloadFromDisk 的 **dirty 或 milkdownUnsafe 翻转**)。EditorHeader
   * (chrome + activeAction)与 TitleBar 订阅本 number(O(1) 比较)替代每按键
   * `tabs.find/map + JSON.stringify`(O(tab 数) 分配+序列化)。content 变但这些都不变时
   * 不递增 → 三处 selector 均命中、O(1) 跳过。runtime only,不持久化。
   */
  chromeVersion: number;
  /** runtime only, not persisted - CodeMirror EditorView refs per tab */
  viewRefs: Map<string, EditorView>;

  /** 已存在则切换 active,新加则推入. `requestFocus: false`(持久化会话恢复)不递增 editorFocusPulse. */
  openTab: (tab: EditorTab, opts?: EditorFocusOpts) => void;
  /** 关闭组 `groupId`(缺省活动组)里的 tab;文档不在其它组时一并移除。组因此变空且不是唯一的组 → 关闭该组。 */
  closeTab: (id: string, groupId?: string) => void;
  /** 该组成为活动组(dock 面板激活 / 编辑区获焦)。不存在 → no-op。 */
  setActiveGroup: (groupId: string) => void;
  /** 确保组存在(恢复出的组面板挂载时;新组为空,不改活动组)。 */
  ensureGroup: (groupId: string) => void;
  /**
   * 拆分:在 sourceGroupId 之后新建组 newGroupId,打开源组的活动文件(或指定的 tabId;null = 新建空组),新组成为活动组。
   * 源组不存在 / 无可拆分的文件 / newGroupId 已存在 / 组数已达上限 → false。
   */
  splitGroup: (sourceGroupId: string, newGroupId: string, tabId?: string | null) => boolean;
  /**
   * 移除组(其 dock 面板被关掉):只在该组的文档 —— keep 'all' 全部移到相邻组;'dirty' 只移脏的、干净的关闭。
   * 唯一的组不移除。
   */
  removeGroup: (groupId: string, keep: 'dirty' | 'all') => void;
  /** 会话恢复:按布局分配已打开的文档(未分配的进活动组;不存在的文档与空组丢弃)。 */
  restoreGroups: (layout: readonly EditorGroupLayout[], activeGroupId: string) => void;
  /** 文件/目录被删除后调用:精确匹配或前缀匹配的 clean tab 统一关闭,只 set 一次(chromeVersion 至多 bump 一次). */
  removePaths: (paths: readonly string[]) => void;
  /** 文件/目录被重命名 / 移动时调用:精确或前缀匹配的 tab 同步路径. */
  renamePath: (oldPath: string, newPath: string) => void;
  /**
   * 外部修改时调用:非 dirty tab 同步 content+originalContent;dirty 跳过。realPath = 本次读盘
   * 结果的符号链接真实目标(缺省 = 非链接,移除旧值)。
   * `discardChanges`:还原文件(workbench.action.files.revert / 冲突时「放弃更改并重新加载」)——
   * dirty tab 也换成磁盘内容,未保存的修改丢弃。
   */
  reloadFromDisk: (
    tabId: string,
    content: string,
    realPath?: string,
    opts?: { readonly discardChanges?: boolean },
  ) => void;
  /**
   * 外部同步对脏 tab 的存在性检查结果:确认已删除 → true(只标记脏 tab,干净 tab 由 removePaths 关闭);
   * 文件重新出现 → false。值不变为 no-op。
   */
  setOrphaned: (tabId: string, orphaned: boolean) => void;
  /** 工作区切换时调用:关闭 root 外的 clean file tabs(dirty 保留). */
  closeTabsOutsideRoot: (root: string | null) => void;
  switchTab: (id: string, opts?: EditorFocusOpts) => void;
  /** 编辑器 onChange 时调用;dirty 自动比对. */
  updateContent: (id: string, content: string) => void;
  /**
   * 保存成功后调用。`savedContent` 是实际写盘的内容快照:
   *   - 期间无并发编辑(cur.content === savedContent)→ originalContent ← savedContent,
   *     dirty=false(正常路径)。
   *   - 写盘 await 期间用户继续键入(cur.content !== savedContent)→ originalContent
   *     推进到 savedContent 但**保留 dirty=true**,使这段增量不被静默吞掉、后续
   *     autosave 会再写。省略 savedContent 时退化为旧语义(originalContent ← content)。
   * `savedGen`:本次保存记录的代际(见 EditorTab.savedGen);缺省 = 无记录,清除旧代际。
   */
  markSaved: (id: string, savedContent?: string, savedGen?: number) => void;
  setMode: (mode: EditorMode) => void;
  /** unsafe markdown 的「仍然切换」确认:允许该 tab 在 Edit 模式下用 Milkdown. */
  acceptUnsafeEdit: (id: string) => void;
  registerView: (tabId: string, view: EditorView) => void;
  unregisterView: (tabId: string, expectedView: EditorView) => void;
  waitForViewRef: (
    tabId: string,
    timeoutMs: number,
  ) => Promise<EditorView | null>;
};

// perf P12:getStateAfter* 返回的新状态——tabs 引用变化(增删/改名)即 chrome 变,
// bump chromeVersion;tabs 与 active 都未变时返回原 state,避免 no-op action 通知订阅者。
function applyTabStateChange(
  prev: {
    tabs: EditorTab[];
    activeTabId: string | null;
    chromeVersion: number;
  },
  next: CloseTabResult,
): typeof prev | (CloseTabResult & { chromeVersion?: number }) {
  if (next.tabs === prev.tabs && next.activeTabId === prev.activeTabId) {
    return prev;
  }
  return next.tabs !== prev.tabs
    ? { ...next, chromeVersion: prev.chromeVersion + 1 }
    : next;
}

/**
 * chromeVersion 覆盖的单 tab 字段(EditorHeader chrome / action 区的 effectiveMode、TitleBar、关窗脏确认上报的
 * 变脏代际)。新增影响这些 UI 的 tab 字段只需加在这里(此前每个 action 各写一套「是否 bump」判定,markSaved
 * 曾漏判 dirtyGen)。`!!` 归一化 undefined / false。
 */
function tabChromeChanged(prev: EditorTab, next: EditorTab): boolean {
  return (
    prev.id !== next.id ||
    prev.filePath !== next.filePath ||
    prev.dirty !== next.dirty ||
    prev.dirtyGen !== next.dirtyGen ||
    !!prev.milkdownUnsafe !== !!next.milkdownUnsafe ||
    !!prev.unsafeEditAccepted !== !!next.unsafeEditAccepted ||
    !!prev.orphaned !== !!next.orphaned
  );
}

/** 替换第 idx 个 tab;chrome 字段变了才 bump chromeVersion(内容变而 chrome 不变时 selector O(1) 跳过)。 */
function replaceTabBumpingChrome(
  s: Pick<EditorState, 'tabs' | 'chromeVersion'>,
  idx: number,
  next: EditorTab,
): Pick<EditorState, 'tabs'> & Partial<Pick<EditorState, 'chromeVersion'>> {
  const tabs = replaceTabAt(s.tabs, idx, next);
  return tabChromeChanged(s.tabs[idx]!, next) ? { tabs, chromeVersion: s.chromeVersion + 1 } : { tabs };
}

/**
 * 关闭 / 换 id 类的 tab 变更:先只回写受影响的 tab(按 pre-flush 状态算),再按同一纯函数应用到最新状态。
 */
function changeTabsWithWriteBack(
  get: () => EditorState,
  set: (fn: (s: EditorState) => EditorState | Partial<EditorState>) => void,
  change: (tabs: EditorTab[], activeTabId: string | null) => CloseTabResult,
): void {
  flushWriteBacksForAffectedTabs(get().tabs, change);
  set((s) =>
    isMultiGroup(s)
      ? applyDocChangeToGroups(s, change)
      : applyTabStateChange(s, change(s.tabs, s.activeTabId)),
  );
}

// ── 编辑器组(BDD: src/__tests__/editor-groups/) ──────────────

type GroupedState = Pick<
  EditorState,
  'tabs' | 'activeTabId' | 'groups' | 'activeGroupId' | 'chromeVersion'
>;

const EMPTY_IDS: readonly string[] = [];

function singleGroup(id: string): EditorGroup[] {
  return [{ id, tabIds: EMPTY_IDS, activeTabId: null }];
}

function isMultiGroup(s: Pick<EditorState, 'groups'>): boolean {
  return s.groups.length > 1;
}

function idsOf(tabs: readonly { readonly id: string }[]): string[] {
  const out = new Array<string>(tabs.length);
  for (let i = 0; i < tabs.length; i++) out[i] = tabs[i]!.id;
  return out;
}

/** 组的实际内容:单组模式按 tabs / activeTabId 物化(该组记录的 tabIds 不使用)。 */
function materializedGroups(s: Pick<EditorState, 'tabs' | 'activeTabId' | 'groups'>): readonly EditorGroup[] {
  if (isMultiGroup(s)) return s.groups;
  const only = s.groups[0];
  const active = s.activeTabId !== null && findEditorTabIndexById(s.tabs, s.activeTabId) >= 0 ? s.activeTabId : null;
  return [{ id: only?.id ?? PRIMARY_EDITOR_GROUP_ID, tabIds: idsOf(s.tabs), activeTabId: active }];
}

/** 各组的实际内容(按组顺序;单组模式按 tabs / activeTabId 物化)。 */
export function editorGroupsOf(s: Pick<EditorState, 'tabs' | 'activeTabId' | 'groups'>): readonly EditorGroup[] {
  return materializedGroups(s);
}

/** 组的 id 列表(按组顺序)。 */
export function editorGroupIdsOf(s: Pick<EditorState, 'groups'>): string[] {
  return idsOf(s.groups.length > 0 ? s.groups : singleGroup(PRIMARY_EDITOR_GROUP_ID));
}

function findGroup(s: Pick<EditorState, 'groups'>, groupId: string): EditorGroup | undefined {
  for (const g of s.groups) if (g.id === groupId) return g;
  return undefined;
}

/**
 * 组 groupId 的 tab(按该组顺序);单组模式 = tabs。不存在的组 → 空(如刚被关闭、还在退出动画里的组面板,不显示别组内容)。
 */
export function groupTabsOf(s: Pick<EditorState, 'tabs' | 'groups'>, groupId: string): EditorTab[] {
  if (!isMultiGroup(s)) return s.groups[0]?.id === groupId ? s.tabs : EMPTY_EDITOR_TABS;
  const g = findGroup(s, groupId);
  if (!g || g.tabIds.length === 0) return EMPTY_EDITOR_TABS;
  const byId = new Map<string, EditorTab>();
  for (const t of s.tabs) byId.set(t.id, t);
  const out: EditorTab[] = [];
  for (const id of g.tabIds) {
    const t = byId.get(id);
    if (t) out.push(t);
  }
  return out;
}

/** 组 groupId 的活动 tab id;单组模式 = activeTabId;不存在的组 → null。 */
export function groupActiveTabIdOf(
  s: Pick<EditorState, 'activeTabId' | 'groups'>,
  groupId: string,
): string | null {
  if (!isMultiGroup(s)) return s.groups[0]?.id === groupId ? s.activeTabId : null;
  return findGroup(s, groupId)?.activeTabId ?? null;
}

/** 文档 tabId 是否还在 groupId 之外的组里打开(关闭 / 组内批量关闭的脏确认据此跳过:文档仍在别处)。 */
export function isTabOpenInOtherGroup(
  s: Pick<EditorState, 'groups'>,
  tabId: string,
  groupId: string,
): boolean {
  if (!isMultiGroup(s)) return false;
  return s.groups.some((g) => g.id !== groupId && g.tabIds.includes(tabId));
}

function replaceGroup(groups: readonly EditorGroup[], next: EditorGroup): EditorGroup[] {
  return groups.map((g) => (g.id === next.id ? next : g));
}

/**
 * 组变更的统一提交:关闭「本次变空」的组(closeEmptyGroups;本就为空的恢复占位组不动)、至少保留一个组、活动组被关
 * 落到相邻组;只剩一个组 → 单组模式(tabs 按该组顺序)。activeTabId 镜像活动组;有变化才 bump chromeVersion。
 */
function commitGroups(
  s: GroupedState,
  tabs: EditorTab[],
  groups: readonly EditorGroup[],
  activeGroupId: string,
  prevGroups: readonly EditorGroup[] = materializedGroups(s),
): Partial<EditorState> {
  const wasNonEmpty = new Set<string>();
  for (const g of prevGroups) if (g.tabIds.length > 0) wasNonEmpty.add(g.id);
  let kept = groups.filter((g) => g.tabIds.length > 0 || !wasNonEmpty.has(g.id));
  if (kept.length === 0) {
    const keep = groups.find((g) => g.id === activeGroupId) ?? groups[0];
    kept = keep ? [{ id: keep.id, tabIds: EMPTY_IDS, activeTabId: null }] : singleGroup(PRIMARY_EDITOR_GROUP_ID);
  }
  let active = kept.find((g) => g.id === activeGroupId);
  if (!active) {
    // 活动组被关:落到原顺序里它前面最近的保留组,否则第一个
    const order = idsOf(groups.length > 0 ? groups : prevGroups);
    const idx = order.indexOf(activeGroupId);
    for (let i = idx - 1; i >= 0 && !active; i--) active = kept.find((g) => g.id === order[i]);
    active ??= kept[0]!;
  }
  if (kept.length === 1) {
    const only = kept[0]!;
    const byId = new Map<string, EditorTab>();
    for (const t of tabs) byId.set(t.id, t);
    const ordered: EditorTab[] = [];
    for (const id of only.tabIds) {
      const t = byId.get(id);
      if (t && byId.delete(id)) ordered.push(t);
    }
    for (const t of byId.values()) ordered.push(t); // 防御:不该有游离文档
    const sameOrder = ordered.length === s.tabs.length && ordered.every((t, i) => t === s.tabs[i]);
    return {
      tabs: sameOrder ? s.tabs : ordered.length === 0 ? EMPTY_EDITOR_TABS : ordered,
      activeTabId: only.activeTabId,
      groups: singleGroup(only.id),
      activeGroupId: only.id,
      chromeVersion: s.chromeVersion + 1,
    };
  }
  return {
    tabs,
    activeTabId: active.activeTabId,
    groups: kept,
    activeGroupId: active.id,
    chromeVersion: s.chromeVersion + 1,
  };
}

/** 文档级变更(删除路径 / 改名 / 切 root):全局按 change 重算文档列表,每组按同一规则重算其列表与活动 tab。 */
function applyDocChangeToGroups(
  s: GroupedState,
  change: (tabs: EditorTab[], activeTabId: string | null) => CloseTabResult,
): GroupedState | Partial<EditorState> {
  const nextTabs = change(s.tabs, null).tabs;
  if (nextTabs === s.tabs) return s;
  const byId = new Map<string, EditorTab>();
  for (const t of s.tabs) byId.set(t.id, t);
  const groups = s.groups.map((g): EditorGroup => {
    const own: EditorTab[] = [];
    for (const id of g.tabIds) {
      const t = byId.get(id);
      if (t) own.push(t);
    }
    const r = change(own, g.activeTabId);
    return { id: g.id, tabIds: idsOf(r.tabs), activeTabId: r.activeTabId };
  });
  return commitGroups(s, nextTabs, groups, s.activeGroupId, s.groups);
}

/** 从 id 列表移除 closing,活动项被关时落到后一个、否则前一个(同 getStateAfterClosingTab)。 */
function closeIdInGroup(g: EditorGroup, closing: string): EditorGroup {
  const idx = g.tabIds.indexOf(closing);
  if (idx < 0) return g;
  const tabIds = g.tabIds.filter((id) => id !== closing);
  const activeTabId =
    g.activeTabId !== closing ? g.activeTabId : (g.tabIds[idx + 1] ?? g.tabIds[idx - 1] ?? null);
  return { id: g.id, tabIds, activeTabId };
}

/** 组 g 里激活 tabId(不在组里则追加);keepActive:组已有活动 tab 时只追加不激活。 */
function activateInGroup(g: EditorGroup, tabId: string, keepActive: boolean): EditorGroup {
  const has = g.tabIds.includes(tabId);
  const activeTabId = keepActive && g.activeTabId !== null ? g.activeTabId : tabId;
  if (has && activeTabId === g.activeTabId) return g;
  return { id: g.id, tabIds: has ? g.tabIds : [...g.tabIds, tabId], activeTabId };
}

function targetGroupId(s: Pick<EditorState, 'groups' | 'activeGroupId'>, opts?: EditorFocusOpts): string {
  const id = opts?.groupId;
  return id !== undefined && findGroup(s, id) ? id : s.activeGroupId;
}

/** 显式指定组且是用户意图 → 该组成为活动组。 */
function nextActiveGroupId(s: Pick<EditorState, 'activeGroupId'>, gid: string, opts?: EditorFocusOpts): string {
  return opts?.groupId !== undefined && opts.requestFocus !== false ? gid : s.activeGroupId;
}

export const useEditorStore = create<EditorState>((set, get, api) => ({
  tabs: [],
  activeTabId: null,
  groups: singleGroup(PRIMARY_EDITOR_GROUP_ID),
  activeGroupId: PRIMARY_EDITOR_GROUP_ID,
  mode: 'source',
  editorFocusPulse: 0,
  chromeVersion: 0,
  viewRefs: new Map(),

  openTab: (tab, opts) =>
    set((s) => {
      const pulse = nextFocusPulse(s.editorFocusPulse, opts);
      if (isMultiGroup(s)) {
        const gid = targetGroupId(s, opts);
        const g = findGroup(s, gid)!;
        const exists = findEditorTabIndexById(s.tabs, tab.id) >= 0;
        if (!exists && (s.tabs.length >= PATH_ARRAY_MAX || tab.filePath.length > PATH_STR_MAX)) return s;
        const nextG = activateInGroup(g, tab.id, opts?.activate === false);
        const activeGroupId = nextActiveGroupId(s, gid, opts);
        if (exists && nextG === g && activeGroupId === s.activeGroupId) {
          return opts?.activate === false && g.activeTabId !== null ? s : { editorFocusPulse: pulse };
        }
        const groups = replaceGroup(s.groups, nextG);
        const active = groups.find((x) => x.id === activeGroupId)!;
        return {
          tabs: exists ? s.tabs : appendEditorTab(s.tabs, tab),
          groups,
          activeGroupId,
          activeTabId: active.activeTabId,
          editorFocusPulse: pulse,
          chromeVersion: s.chromeVersion + 1,
        };
      }
      const keepActive = opts?.activate === false && s.activeTabId !== null;
      const existingIndex = findEditorTabIndexById(s.tabs, tab.id);
      if (existingIndex >= 0) {
        return keepActive ? s : { activeTabId: tab.id, editorFocusPulse: pulse };
      }
      // 边界(E278,E276/E277 同族 / 运行时状态守持久化契约):file tab 经 snapshotFromStores 序列化成
      // editor.openFilePaths(持久化 PATH_ARRAY_MAX=100000 cap + 单条 PATH_STR_MAX)。插件经 SDK openFile
      // 循环开海量文件 → tabs 超量 → openFilePaths 超上限 → explorer:write 拒整份 → 全 explorer 持久化失败。
      // 总 tab 数 ≥ PATH_ARRAY_MAX 或 filePath 超 PATH_STR_MAX → 拒开(no-op)。
      if (s.tabs.length >= PATH_ARRAY_MAX || tab.filePath.length > PATH_STR_MAX) {
        return s;
      }
      return {
        tabs: appendEditorTab(s.tabs, tab),
        activeTabId: keepActive ? s.activeTabId : tab.id,
        editorFocusPulse: pulse,
        chromeVersion: s.chromeVersion + 1, // perf P12:新增 tab → chrome 变
      };
    }),

  // perf P12:getStateAfter* 在无变化时返回原 tabs 引用,变化时返回新数组;据此
  // 决定是否 bump chromeVersion(增删/改名都改 chrome)。
  closeTab: (id, groupId) =>
    set((s) => {
      if (!isMultiGroup(s)) {
        return applyTabStateChange(s, getStateAfterClosingTab(s.tabs, s.activeTabId, id));
      }
      const g = findGroup(s, groupId ?? s.activeGroupId);
      if (!g || !g.tabIds.includes(id)) return s;
      const openElsewhere = isTabOpenInOtherGroup(s, id, g.id);
      const tabs = openElsewhere ? s.tabs : getStateAfterClosingTab(s.tabs, null, id).tabs;
      return commitGroups(s, tabs, replaceGroup(s.groups, closeIdInGroup(g, id)), s.activeGroupId);
    }),

  setActiveGroup: (groupId) =>
    set((s) => {
      if (!isMultiGroup(s) || s.activeGroupId === groupId) return s;
      const g = findGroup(s, groupId);
      return g ? { activeGroupId: g.id, activeTabId: g.activeTabId } : s;
    }),

  ensureGroup: (groupId) =>
    set((s) => {
      const groups = materializedGroups(s);
      if (groups.some((g) => g.id === groupId) || groups.length >= EDITOR_GROUPS_MAX) return s;
      return commitGroups(s, s.tabs, [...groups, { id: groupId, tabIds: EMPTY_IDS, activeTabId: null }], s.activeGroupId);
    }),

  splitGroup: (sourceGroupId, newGroupId, tabId) => {
    const s = get();
    const groups = materializedGroups(s);
    const idx = groups.findIndex((g) => g.id === sourceGroupId);
    const source = groups[idx];
    const docId = tabId === undefined ? (source?.activeTabId ?? null) : tabId;
    if (
      !source ||
      (docId === null ? tabId !== null : findEditorTabIndexById(s.tabs, docId) < 0) ||
      groups.some((g) => g.id === newGroupId) ||
      groups.length >= EDITOR_GROUPS_MAX
    ) {
      return false;
    }
    const next = [...groups];
    next.splice(idx + 1, 0, { id: newGroupId, tabIds: docId === null ? EMPTY_IDS : [docId], activeTabId: docId });
    set((cur) => ({
      ...commitGroups(cur, cur.tabs, next, newGroupId),
      editorFocusPulse: cur.editorFocusPulse + 1,
    }));
    return true;
  },

  removeGroup: (groupId, keep) => {
    const pre = get();
    if (!isMultiGroup(pre) || !findGroup(pre, groupId)) return;
    flushEditorWriteBacks(findGroup(pre, groupId)!.tabIds);
    set((s) => {
      const idx = s.groups.findIndex((g) => g.id === groupId);
      if (!isMultiGroup(s) || idx < 0) return s;
      const g = s.groups[idx]!;
      const others = s.groups.filter((x) => x.id !== groupId);
      const target = others[Math.max(0, idx - 1)]!;
      const byId = new Map<string, EditorTab>();
      for (const t of s.tabs) byId.set(t.id, t);
      const exclusive = g.tabIds.filter((id) => !others.some((o) => o.tabIds.includes(id)));
      const move = keep === 'all' ? exclusive : exclusive.filter((id) => byId.get(id)?.dirty === true);
      const closed = new Set(exclusive.filter((id) => !move.includes(id)));
      const nextTarget: EditorGroup = {
        id: target.id,
        tabIds: [...target.tabIds, ...move],
        activeTabId: target.activeTabId ?? move[0] ?? null,
      };
      const tabs = closed.size === 0 ? s.tabs : s.tabs.filter((t) => !closed.has(t.id));
      const activeGroupId = s.activeGroupId === groupId ? target.id : s.activeGroupId;
      return commitGroups(s, tabs, replaceGroup(others, nextTarget), activeGroupId, others);
    });
  },

  restoreGroups: (layout, activeGroupId) =>
    set((s) => {
      if (s.tabs.length === 0) return s;
      const open = new Set(idsOf(s.tabs));
      const assigned = new Set<string>();
      const seenGroups = new Set<string>();
      const draft: { id: string; tabIds: string[]; wanted: string | null }[] = [];
      for (const l of layout) {
        if (seenGroups.has(l.id) || draft.length >= EDITOR_GROUPS_MAX) continue;
        seenGroups.add(l.id);
        // 同一文档可在多个组;组内去重
        const tabIds = [...new Set(l.tabIds)].filter((id) => open.has(id));
        for (const id of tabIds) assigned.add(id);
        draft.push({ id: l.id, tabIds, wanted: l.activeTabId });
      }
      let ai = draft.findIndex((g) => g.id === activeGroupId);
      if (ai < 0) ai = draft.findIndex((g) => g.tabIds.length > 0);
      if (ai < 0) return s;
      for (const t of s.tabs) if (!assigned.has(t.id)) draft[ai]!.tabIds.push(t.id);
      const groups: EditorGroup[] = draft.map((d) => ({
        id: d.id,
        tabIds: d.tabIds,
        activeTabId: d.wanted !== null && d.tabIds.includes(d.wanted) ? d.wanted : (d.tabIds[0] ?? null),
      }));
      // 恢复布局里没有文档的组(读盘失败)丢弃;此前为恢复出的面板占位的空组同样不保留
      const kept = groups.filter((g) => g.tabIds.length > 0);
      return commitGroups(s, s.tabs, kept, groups[ai]!.id, kept);
    }),

  // 先按 pre-flush 状态算出受影响(将被关闭 / 换 id)的 tab,只回写它们 —— 回写会把正在编辑的大文档
  // 整篇序列化并提前上抛,不相关的删除 / 改名 / 切 root 不应打断输入。回写只改 content / dirty,
  // 不改 id 与路径匹配;回写后变脏的 tab 按既有规则保留。
  removePaths: (paths) =>
    changeTabsWithWriteBack(get, set, (tabs, active) =>
      getStateAfterRemovingPaths(tabs, active, paths),
    ),

  // 换 tab id 前按旧 id 回写:卸载回写的闭包仍持旧 id,换完就找不到 tab 而丢弃。
  // 编辑器视图状态(撤销历史 / 光标 / 滚动)随 tab 迁到新 id(BDD: src/__tests__/editor-view-state/)。
  renamePath: (oldPath, newPath) => {
    const { tabs, viewRefs } = get();
    const renamed = getStateAfterRenamingPath(tabs, null, oldPath, newPath).tabs;
    if (renamed !== tabs) {
      const pairs: Array<readonly [string, string]> = [];
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i]!.id !== renamed[i]!.id) pairs.push([tabs[i]!.id, renamed[i]!.id]);
      }
      renameEditorViewStates(pairs, (id) => viewRefs.get(id));
    }
    changeTabsWithWriteBack(get, set, (cur, active) =>
      getStateAfterRenamingPath(cur, active, oldPath, newPath),
    );
  },

  closeTabsOutsideRoot: (root) =>
    changeTabsWithWriteBack(get, set, (tabs, active) =>
      getStateAfterClosingTabsOutsideRoot(tabs, active, root),
    ),

  reloadFromDisk: (tabId, content, realPath, opts) => {
    const discard = opts?.discardChanges === true;
    // 只回写被重载的 tab:未上抛输入先进 store → tab 变脏 → 下面按 dirty 跳过,不被磁盘覆盖。
    // 别的 tab 被外部改动不打断正在输入的 tab(回写会整篇序列化)。还原时同样先回写:编辑器卸载回写
    // 发现 store 内容已不是它的基线 → 不再把被丢弃的输入写回。
    flushEditorWriteBacks([tabId]);
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, tabId);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      // dirty:保留用户改动,不覆盖(还原除外)
      if (cur.dirty && !discard) return s;
      const base = withRealPath(cur, realPath);
      // 内容没变(stat 触发但实际未改):无需重渲;仅链接目标变了时同步 realPath(chrome 不变)
      if (!cur.dirty && cur.originalContent === content && !cur.orphaned) {
        return base === cur ? s : replaceTabBumpingChrome(s, idx, base);
      }
      // 基线已不是自己写盘的内容 → 保存记录失效;读到了磁盘内容 → 文件存在,清除已删除标记
      const { savedGen: _staleSave, orphaned: _exists, ...rest } = base;
      const next: EditorTab = {
        ...rest,
        content,
        originalContent: content,
        dirty: false,
        // 外部内容已变 → 递增 epoch,让 Milkdown 视图按 key remount 拿新内容
        reloadEpoch: (cur.reloadEpoch ?? 0) + 1,
        milkdownUnsafe: computeMilkdownUnsafe(cur.filePath, content), // perf P4
      };
      // perf P14:外部 reload 改 content,chrome(id/filePath/dirty)不变,但 milkdownUnsafe 翻转会改 effectiveMode。
      return replaceTabBumpingChrome(s, idx, next);
    });
  },

  setOrphaned: (tabId, orphaned) =>
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, tabId);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      if (!!cur.orphaned === orphaned || (orphaned && !cur.dirty)) return s;
      const { orphaned: _prev, ...rest } = cur;
      return replaceTabBumpingChrome(s, idx, orphaned ? { ...rest, orphaned: true } : rest);
    }),

  switchTab: (id, opts) => {
    if (opts?.requestFocus !== false) beginUserActivation();
    set((s) => {
      const pulse = nextFocusPulse(s.editorFocusPulse, opts);
      if (!isMultiGroup(s)) return { activeTabId: id, editorFocusPulse: pulse };
      // 多组:在目标组(缺省活动组)激活;文档在别的组打开而不在本组 → 本组也打开它(VSCode 在活动组打开)
      if (findEditorTabIndexById(s.tabs, id) < 0) return { editorFocusPulse: pulse };
      const gid = targetGroupId(s, opts);
      const g = findGroup(s, gid)!;
      const nextG = activateInGroup(g, id, false);
      const activeGroupId = nextActiveGroupId(s, gid, opts);
      const groups = nextG === g ? s.groups : replaceGroup(s.groups, nextG);
      return {
        groups,
        activeGroupId,
        activeTabId: groups.find((x) => x.id === activeGroupId)!.activeTabId,
        editorFocusPulse: pulse,
        ...(nextG.tabIds !== g.tabIds ? { chromeVersion: s.chromeVersion + 1 } : null),
      };
    });
  },

  updateContent: (id, content) =>
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      if (cur.content === content) return s;
      const next = withDirtyGen(cur, {
        ...cur,
        content,
        dirty: content !== cur.originalContent,
        milkdownUnsafe: computeMilkdownUnsafe(cur.filePath, content), // perf P4
      });
      // perf P12/P14:持续在已脏 tab 输入(dirty 恒 true、unsafe 不变)不 bump → header selector O(1) 跳过。
      return replaceTabBumpingChrome(s, idx, next);
    }),

  markSaved: (id, savedContent, savedGen) =>
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      // 已写盘内容 = savedContent(省略则退化为当前内容)。dirty 反映"当前内容是否
      // 仍与磁盘一致":写盘 await 期间并发键入会让 cur.content 领先 savedContent,
      // 此时必须保留 dirty,否则那段增量既没落盘又不再触发 autosave → 静默丢失。
      const onDisk = savedContent ?? cur.content;
      const dirty = cur.content !== onDisk;
      if (
        cur.originalContent === onDisk &&
        cur.dirty === dirty &&
        cur.savedGen === savedGen &&
        !cur.orphaned
      ) {
        return s;
      }
      // 写盘成功 = 文件已(重新)存在 → 清除已删除标记
      const { savedGen: _prevSave, orphaned: _recreated, ...rest } = cur;
      const next = withDirtyGen(cur, {
        ...rest,
        originalContent: onDisk,
        dirty,
        ...(savedGen === undefined ? {} : { savedGen }),
      });
      // 保存期间继续输入 → 仍脏但换了新变脏代际,也须 bump —— 关窗脏确认的上报 effect 只订阅 chromeVersion,
      // 不 bump 则新代际不上报,main 仍按旧代际放行退出,丢失这段输入(终审 P1;dirtyGen 已在 tabChromeChanged)。
      return replaceTabBumpingChrome(s, idx, next);
    }),

  setMode: (mode) => {
    if (get().mode === mode) return;
    // 新模式视图按 store 内容挂载:先回写。mode 是全局的,所有已挂载编辑器都随之重挂载 → 全量。
    flushEditorWriteBacks();
    set({ mode });
  },

  acceptUnsafeEdit: (id) =>
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      if (cur.unsafeEditAccepted) return s;
      // effectiveMode 变 → bump 让 EditorHeader action 区更新(同 milkdownUnsafe 翻转)
      return replaceTabBumpingChrome(s, idx, { ...cur, unsafeEditAccepted: true });
    }),

  registerView: (tabId, view) =>
    set((s) => {
      if (s.viewRefs.get(tabId) === view) return s;
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

  waitForViewRef: (tabId, timeoutMs) => {
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

// tab 关闭 / 移除(close / 删除路径 / 切 root)后丢弃其编辑器视图状态。tab 增删改名必 bump chromeVersion,
// 只在它变化时比对(正文输入不触发)。BDD: src/__tests__/editor-view-state/
useEditorStore.subscribe((s, prev) => {
  if (s.chromeVersion === prev.chromeVersion) return;
  const open = new Set<string>();
  for (const t of s.tabs) open.add(t.id);
  retainEditorViewStates((id) => open.has(id));
});

// 性能 P4:milkdownUnsafe 派生值的单一计算口径。content / filePath 任一变更时调一次,
// 结果缓存进 tab.milkdownUnsafe。isMilkdownUnsafe 跑未锚定 wiki-link 正则(O(file)),
// 故只在 markdown 文件上算(非 markdown 短路为 false,不扫描)。
function computeMilkdownUnsafe(filePath: string, content: string): boolean {
  return isMarkdownPath(filePath) && isMilkdownUnsafe(content);
}

// 性能 P4/P5:tab 是否 milkdown-unsafe 的**单一读取口径**。优先读派生缓存,缺省
// (旧构造 / 未迁移路径)回退现场计算 —— 与历史逐字节等价。getEffectiveMode 与
// EditorPanel 都经此读,避免任一处直接对 content 重跑未锚定 wiki-link 正则。
export function isTabMilkdownUnsafe(tab: EditorTab | null): boolean {
  if (!tab) return false;
  return tab.milkdownUnsafe ?? computeMilkdownUnsafe(tab.filePath, tab.content);
}

// unsafe markdown 只挡**会写回**的 Milkdown Edit:Preview 只读、不产生 serializer
// 回写,照常放行;Edit 须用户对该 tab 确认过(acceptUnsafeEdit)才放行,否则落到 Source。
export function getEffectiveMode(tab: EditorTab | null): EditorMode {
  const requestedMode = useEditorStore.getState().mode;
  if (requestedMode !== 'edit' || !isTabMilkdownUnsafe(tab)) return requestedMode;
  return tab?.unsafeEditAccepted ? 'edit' : 'source';
}

/**
 * 该路径 / tab 当前用 Milkdown 引擎渲染(Markdown 且实际模式不是 source)。编辑面板、引擎预热与插件 SDK 跳行
 * 判定共用 —— 此前各写一份「isMarkdownPath && getEffectiveMode !== 'source'」并靠「同口径」注释维持一致。
 */
export function usesMilkdownEngine(filePath: string, tab: EditorTab | null): boolean {
  return isMarkdownPath(filePath) && getEffectiveMode(tab) !== 'source';
}
