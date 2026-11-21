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
  filePath: string | null,
  content: string,
  realPath?: string,
): EditorTab {
  const tab: EditorTab = {
    id: filePath ?? `untitled-${crypto.randomUUID()}`,
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
    if (t.filePath === null) {
      if (newTabs !== null) newTabs[i] = t;
      continue;
    }
    const np = rewrite(t.filePath);
    let nextTab = t;

    if (np !== null) {
      if (newTabs === null) {
        newTabs = new Array<EditorTab>(tabs.length);
        for (let j = 0; j < i; j++) newTabs[j] = tabs[j]!;
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

  const r = filterTabsTrackingActive(tabs, activeTabId, keep);
  if (!r.changed) return { tabs, activeTabId };
  if (r.remaining.length === 0) {
    return { tabs: EMPTY_EDITOR_TABS, activeTabId: null };
  }
  if (activeTabId !== null && r.activeKept) {
    return { tabs: r.remaining, activeTabId };
  }
  // active 被关:取原序后向第一个 remaining,否则前向,否则首个
  if (activeTabId !== null && r.activeFound) {
    return { tabs: r.remaining, activeTabId: r.neighbor?.id ?? null };
  }
  return { tabs: r.remaining, activeTabId: r.remaining[0]!.id };
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
  // 跨平台(复查 P2):删除匹配走 isSameOrInsidePath —— Windows case-fold(`C:\Repo\dir`
  // 匹配 `c:\repo\dir\a.md`),否则 clean tab 不随删除/trash 关闭 → 用户基于已删旧路径保存
  // 复活文件;POSIX 保持大小写敏感。同前缀但非子(`/x/foo` 删 vs `/x/foobar.md`)仍不误匹配。
  return removeMatchingCleanTabs(tabs, activeTabId, (filePath) =>
    isSameOrInsidePath(removedPath, filePath),
  );
}

/**
 * 批量版 getStateAfterRemovingPath(perf:批量删除后逐条 removePath 是 O(R·T) 比较 + R 次 set)。
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

function removeMatchingCleanTabs(
  tabs: EditorTab[],
  activeTabId: string | null,
  isRemoved: (filePath: string) => boolean,
): CloseTabResult {
  // 数据安全:dirty(未保存编辑)tab 不随文件删除/trash 自动关闭 —— 否则会绕过
  // EditorPanel 的 dirty 关闭确认,静默丢失内存里的未保存增量(磁盘旧版本进废纸篓
  // 可恢复,但内存增量无处可寻)。参考 VSCode:删除有未保存改动的文件保留 dirty
  // 编辑器。仅 clean tab 自动关闭;dirty tab 留给用户显式保存或经确认丢弃。
  const r = filterTabsTrackingActive(
    tabs,
    activeTabId,
    (tab) => tab.filePath === null || tab.dirty || !isRemoved(tab.filePath),
  );
  if (!r.changed) return { tabs, activeTabId };
  if (r.remaining.length === 0) {
    return { tabs: EMPTY_EDITOR_TABS, activeTabId: null };
  }
  // active 仍在(或本就不在 tabs 里)→ 不动 activeTabId。
  if (activeTabId === null || r.activeKept || !r.activeFound) {
    return { tabs: r.remaining, activeTabId };
  }
  return { tabs: r.remaining, activeTabId: r.neighbor?.id ?? null };
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

  /** 已存在则切换 active,新加则推入. `requestFocus: false`(持久化会话恢复)不递增 editorFocusPulse. */
  openTab: (tab: EditorTab, opts?: EditorFocusOpts) => void;
  closeTab: (id: string) => void;
  /** 文件/目录被删除时调用:精确匹配或前缀匹配的 tab 统一关闭. */
  removePath: (path: string) => void;
  /** 批量删除后调用:结果与逐条 removePath 一致,但只 set 一次(chromeVersion 至多 bump 一次). */
  removePaths: (paths: readonly string[]) => void;
  /** 文件/目录被重命名 / 移动时调用:精确或前缀匹配的 tab 同步路径. */
  renamePath: (oldPath: string, newPath: string) => void;
  /**
   * 外部修改时调用:非 dirty tab 同步 content+originalContent;dirty 跳过。realPath = 本次读盘
   * 结果的符号链接真实目标(缺省 = 非链接,移除旧值)。
   */
  reloadFromDisk: (tabId: string, content: string, realPath?: string) => void;
  /** 工作区切换时调用:关闭 root 外的 file tabs;untitled 始终保留. */
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
  /** 另存为后:把 tab 的 filePath 与 id 同步改为 newPath. */
  setFilePath: (id: string, newPath: string) => void;
  setMode: (mode: EditorMode) => void;
  /** unsafe markdown 的「仍然切换」确认:允许该 tab 在 Edit 模式下用 Milkdown. */
  acceptUnsafeEdit: (id: string) => void;
  registerView: (tabId: string, view: EditorView) => void;
  unregisterView: (tabId: string, expectedView: EditorView) => void;
  waitForViewRef: (
    tabId: string,
    timeoutMs?: number,
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

export const useEditorStore = create<EditorState>((set, get, api) => ({
  tabs: [],
  activeTabId: null,
  mode: 'source',
  editorFocusPulse: 0,
  chromeVersion: 0,
  viewRefs: new Map(),

  openTab: (tab, opts) =>
    set((s) => {
      const pulse = nextFocusPulse(s.editorFocusPulse, opts);
      const keepActive = opts?.activate === false && s.activeTabId !== null;
      const existingIndex = findEditorTabIndexById(s.tabs, tab.id);
      if (existingIndex >= 0) {
        return keepActive ? s : { activeTabId: tab.id, editorFocusPulse: pulse };
      }
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
        tabs: appendEditorTab(s.tabs, tab),
        activeTabId: keepActive ? s.activeTabId : tab.id,
        editorFocusPulse: pulse,
        chromeVersion: s.chromeVersion + 1, // perf P12:新增 tab → chrome 变
      };
    }),

  // perf P12:getStateAfter* 在无变化时返回原 tabs 引用,变化时返回新数组;据此
  // 决定是否 bump chromeVersion(增删/改名都改 chrome)。
  closeTab: (id) =>
    set((s) =>
      applyTabStateChange(s, getStateAfterClosingTab(s.tabs, s.activeTabId, id)),
    ),

  // 先按 pre-flush 状态算出受影响(将被关闭 / 换 id)的 tab,只回写它们 —— 回写会把正在编辑的大文档
  // 整篇序列化并提前上抛,不相关的删除 / 改名 / 切 root 不应打断输入。回写只改 content / dirty,
  // 不改 id 与路径匹配;回写后变脏的 tab 按既有规则保留。
  removePath: (path)=> {
    flushWriteBacksForAffectedTabs(get().tabs, (tabs, active) =>
      getStateAfterRemovingPath(tabs, active, path),
    );
    set((s) =>
      applyTabStateChange(
        s,
        getStateAfterRemovingPath(s.tabs, s.activeTabId, path),
      ),
    );
  },

  removePaths: (paths)=> {
    flushWriteBacksForAffectedTabs(get().tabs, (tabs, active) =>
      getStateAfterRemovingPaths(tabs, active, paths),
    );
    set((s) =>
      applyTabStateChange(
        s,
        getStateAfterRemovingPaths(s.tabs, s.activeTabId, paths),
      ),
    );
  },

  renamePath: (oldPath, newPath)=> {
    // 换 tab id 前按旧 id 回写:卸载回写的闭包仍持旧 id,换完就找不到 tab 而丢弃
    flushWriteBacksForAffectedTabs(get().tabs, (tabs, active) =>
      getStateAfterRenamingPath(tabs, active, oldPath, newPath),
    );
    set((s) =>
      applyTabStateChange(
        s,
        getStateAfterRenamingPath(s.tabs, s.activeTabId, oldPath, newPath),
      ),
    );
  },

  closeTabsOutsideRoot: (root)=> {
    flushWriteBacksForAffectedTabs(get().tabs, (tabs, active) =>
      getStateAfterClosingTabsOutsideRoot(tabs, active, root),
    );
    set((s) =>
      applyTabStateChange(
        s,
        getStateAfterClosingTabsOutsideRoot(s.tabs, s.activeTabId, root),
      ),
    );
  },

  reloadFromDisk: (tabId, content, realPath) => {
    // 只回写被重载的 tab:未上抛输入先进 store → tab 变脏 → 下面按 dirty 跳过,不被磁盘覆盖。
    // 别的 tab 被外部改动不打断正在输入的 tab(回写会整篇序列化)。
    flushEditorWriteBacks([tabId]);
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, tabId);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      // dirty:保留用户改动,不覆盖
      if (cur.dirty) return s;
      const base = withRealPath(cur, realPath);
      // 内容没变(stat 触发但实际未改):无需重渲;仅链接目标变了时同步 realPath(chrome 不变)
      if (cur.originalContent === content) {
        return base === cur ? s : { tabs: replaceTabAt(s.tabs, idx, base) };
      }
      const { savedGen: _staleSave, ...rest } = base; // 基线已不是自己写盘的内容 → 保存记录失效
      const next: EditorTab = {
        ...rest,
        content,
        originalContent: content,
        dirty: false,
        // 外部内容已变 → 递增 epoch,让 Milkdown 视图按 key remount 拿新内容
        reloadEpoch: (cur.reloadEpoch ?? 0) + 1,
        milkdownUnsafe: computeMilkdownUnsafe(cur.filePath, content), // perf P4
      };
      const tabs = replaceTabAt(s.tabs, idx, next);
      // perf P14:外部 reload 改 content,chrome(id/filePath/dirty)不变,但若 milkdownUnsafe
      // 翻转则 effectiveMode 变 → bump 让 EditorHeader action 区更新;否则不 bump。
      return !!next.milkdownUnsafe !== !!cur.milkdownUnsafe
        ? { tabs, chromeVersion: s.chromeVersion + 1 }
        : { tabs };
    });
  },

  switchTab: (id, opts) => {
    if (opts?.requestFocus !== false) beginUserActivation();
    set((s) => ({
      activeTabId: id,
      editorFocusPulse: nextFocusPulse(s.editorFocusPulse, opts),
    }));
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
      const tabs = replaceTabAt(s.tabs, idx, next);
      // perf P12/P14:dirty 翻转 或 milkdownUnsafe 翻转(影响 EditorHeader action 区的
      // effectiveMode)才 bump;持续在已脏 tab 输入(dirty 恒 true、unsafe 不变)不 bump
      // → header chrome + action selector 均 O(1) 跳过。`!!` 归一化避免 undefined→false 误判。
      return next.dirty !== cur.dirty ||
        !!next.milkdownUnsafe !== !!cur.milkdownUnsafe
        ? { tabs, chromeVersion: s.chromeVersion + 1 }
        : { tabs };
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
      if (cur.originalContent === onDisk && cur.dirty === dirty && cur.savedGen === savedGen) {
        return s;
      }
      const { savedGen: _prevSave, ...rest } = cur;
      const next = withDirtyGen(cur, {
        ...rest,
        originalContent: onDisk,
        dirty,
        ...(savedGen === undefined ? {} : { savedGen }),
      });
      const tabs = replaceTabAt(s.tabs, idx, next);
      // perf P12:markSaved 改 dirty(脏标→已存)即 chrome 变;dirty 未变则不 bump。
      // 例外:保存期间继续输入 → 仍脏但换了新变脏代际,也要 bump —— 关窗脏确认的上报 effect 只订阅
      // chromeVersion,不 bump 则新代际不上报,main 仍按旧代际放行退出,丢失这段输入(终审 P1)。
      return next.dirty !== cur.dirty || next.dirtyGen !== cur.dirtyGen
        ? { tabs, chromeVersion: s.chromeVersion + 1 }
        : { tabs };
    }),

  setFilePath: (id, newPath) => {
    flushEditorWriteBacks([id]); // 换 tab id 前按旧 id 回写(见 renamePath 处说明)
    set((s) => {
      const idx = findEditorTabIndexById(s.tabs, id);
      if (idx < 0) return s;
      const cur = s.tabs[idx]!;
      if (cur.id === newPath && cur.filePath === newPath) return s;
      // perf P4:filePath 变(可能 .md↔.txt 改变 markdown 判定)→ 重算派生缓存。
      const next: EditorTab = {
        ...cur,
        id: newPath,
        filePath: newPath,
        milkdownUnsafe: computeMilkdownUnsafe(newPath, cur.content),
      };
      const tabs = replaceTabAt(s.tabs, idx, next);
      return {
        tabs,
        activeTabId: s.activeTabId === id ? newPath : s.activeTabId,
        chromeVersion: s.chromeVersion + 1, // perf P12:filePath 变 → chrome 变
      };
    });
  },

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
      const tabs = replaceTabAt(s.tabs, idx, { ...cur, unsafeEditAccepted: true });
      // effectiveMode 变 → bump 让 EditorHeader action 区更新(同 milkdownUnsafe 翻转)
      return { tabs, chromeVersion: s.chromeVersion + 1 };
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
function computeMilkdownUnsafe(
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

// unsafe markdown 只挡**会写回**的 Milkdown Edit:Preview 只读、不产生 serializer
// 回写,照常放行;Edit 须用户对该 tab 确认过(acceptUnsafeEdit)才放行,否则落到 Source。
export function getEffectiveMode(tab: EditorTab | null): EditorMode {
  const requestedMode = useEditorStore.getState().mode;
  if (requestedMode !== 'edit' || !isTabMilkdownUnsafe(tab)) return requestedMode;
  return tab?.unsafeEditAccepted ? 'edit' : 'source';
}
