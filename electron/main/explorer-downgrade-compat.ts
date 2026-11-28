// explorer.json 降级兼容:0.2.15 的 v3 schema 是 strict(不认识的字段 = 损坏 → 用默认值覆盖、原文只留在一次性的
// explorer.json.corrupt)。之后新增的字段(窗口几何、搜索输入、编辑器组 / 固定 tab / 视图状态 / 编码、按文件夹快照、
// openWindowSeqs …)一旦写进 explorer.json,回退到 0.2.15 整个会话就被清空,再升级也找不回。
//
// 做法(对齐 VSCode 的「旧版本读不懂的状态不进它要读的文件」:VSCode 各项状态是 state.vscdb 里的独立键,旧版本只读它认识的键):
// - explorer.json 只写 0.2.15 认识的字段(下方 LEGACY_* 白名单;守护测试拿 0.2.15 原 schema 快照校验写出的文件)。
// - 其余字段写旁挂文件 explorer-ext.json(按 windowSeq 对应窗口段),读时合并回去。旁挂文件缺失 / 损坏 → 只用 explorer.json(丢的只是新增字段)。
// - 多编辑器组的 layout(带 `editor:2` … 面板)写给 0.2.15 时去掉多出的编辑器组面板(它把它们当成内容一样的重复编辑器),
//   空出的尺寸并给主编辑器所在的一侧;完整 layout 进旁挂文件。
// - 旁挂文件按窗口记下写出时 explorer.json 里该窗口的 tab 列表(openFilePaths,含顺序)摘要与 layout 结构摘要
//   (只含面板 / 分组的树形,不含尺寸、标题、活动项 —— 0.2.15 什么都不动退出也会重写它们)。读时逐窗口比对:
//   - tab 列表对得上 → 该窗口的 tab 结构字段(编辑器组、MRU、预览 / 固定 tab)照常合并;layout 结构也对得上 → 还原完整 layout;
//     0.2.15 里只换了活动 tab(activePath 不同)→ 照常合并,旧版选中的文件设为它所在组的活动 tab(必要时设为活动组);
//     layout 结构对不上(旧版本里挪过面板)→ 用 explorer.json 的 layout,编辑器组随之不合并(组面板已不在 layout 里);
//   - tab 列表对不上(旧版本里改过 tab)→ 以 explorer.json 为准,该窗口只合并与 tab 列表无关的字段
//     (几何、搜索、视图状态、编码、Markdown 模式);只影响这一个窗口。
//   旁挂文件里没有逐窗口摘要的段(本分支更早写的)退回整份原文摘要比对。openWindowSeqs 只保留 explorer.json 里仍在的窗口。
// BDD: src/__tests__/explorer-downgrade-compat/
import crypto from 'node:crypto';
import path from 'node:path';
import type { ExplorerPayloadV3 } from '../shared/explorer-persistence-schema';

/** 0.2.15 explorer.json(v3)各层认识的字段。 */
const LEGACY_TOP_KEYS = new Set(['version', 'workspace', 'pinned', 'nextWindowSeq', 'restoreAllWindowsOnLaunch', 'windows']);
const LEGACY_WINDOW_KEYS = new Set(['windowSeq', 'workspace', 'explorer', 'layoutUi', 'editor', 'layout', 'lastClosedAt']);
const LEGACY_EDITOR_KEYS = new Set(['openFilePaths', 'activePath']);

/** 描述 tab 结构的字段:该窗口的 tab 列表被旧版本改过时不再对应,不合并。 */
const STRUCTURAL_EDITOR_KEYS = new Set(['mruPaths', 'previewPath', 'stickyPaths', 'groups', 'activeGroup', 'groupMru']);
/** 编辑器组字段:与 layout 里的组面板对应,layout 没能还原时不合并。 */
const GROUP_EDITOR_KEYS = new Set(['groups', 'activeGroup', 'groupMru']);
const NO_KEYS: ReadonlySet<string> = new Set();

const PRIMARY_EDITOR_PANEL = 'editor';
const EDITOR_GROUP_PANEL_RE = /^editor:\d+$/;

const EXT_VERSION = 1 as const;

type Obj = Record<string, unknown>;

interface ExtWindow {
  windowSeq: number;
  fields: Obj;
  editor?: Obj;
  /** 同次写进 explorer.json 的该窗口 tab 列表摘要(见 tabsDigest)。 */
  tabs?: string;
  /** explorer.json 里的 layout 去掉了编辑器组面板:完整 layout 与写出的 layout 的结构摘要(见 layoutShapeDigest)。 */
  layout?: { full: Obj; shape: string };
}

/** 旁挂文件内容。 */
export interface ExplorerExtFile {
  version: typeof EXT_VERSION;
  /** 同次写出的 explorer.json 原文的 sha256。 */
  legacyHash: string;
  top: Obj;
  windows: ExtWindow[];
}

export function explorerExtFilePath(explorerFile: string): string {
  const dir = path.dirname(explorerFile);
  const base = path.basename(explorerFile).replace(/\.json$/, '');
  return path.join(dir, `${base}-ext.json`);
}

export function hashExplorerText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function partition(src: Obj, legacyKeys: ReadonlySet<string>): { legacy: Obj; extra: Obj | null } {
  const legacy: Obj = {};
  let extra: Obj | null = null;
  for (const k of Object.keys(src)) {
    if (legacyKeys.has(k)) legacy[k] = src[k];
    else (extra ??= {})[k] = src[k];
  }
  return { legacy, extra };
}

/**
 * 窗口 tab 列表摘要:explorer.json 里该窗口的 openFilePaths(含顺序:0.2.15 只在用户拖动 tab 时重排)。
 * 不含 activePath —— 0.2.15 里只切换活动 tab 不算改了 tab 列表(见 applyLegacyActivePath)。
 */
function tabsDigest(editor: unknown): string {
  const e = isObj(editor) ? editor : {};
  return hashExplorerText(JSON.stringify([e['openFilePaths'] ?? null]));
}

/** 本分支更早写的摘要(含 activePath):对得上 = tab 列表与活动 tab 都没动。 */
function tabsDigestWithActive(editor: unknown): string {
  const e = isObj(editor) ? editor : {};
  return hashExplorerText(JSON.stringify([e['openFilePaths'] ?? null, e['activePath'] ?? null]));
}

const moveToFront = (list: unknown, item: string): unknown =>
  Array.isArray(list) && list.includes(item) ? [item, ...list.filter((x) => x !== item)] : list;

/**
 * 以 explorer.json 的 activePath(0.2.15 里最后选中的文件)为准:设为它所在组的活动 tab 并移到组内 MRU 首位;
 * 不在当前活动组里 → 该组设为活动组(并移到组 MRU 首位)。已一致(0.2.15 没换活动 tab)→ 原对象返回。
 */
function applyLegacyActivePath(editor: Obj): Obj {
  const active = editor['activePath'];
  if (typeof active !== 'string') return editor;
  const groups = editor['groups'];
  if (!Array.isArray(groups) || groups.length === 0) {
    const mru = moveToFront(editor['mruPaths'], active);
    return mru === editor['mruPaths'] ? editor : { ...editor, mruPaths: mru };
  }
  const has = (g: unknown): g is Obj => isObj(g) && Array.isArray(g['openFilePaths']) && g['openFilePaths'].includes(active);
  const current = groups.find((g) => isObj(g) && g['id'] === editor['activeGroup']);
  const target = has(current) ? current : groups.find(has);
  if (target === undefined) return editor;
  if (target === current && target['activePath'] === active) return editor;
  const nextGroups = groups.map((g) =>
    g === target ? { ...g, activePath: active, ...(g['mruPaths'] === undefined ? null : { mruPaths: moveToFront(g['mruPaths'], active) }) } : g,
  );
  const id = target['id'] as string;
  return {
    ...editor,
    groups: nextGroups,
    activeGroup: id,
    ...(editor['groupMru'] === undefined ? null : { groupMru: moveToFront(editor['groupMru'], id) }),
  };
}

/** dockview 序列化 grid 节点里各 leaf 的面板 id。 */
function leafViews(node: unknown): string[] {
  if (!isObj(node)) return [];
  if (node['type'] === 'leaf') {
    const data = node['data'];
    return isObj(data) && Array.isArray(data['views']) ? data['views'].filter((v): v is string => typeof v === 'string') : [];
  }
  return Array.isArray(node['data']) ? node['data'].flatMap(leafViews) : [];
}

function shapeOfNode(node: unknown): unknown {
  if (!isObj(node)) return null;
  if (node['type'] === 'leaf') return leafViews(node);
  return Array.isArray(node['data']) ? node['data'].map(shapeOfNode) : null;
}

const groupViews = (list: unknown): unknown =>
  Array.isArray(list) ? list.map((g) => (isObj(g) ? leafViews({ type: 'leaf', data: g['data'] }) : null)) : null;

/**
 * layout 结构摘要:分组树形(方向 + 各组面板 id 顺序)、浮动 / popout 组的面板、面板 id 与类型。
 * 不含尺寸、标题、参数、活动面板 / 活动组、组 id —— 0.2.15 什么都不动退出也会按自己的方式重写它们(如编辑器标题)。
 */
export function layoutShapeDigest(layout: unknown): string {
  const l = isObj(layout) ? layout : {};
  const grid = isObj(l['grid']) ? l['grid'] : {};
  const panels = isObj(l['panels']) ? l['panels'] : {};
  const shape = {
    o: grid['orientation'] ?? null,
    root: shapeOfNode(grid['root']),
    floating: groupViews(l['floatingGroups']),
    popout: groupViews(l['popoutGroups']),
    panels: Object.keys(panels)
      .sort()
      .map((id) => [id, isObj(panels[id]) ? (panels[id]['contentComponent'] ?? null) : null]),
  };
  return hashExplorerText(JSON.stringify(shape));
}

/** 从 grid 子树去掉 drop 里的面板;整棵子树空了 → null。空出的尺寸并给含 keep 面板的兄弟(没有就给相邻的)。 */
function pruneGridNode(node: unknown, drop: ReadonlySet<string>, keep: string): Obj | null {
  if (!isObj(node)) return null;
  if (node['type'] === 'leaf') {
    const data = isObj(node['data']) ? node['data'] : {};
    const views = leafViews(node);
    const kept = views.filter((v) => !drop.has(v));
    if (kept.length === 0) return null;
    if (kept.length === views.length) return node;
    const activeView = kept.includes(data['activeView'] as string) ? data['activeView'] : kept[0];
    return { ...node, data: { ...data, views: kept, activeView } };
  }
  if (!Array.isArray(node['data'])) return node;
  const children = node['data'] as unknown[];
  const out: Obj[] = [];
  let freed = 0;
  let changed = false;
  for (const child of children) {
    const pruned = pruneGridNode(child, drop, keep);
    if (pruned !== child) changed = true;
    if (pruned === null) {
      const size = isObj(child) ? child['size'] : undefined;
      if (typeof size === 'number' && Number.isFinite(size)) freed += size;
      continue;
    }
    out.push(pruned);
  }
  if (out.length === 0) return null;
  if (!changed) return node;
  if (freed > 0) {
    let i = out.findIndex((c) => leafViews(c).includes(keep));
    if (i < 0) i = 0;
    const target = out[i]!;
    if (typeof target['size'] === 'number') out[i] = { ...target, size: target['size'] + freed };
  }
  return { ...node, data: out };
}

/** layout 里的各组(grid leaf + 浮动 / popout 组):组 id 与面板 id。 */
function layoutGroups(layout: Obj): { id: unknown; views: string[] }[] {
  const out: { id: unknown; views: string[] }[] = [];
  const walk = (node: unknown): void => {
    if (!isObj(node)) return;
    if (node['type'] === 'leaf') out.push({ id: isObj(node['data']) ? node['data']['id'] : undefined, views: leafViews(node) });
    else if (Array.isArray(node['data'])) node['data'].forEach(walk);
  };
  walk(isObj(layout['grid']) ? layout['grid']['root'] : undefined);
  for (const key of ['floatingGroups', 'popoutGroups']) {
    const list = layout[key];
    if (Array.isArray(list)) for (const g of list) if (isObj(g)) walk({ type: 'leaf', data: g['data'] });
  }
  return out;
}

/**
 * 写给 0.2.15 的 layout:只留一个编辑器面板(`editor`;没有它时把第一个组面板改名成 `editor`),去掉其余 `editor:N`。
 * 0.2.15 不认识编辑器组,会把这些面板当成内容一样的重复编辑器显示。没有组面板 → 原对象返回。
 */
export function stripEditorGroupPanels(layout: Obj): Obj {
  const panels = isObj(layout['panels']) ? layout['panels'] : null;
  if (panels === null) return layout;
  const groupIds = Object.keys(panels).filter((id) => EDITOR_GROUP_PANEL_RE.test(id));
  if (groupIds.length === 0) return layout;
  const grid = isObj(layout['grid']) ? layout['grid'] : null;
  const order = layoutGroups(layout).flatMap((g) => g.views);
  // 主编辑器面板不在(用户关掉了第一个组):第一个组面板顶替它的 id。
  const rename = Object.hasOwn(panels, PRIMARY_EDITOR_PANEL)
    ? null
    : (order.find((v) => groupIds.includes(v)) ?? groupIds[0]!);
  const drop = new Set(groupIds.filter((id) => id !== rename));
  const renameView = (v: unknown): unknown => (v === rename ? PRIMARY_EDITOR_PANEL : v);
  const renameNode = (node: unknown): unknown => {
    if (rename === null || !isObj(node)) return node;
    if (node['type'] === 'leaf') {
      const data = isObj(node['data']) ? node['data'] : {};
      return { ...node, data: { ...data, views: leafViews(node).map(renameView), activeView: renameView(data['activeView']) } };
    }
    return Array.isArray(node['data']) ? { ...node, data: node['data'].map(renameNode) } : node;
  };

  const out: Obj = { ...layout };
  const nextPanels: Obj = {};
  for (const [id, panel] of Object.entries(panels)) {
    if (drop.has(id)) continue;
    if (id === rename) nextPanels[PRIMARY_EDITOR_PANEL] = isObj(panel) ? { ...panel, id: PRIMARY_EDITOR_PANEL } : panel;
    else nextPanels[id] = panel;
  }
  out['panels'] = nextPanels;
  if (grid !== null) {
    // 主编辑器只在浮动 / popout 组里、grid 里全是组面板 → grid 留空分支。
    const root = pruneGridNode(grid['root'], drop, rename ?? PRIMARY_EDITOR_PANEL);
    out['grid'] = { ...grid, root: renameNode(root ?? { ...(isObj(grid['root']) ? grid['root'] : {}), data: [] }) };
  }
  for (const key of ['floatingGroups', 'popoutGroups'] as const) {
    const list = layout[key];
    if (!Array.isArray(list)) continue;
    out[key] = list.flatMap((g) => {
      if (!isObj(g) || !isObj(g['data'])) return [g];
      const pruned = pruneGridNode({ type: 'leaf', data: g['data'] }, drop, PRIMARY_EDITOR_PANEL);
      if (pruned === null) return [];
      return [{ ...g, data: (renameNode(pruned) as Obj)['data'] }];
    });
  }
  // 活动组被去掉了 → 改指主编辑器所在的组。
  const groups = layoutGroups(out);
  if (layout['activeGroup'] !== undefined && !groups.some((g) => g.id === layout['activeGroup'])) {
    const primary = groups.find((g) => g.views.includes(PRIMARY_EDITOR_PANEL));
    if (primary?.id !== undefined) out['activeGroup'] = primary.id;
    else delete out['activeGroup'];
  }
  return out;
}

/**
 * layout 的活动 dock 组改为含编辑器组面板 panelId 的组(该组活动面板也设为它)。原活动组不是编辑器组面板所在的组
 *(用户焦点在终端等别的面板)→ 不动;找不到该面板 → 不动。
 */
function activateEditorGroupPanel(layout: Obj, panelId: string): Obj {
  const groups = layoutGroups(layout);
  const current = groups.find((g) => g.id === layout['activeGroup']);
  if (current !== undefined && !current.views.some((v) => v === PRIMARY_EDITOR_PANEL || EDITOR_GROUP_PANEL_RE.test(v))) return layout;
  const target = groups.find((g) => g.views.includes(panelId));
  if (target === undefined || target.id === undefined) return layout;
  const setActive = (node: unknown): unknown => {
    if (!isObj(node)) return node;
    if (node['type'] === 'leaf') {
      const data = isObj(node['data']) ? node['data'] : {};
      return data['id'] === target.id ? { ...node, data: { ...data, activeView: panelId } } : node;
    }
    return Array.isArray(node['data']) ? { ...node, data: node['data'].map(setActive) } : node;
  };
  const out: Obj = { ...layout, activeGroup: target.id };
  if (isObj(layout['grid'])) out['grid'] = { ...layout['grid'], root: setActive(layout['grid']['root']) };
  for (const key of ['floatingGroups', 'popoutGroups'] as const) {
    const list = layout[key];
    if (Array.isArray(list)) {
      out[key] = list.map((g) => (isObj(g) && isObj(g['data']) ? { ...g, data: (setActive({ type: 'leaf', data: g['data'] }) as Obj)['data'] } : g));
    }
  }
  return out;
}

/** 拆成 0.2.15 能读的 explorer.json 内容与新增字段(无新增字段时 ext 为 null)。 */
export function splitExplorerPayload(payload: ExplorerPayloadV3): {
  legacy: ExplorerPayloadV3;
  ext: Omit<ExplorerExtFile, 'legacyHash'> | null;
} {
  const { legacy, extra: topExtra } = partition(payload as unknown as Obj, LEGACY_TOP_KEYS);
  const extWindows: ExtWindow[] = [];
  legacy['windows'] = payload.windows.map((w) => {
    const { legacy: lw, extra } = partition(w as unknown as Obj, LEGACY_WINDOW_KEYS);
    let editorExtra: Obj | null = null;
    if (isObj(lw['editor'])) {
      const e = partition(lw['editor'], LEGACY_EDITOR_KEYS);
      lw['editor'] = e.legacy;
      editorExtra = e.extra;
    }
    let layout: ExtWindow['layout'];
    if (isObj(lw['layout'])) {
      const stripped = stripEditorGroupPanels(lw['layout']);
      if (stripped !== lw['layout']) {
        layout = { full: lw['layout'], shape: layoutShapeDigest(stripped) };
        lw['layout'] = stripped;
      }
    }
    if (extra || editorExtra || layout) {
      extWindows.push({
        windowSeq: w.windowSeq,
        fields: extra ?? {},
        ...(editorExtra ? { editor: editorExtra } : {}),
        tabs: tabsDigest(lw['editor']),
        ...(layout ? { layout } : {}),
      });
    }
    return lw;
  });
  const ext = topExtra || extWindows.length > 0 ? { version: EXT_VERSION, top: topExtra ?? {}, windows: extWindows } : null;
  return { legacy: legacy as unknown as ExplorerPayloadV3, ext };
}

/** payload 是否含 0.2.15 不认识的字段(需要拆分后重写)。 */
export function hasExtFields(payload: ExplorerPayloadV3): boolean {
  return splitExplorerPayload(payload).ext !== null;
}

/** 解析旁挂文件外壳(字段内容由合并后的整体 schema 校验);不合法 → null。 */
export function parseExplorerExt(text: string): ExplorerExtFile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(json) || json['version'] !== EXT_VERSION || typeof json['legacyHash'] !== 'string') return null;
  if (!isObj(json['top']) || !Array.isArray(json['windows'])) return null;
  const windows: ExtWindow[] = [];
  for (const w of json['windows']) {
    if (!isObj(w) || !Number.isSafeInteger(w['windowSeq']) || !isObj(w['fields'])) return null;
    if (w['editor'] !== undefined && !isObj(w['editor'])) return null;
    if (w['tabs'] !== undefined && typeof w['tabs'] !== 'string') return null;
    const layout = w['layout'];
    if (layout !== undefined && !(isObj(layout) && isObj(layout['full']) && typeof layout['shape'] === 'string')) return null;
    windows.push({
      windowSeq: w['windowSeq'] as number,
      fields: w['fields'],
      ...(w['editor'] ? { editor: w['editor'] } : {}),
      ...(typeof w['tabs'] === 'string' ? { tabs: w['tabs'] } : {}),
      ...(isObj(layout) ? { layout: { full: layout['full'] as Obj, shape: layout['shape'] as string } } : {}),
    });
  }
  return { version: EXT_VERSION, legacyHash: json['legacyHash'], top: json['top'], windows };
}

function assignNew(target: Obj, src: Obj, legacyKeys: ReadonlySet<string>, skip: ReadonlySet<string>): void {
  for (const k of Object.keys(src)) {
    // 旁挂文件只补新增字段:0.2.15 认识的字段以 explorer.json 为准;explorer.json 自己已带的(旧的未拆分文件)也以它为准。
    if (legacyKeys.has(k) || skip.has(k) || Object.hasOwn(target, k)) continue;
    target[k] = src[k];
  }
}

/**
 * 把旁挂文件的新增字段合并进 explorer.json 解析出的 JSON(尚未过 schema:调用方对合并结果做一次整体校验,不合法再单独校验
 * explorer.json —— 常见路径只校验一次)。逐窗口比对 tab 列表 / layout 结构摘要决定合并哪些 tab 结构字段(见文件头);
 * `exact` = 旁挂文件记录的整份原文摘要与 explorer.json 一致,只给没有逐窗口摘要的段用。
 * 外形不对(非 v3 对象)→ 原样返回。
 */
export function mergeExplorerExt(base: unknown, ext: ExplorerExtFile, exact: boolean): unknown {
  if (!isObj(base) || base['version'] !== 3 || !Array.isArray(base['windows'])) return base;
  const merged = { ...base };
  assignNew(merged, ext.top, LEGACY_TOP_KEYS, NO_KEYS);
  // 上次退出时开着的窗口:只留 explorer.json 里仍在的(旧版本可能裁掉了窗口段)。
  if (!exact && Array.isArray(merged['openWindowSeqs'])) {
    const seqs = new Set((base['windows'] as unknown[]).map((w) => (isObj(w) ? w['windowSeq'] : undefined)));
    const kept = (merged['openWindowSeqs'] as unknown[]).filter((seq) => seqs.has(seq));
    if (kept.length > 0) merged['openWindowSeqs'] = kept;
    else delete merged['openWindowSeqs'];
  }
  const extBySeq = new Map<number, ExtWindow>();
  for (const w of ext.windows) if (!extBySeq.has(w.windowSeq)) extBySeq.set(w.windowSeq, w);
  merged['windows'] = (base['windows'] as unknown[]).map((w) => {
    if (!isObj(w)) return w;
    const e = extBySeq.get(w['windowSeq'] as number);
    if (!e) return w;
    extBySeq.delete(e.windowSeq); // 同一 windowSeq 的重复段只补首个(与 findWindowEntryBySeq 命中首个一致)
    const out = { ...w };
    assignNew(out, e.fields, LEGACY_WINDOW_KEYS, NO_KEYS);
    const tabsMatch =
      e.tabs !== undefined ? e.tabs === tabsDigest(w['editor']) || e.tabs === tabsDigestWithActive(w['editor']) : exact;
    let layoutRestored = true;
    if (e.layout) {
      layoutRestored = tabsMatch && e.layout.shape === layoutShapeDigest(w['layout']);
      if (layoutRestored) out['layout'] = e.layout.full;
    }
    if (e.editor && isObj(out['editor'])) {
      const editor = { ...out['editor'] };
      assignNew(editor, e.editor, LEGACY_EDITOR_KEYS, !tabsMatch ? STRUCTURAL_EDITOR_KEYS : layoutRestored ? NO_KEYS : GROUP_EDITOR_KEYS);
      out['editor'] = tabsMatch ? applyLegacyActivePath(editor) : editor;
      // 活动组随之换了 → 还原的完整 layout 的活动 dock 组也指过去(否则启动时 dock 激活旧活动组的面板,又把活动组抢回去)
      const activeGroup = (out['editor'] as Obj)['activeGroup'];
      if (e.layout && layoutRestored && typeof activeGroup === 'string' && activeGroup !== editor['activeGroup']) {
        out['layout'] = activateEditorGroupPanel(e.layout.full, activeGroup);
      }
    }
    return out;
  });
  return merged;
}

/**
 * 会话里没有任何用户数据(0.2.15 把新版文件当损坏、用默认值重建后的样子):无最近目录 / 固定项,各窗口都没打开文件夹与文件。
 * 此时从 explorer.json.corrupt 恢复不会丢任何东西。
 */
export function isEmptyExplorerSession(payload: ExplorerPayloadV3): boolean {
  if (payload.workspace.recentRoots.length > 0 || payload.pinned.paths.length > 0) return false;
  if ((payload.workspaceSnapshots?.length ?? 0) > 0) return false;
  return payload.windows.every(
    (w) => w.workspace.root === null && (w.editor?.openFilePaths.length ?? 0) === 0,
  );
}
