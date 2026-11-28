// 可维护性 M15:Explorer 持久化(explorer.json)的 zod schema 单一来源。
//
// 此前这些 schema 写在 electron/main/persistence.ts(含 node:fs 依赖,renderer 无法
// import),renderer 端只好在 explorer-persist.ts 另手写一套 `isExplorerSnapshot` 谓词,
// 且已漂移变松(只校验数组外壳,不校验元素类型 / int / strict)。把纯 zod schema 抽到本
// shared 模块(无 node 依赖):main 的 persistence.ts re-export 并继续使用;renderer 用
// safeParse 复用,磁盘契约变成单一来源。
//
// 详见 doc/08 § Zustand store 设计 + ADR-012 持久化范围。explorer 状态形态完全可控,故
// strict() 拒未知字段。多窗口 Phase 2(issue #23)升级到 v2/v3:workspace.root / explorer /
// layoutUi / editor 移到 windows[] 按 windowSeq 拆段;v1 自动迁移。

import { z } from 'zod';
import { IMAGE_MAX_SCALE, IMAGE_MIN_SCALE } from './image-preview';
import { EDITOR_GROUP_ID_RE, EDITOR_GROUPS_MAX } from './editor-group-id';
import { SEARCH_GLOB_MAX, SEARCH_PATTERN_MAX } from './workspace-search';
import { TEXT_ENCODING_IDS, type TextEncodingId } from './text-encoding';

// 边界(E14):explorer.json 的路径数组/字符串此前无上限。损坏/畸形快照只要 shape 对就通过,
// loadExplorer/hydrate 会接受超大数组,随后批量恢复 tab、展开树、写回快照 → 启动卡顿、IPC/JSON
// 写入膨胀、内存峰值。下列 cap 远超任何现实工作区(深树展开/多 tab/多最近目录),只挡损坏/滥用;
// 超限 → safeParse 失败 → loadExplorer 视作损坏快照降级默认(原文件存 .corrupt,不丢已存数据)。
// 边界(E276):运行时状态须守这里的上限,否则 snapshotFromStores 写出后被 ExplorerWritableSnapshotSchema
// 拒整份 → explorer 持久化全失败。
export const PATH_STR_MAX = 8192; // 单条路径字符串(远超真实路径)
export const PATH_ARRAY_MAX = 100_000; // expandedPaths / openFilePaths(大树/多 tab)(E277 运行时同守)
const RECENT_ROOTS_MAX = 1000; // recentRoots(schema 宽容上限;运行时 LRU 只保留 WORKSPACE_RECENT_LIMIT 项)
/** 「最近打开」LRU 上限:renderer workspace.store 与 main explorer:touch-recent 合并共用。 */
export const WORKSPACE_RECENT_LIMIT = 5;
const PINNED_MAX = 10_000; // pinned.paths
const WINDOWS_MAX = 10_000; // windows 段数
const pathStr = (): z.ZodString => z.string().max(PATH_STR_MAX);
const pathArray = (): z.ZodArray<z.ZodString> =>
  z.array(z.string().max(PATH_STR_MAX)).max(PATH_ARRAY_MAX);

// ─────────────────────────────────────────────────────
// DockviewReact 序列化输出。顶层 version 锁 1,passthrough 保留 dockview 自带字段。
// ─────────────────────────────────────────────────────
export const LayoutSchema = z
  .object({ version: z.literal(1).optional() })
  .passthrough();

const ExplorerSortSchema = z
  .object({
    by: z.enum(['name', 'mtime', 'ctime', 'size']),
    reverse: z.boolean(),
  })
  .strict();

const LayoutUiSchema = z
  .object({
    sidebarOpen: z.boolean(),
    sidebarWidth: z.number().int().positive(),
  })
  .strict();

// 编辑器视图状态跨重启(VSCode 持久化每个编辑器的选区 / 滚动与图片预览的缩放)。只写打开中的 tab,条数上限与
// 运行时写入(explorer-persist collectEditorViewStates)共用同一常量:读≡写同一 schema、写读 cap 对称。
/** editor.viewStates 条数上限(= 会话恢复的 tab 数上限 MAX_RESTORED_TABS)。 */
export const EDITOR_VIEW_STATES_MAX = 256;
/** 偏移 / 行号 / 滚动像素的上限(只挡畸形值;运行时写入前同样收进此范围)。 */
export const EDITOR_VIEW_NUMBER_MAX = 2_147_483_647;
const viewInt = (min: number): z.ZodNumber => z.number().int().min(min).max(EDITOR_VIEW_NUMBER_MAX);
const viewScroll = (): z.ZodNumber => z.number().min(0).max(EDITOR_VIEW_NUMBER_MAX);
/** 每个条目的折叠区域条数上限(运行时取折叠区域时同守)。 */
export const EDITOR_VIEW_FOLDS_MAX = 500;

const EditorViewStateEntrySchema = z
  .object({
    path: pathStr(),
    /**
     * 所属编辑器组(同一文件在多个组各一条,VSCode 按组 + 文件保存视图状态)。只在多于一个组时写;缺省 = 各组的回退值
     *(旧数据 / 单组)。BDD: src/__tests__/editor-view-state-groups/
     */
    group: z.string().max(32).regex(EDITOR_GROUP_ID_RE).optional(),
    /** CodeMirror 主选区(文档偏移;恢复时收进文档范围)。 */
    selection: z.object({ anchor: viewInt(0), head: viewInt(0) }).strict().optional(),
    /** CodeMirror 顶部可见行(1 起)。 */
    topLine: viewInt(1).optional(),
    /** CodeMirror 折叠区域(文档偏移;恢复时只折叠仍可原样折叠的)。 */
    folds: z
      .array(z.object({ from: viewInt(0), to: viewInt(0) }).strict())
      .max(EDITOR_VIEW_FOLDS_MAX)
      .optional(),
    /** Markdown(Milkdown 编辑 / 预览)滚动位置。 */
    scrollTop: viewScroll().optional(),
    /** 图片预览:'fit' 或相对原始尺寸的比例,及滚动位置。 */
    image: z
      .object({
        scale: z.union([z.literal('fit'), z.number().min(IMAGE_MIN_SCALE).max(IMAGE_MAX_SCALE)]),
        scrollLeft: viewScroll(),
        scrollTop: viewScroll(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * 用户选定的文件编码(「通过编码重新打开 / 保存」,VSCode FileEditorInput 序列化的 encoding → 恢复时作 preferredEncoding):
 * 每个文件一条(文档跨组共享同一编码),只写用户选定的(自动识别的 BOM / UTF-8 重启后照样识别),条数上限同 viewStates。
 * 编码 id 白名单 = shared/text-encoding。BDD: src/__tests__/editor-text-encoding/(encoding-restart.spec.ts)
 */
const EditorEncodingEntrySchema = z
  .object({
    path: pathStr(),
    encoding: z.enum(TEXT_ENCODING_IDS as [TextEncodingId, ...TextEncodingId[]]),
  })
  .strict();

const editorGroupId = (): z.ZodString => z.string().max(32).regex(EDITOR_GROUP_ID_RE);

const EditorGroupSessionSchema = z
  .object({
    id: editorGroupId(),
    openFilePaths: pathArray(),
    activePath: pathStr().nullable(),
    /** 组内 tab 最近使用顺序(首项 = 活动文件);只在与默认顺序不同时写。BDD: src/__tests__/editor-close-mru/ */
    mruPaths: pathArray().optional(),
    /** 组内的预览 tab(缺省 = 全部常驻,旧数据同)。BDD: src/__tests__/editor-preview-tab/ */
    previewPath: pathStr().optional(),
    /** 组内固定(pin)的 tab,按组内顺序(缺省 = 无,旧数据同)。BDD: src/__tests__/editor-tab-management/ */
    stickyPaths: pathArray().optional(),
  })
  .strict();

const EditorSessionSchema = z
  .object({
    openFilePaths: pathArray(), // 边界(E14)
    activePath: pathStr().nullable(),
    /** 单组时组内 tab 最近使用顺序(同 EditorGroupSessionSchema.mruPaths)。 */
    mruPaths: pathArray().optional(),
    /** 单组时的预览 tab(同 EditorGroupSessionSchema.previewPath)。 */
    previewPath: pathStr().optional(),
    /** 单组时固定的 tab(同 EditorGroupSessionSchema.stickyPaths)。 */
    stickyPaths: pathArray().optional(),
    /** Markdown 视图模式(全局);只在非默认(source)时写。 */
    mode: z.enum(['edit', 'source', 'preview']).optional(),
    viewStates: z.array(EditorViewStateEntrySchema).max(EDITOR_VIEW_STATES_MAX).optional(),
    /** 用户选定编码的打开中文件(见 EditorEncodingEntrySchema);缺省 = 全部自动识别(旧数据同)。 */
    encodings: z.array(EditorEncodingEntrySchema).max(EDITOR_VIEW_STATES_MAX).optional(),
    /**
     * 编辑器组(只在多于一个组时写;旧字段 openFilePaths / activePath 仍是全部文档 / 活动组的活动文件,旧版本照常读成单组)。
     * BDD: src/__tests__/editor-groups/
     */
    groups: z.array(EditorGroupSessionSchema).max(EDITOR_GROUPS_MAX).optional(),
    /** 活动编辑器组 id(随 groups 写)。 */
    activeGroup: editorGroupId().optional(),
    /** 编辑器组的最近使用顺序(随 groups 写;VSCode mostRecentActiveGroups)。BDD: src/__tests__/editor-tab-management/ */
    groupMru: z.array(editorGroupId()).max(EDITOR_GROUPS_MAX).optional(),
  })
  .strict();

export type EditorViewStateEntry = z.infer<typeof EditorViewStateEntrySchema>;
export type EditorEncodingEntry = z.infer<typeof EditorEncodingEntrySchema>;

// 搜索视图的输入跨重启(VSCode SearchView 视图状态:query.contentPattern / regex / caseSensitive / wholeWords /
// folderIncludes / folderExclusions / queryDetailsExpanded;恢复输入,不自动重搜)。只写非默认项;长度上限与
// search:start 入参同一常量(运行时输入同样截到此上限)。BDD: src/__tests__/workspace-search/
const WindowSearchSchema = z
  .object({
    pattern: z.string().max(SEARCH_PATTERN_MAX),
    isRegex: z.boolean().optional(),
    matchCase: z.boolean().optional(),
    wholeWord: z.boolean().optional(),
    include: z.string().max(SEARCH_GLOB_MAX).optional(),
    exclude: z.string().max(SEARCH_GLOB_MAX).optional(),
    // 「使用排除设置与忽略文件」(VSCode query.useExcludesAndIgnoreFiles;默认开,只写关)
    useExcludesAndIgnoreFiles: z.boolean().optional(),
    detailsOpen: z.boolean().optional(),
  })
  .strict();

export type PersistedSearchInput = z.infer<typeof WindowSearchSchema>;

// ── v1(legacy)— 仅 loadExplorer 接受,内部立即迁移到 v2 ────
/** 每个窗口的 Explorer 状态(v1 顶层与 v2 / v3 窗口段同形;上限只写一处)。 */
const ExplorerStateSchema = z
  .object({
    activePath: pathStr().nullable(), // 边界(E15)
    expandedPaths: pathArray(), // 边界(E14)
    sort: ExplorerSortSchema,
  })
  .strict();

export const ExplorerV1Schema = z
  .object({
    version: z.literal(1),
    workspace: z
      .object({
        root: pathStr().nullable(),
        recentRoots: z.array(pathStr()).max(RECENT_ROOTS_MAX), // 边界(E14)
      })
      .strict(),
    explorer: ExplorerStateSchema,
    pinned: z
      .object({
        paths: z.array(pathStr()).max(PINNED_MAX), // 边界(E14)
      })
      .strict(),
    layoutUi: LayoutUiSchema.optional(),
    editor: EditorSessionSchema.optional(),
  })
  .strict();

export type ExplorerV1Payload = z.infer<typeof ExplorerV1Schema>;

// ── v2 / v3 共用构件 ─────────────────────────────────────
// 重构:v2 WindowEntry 与 v3 writable WindowEntry 形状逐字段相同;v2 / v3-writable / v3-full 三个顶层
// schema 除 version 字面量与 windows 元素外也相同。此前三份各自手写,E14/E15 的上限曾漏改其中一份
// (「E14 漏改的 v2 多行形式」)→ 收口为单一定义,上限只写一处。

/** renderer 可写的窗口段(v2 WindowEntry 与 v3 writable WindowEntry 同形):strict,不含 main-owned 字段。 */
const WritableWindowEntrySchema = z
  .object({
    windowSeq: z.number().int().nonnegative(),
    workspace: z
      .object({
        root: pathStr().nullable(), // 边界(E15)
      })
      .strict(),
    explorer: ExplorerStateSchema,
    layoutUi: LayoutUiSchema.optional(),
    editor: EditorSessionSchema.optional(),
    /** 搜索视图的输入(只在非默认时写;旧数据缺省 → 空)。 */
    search: WindowSearchSchema.optional(),
  })
  .strict();

/** 顶层除 version / windows 之外的公共字段。 */
const explorerTopLevelShape = {
  workspace: z
    .object({
      recentRoots: z.array(pathStr()).max(RECENT_ROOTS_MAX), // 边界(E14/E15)
    })
    .strict(),
  pinned: z
    .object({
      paths: z.array(pathStr()).max(PINNED_MAX), // 边界(E14/E15)
    })
    .strict(),
  /** 下一个开新窗时分配的 windowSeq;主窗用 0,新窗自增. */
  nextWindowSeq: z.number().int().nonnegative(),
  /**
   * 启动时恢复哪些主窗口(VSCode `window.restoreWindows`,默认 `all`):缺省 / true = 恢复上次退出时开着的全部主窗口;
   * false = 只恢复一个(上次最后活动的窗口)。由设置项「启动时恢复所有窗口」经 window:set-restore-windows 写入(main-owned,
   * renderer 整份写回时保留盘上值)。旧数据缺省 → 视为 true。
   */
  restoreAllWindowsOnLaunch: z.boolean().optional(),
  /**
   * 上次退出时仍开着的主窗口 windowSeq,按最近活动排序(最后一个 = 最后活动的窗口,重启后焦点给它)。main 在退出确定时
   * 写入;运行期用户关掉某个窗口(非退出)即把它移出(VSCode:关掉的窗口不再恢复),关掉的是最后一个主窗口则只留它
   *(macOS 关光窗口再退出 / Windows 关最后一个窗口即退出时恢复它)。缺省(旧数据)= 只开主窗 seq 0。main-owned。
   */
  openWindowSeqs: z.array(z.number().int().nonnegative()).max(WINDOWS_MAX).optional(),
};

// ── v2(legacy compat)— 多窗口拆段 ────────────────────────

/** @deprecated v2 compatibility schema. New callers should use ExplorerSchemaV3 / ExplorerWritableSnapshotSchema. */
export const ExplorerSchema = z
  .object({
    version: z.literal(2),
    ...explorerTopLevelShape,
    /** 每窗口持久化段。windowSeq 跨重启稳定,关闭窗口段先保留(LRU 由调用方控制). */
    windows: z.array(WritableWindowEntrySchema).max(WINDOWS_MAX), // 边界(E14)
  })
  .strict();

export type ExplorerPayloadV2 = z.infer<typeof ExplorerSchema>;
export type ExplorerPayload = ExplorerPayloadV2 | ExplorerPayloadV3;
export type WindowEntry = z.infer<typeof WritableWindowEntrySchema>;

// ─── v3 schema ──────────────────────────────────────────

// 窗口几何(VSCode windowsStateHandler 每窗口记住位置 / 尺寸 / 最大化 / 全屏)。bounds = getNormalBounds()(最大化 /
// 全屏前的普通矩形,屏幕坐标,多显示器下可为负)。上限只挡畸形值。BDD: src/__tests__/window-state-restore/
const WINDOW_COORD_MAX = 1_000_000;
const WindowStateSchema = z
  .object({
    bounds: z
      .object({
        x: z.number().int().min(-WINDOW_COORD_MAX).max(WINDOW_COORD_MAX),
        y: z.number().int().min(-WINDOW_COORD_MAX).max(WINDOW_COORD_MAX),
        width: z.number().int().positive().max(WINDOW_COORD_MAX),
        height: z.number().int().positive().max(WINDOW_COORD_MAX),
      })
      .strict(),
    isMaximized: z.boolean().optional(),
    isFullScreen: z.boolean().optional(),
  })
  .strict();
export type PersistedWindowState = z.infer<typeof WindowStateSchema>;

/** popout 子窗状态(每项:popout 组 id、状态、写出时的 position;上限只挡畸形值 —— dockview 组 id 是短数字串)。 */
const POPOUT_WINDOW_MODES_MAX = 64;
const PopoutWindowModesSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(256),
        mode: z.enum(['maximized', 'fullscreen']),
        position: z
          .object({
            left: z.number().finite().min(-WINDOW_COORD_MAX).max(WINDOW_COORD_MAX),
            top: z.number().finite().min(-WINDOW_COORD_MAX).max(WINDOW_COORD_MAX),
            width: z.number().finite().positive().max(WINDOW_COORD_MAX),
            height: z.number().finite().positive().max(WINDOW_COORD_MAX),
          })
          .strict(),
      })
      .strict(),
  )
  .max(POPOUT_WINDOW_MODES_MAX);

/**
 * main-owned 窗口字段(renderer 不能写;写入合并时保留盘上值,explorer:read 返回前剥离)。字段清单与 schema 由同一个
 * shape 派生 —— 此前常量、schema extend、写入合并三处各写一遍,新增字段时合并漏保留即每次 renderer 写盘把它抹掉。
 */
const MAIN_OWNED_WINDOW_SHAPE = {
  layout: LayoutSchema.optional(),
  lastClosedAt: z.number().int().nonnegative().nullable().optional(),
  /** 窗口几何(关窗 / 退出时 main 记录,建窗时按显示器校验后恢复);缺省 = 新窗口默认尺寸。 */
  windowState: WindowStateSchema.optional(),
  /**
   * 该窗口 popout 子窗的最大化 / 全屏状态(layout:write 从布局 popout 组的 `windowMode` 摘出;布局里存的是普通矩形)。
   * 新增字段 → 旁挂 explorer-ext.json。BDD: src/__tests__/window-state-restore/popout-window-mode.spec.ts
   */
  popoutWindowModes: PopoutWindowModesSchema.optional(),
};
export const MAIN_OWNED_WINDOW_FIELDS = Object.keys(MAIN_OWNED_WINDOW_SHAPE) as readonly (keyof typeof MAIN_OWNED_WINDOW_SHAPE)[];

/** Full WindowEntry v3:writable + main-owned. */
const WindowEntrySchemaV3 = WritableWindowEntrySchema.extend(MAIN_OWNED_WINDOW_SHAPE).strict();

/** Writable Explorer Snapshot(renderer 用此 shape 写). */
export const ExplorerWritableSnapshotSchema = z
  .object({
    version: z.literal(3),
    ...explorerTopLevelShape,
    windows: z.array(WritableWindowEntrySchema).max(WINDOWS_MAX), // 边界(E14)
  })
  .strict();

// 按文件夹的会话快照(VSCode workspace storage:工作区状态按文件夹保存,重开 / 切回时恢复)。内容 = 窗口段里与工作区相关的
// 部分(复用窗口段 schema,去掉 windowSeq,root 必填),外加 main-owned 的 dock 布局;不含窗口几何 / lastClosedAt。
// main-owned:只由 main 在切换 root / 关窗 / 退出时写,renderer 整份写回保留盘上值、explorer:read 剥离。
// BDD: src/__tests__/workspace-snapshot/
/** 快照表运行时上限(最近使用的文件夹数,超出淘汰最旧);schema 上限更宽,只挡损坏 / 滥用(同 recentRoots)。 */
export const WORKSPACE_SNAPSHOTS_LIMIT = 20;
const WORKSPACE_SNAPSHOTS_MAX = 1000;
export const WorkspaceSnapshotStateSchema = WritableWindowEntrySchema.omit({ windowSeq: true })
  .extend({ workspace: z.object({ root: pathStr() }).strict() })
  .strict();
const WorkspaceSnapshotSchema = WorkspaceSnapshotStateSchema.extend({ layout: LayoutSchema.optional() }).strict();
/** 快照表的一项(最近使用在前)。WorkspaceSnapshotStateSchema 导出供 renderer 校验 explorer:switch-workspace 的返回值。 */
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
/** 快照里 renderer 恢复的部分(不含 dock 布局)。 */
export type WorkspaceSnapshotState = z.infer<typeof WorkspaceSnapshotStateSchema>;

/**
 * explorer:switch-workspace 入参(同一窗口切换 root):save = 切走前本窗的状态(dock 布局由 main 取盘上本窗段,入参不带),
 * open = 切到的 root(null = 关闭文件夹)。
 */
export const WorkspaceSwitchInputSchema = z
  .object({ save: WorkspaceSnapshotStateSchema.nullable(), open: pathStr().nullable() })
  .strict();
export type WorkspaceSwitchInput = z.infer<typeof WorkspaceSwitchInputSchema>;

/** Full Explorer Schema v3(loadExplorer 返回此 shape). */
export const ExplorerSchemaV3 = z
  .object({
    version: z.literal(3),
    ...explorerTopLevelShape,
    /** 按文件夹的会话快照(main-owned;缺省 = 空)。 */
    workspaceSnapshots: z.array(WorkspaceSnapshotSchema).max(WORKSPACE_SNAPSHOTS_MAX).optional(),
    windows: z.array(WindowEntrySchemaV3).max(WINDOWS_MAX), // 边界(E14)
  })
  .strict();

export type ExplorerWritablePayload = z.infer<
  typeof ExplorerWritableSnapshotSchema
>;
export type WindowEntryV3 = z.infer<typeof WindowEntrySchemaV3>;
export type ExplorerPayloadV3 = z.infer<typeof ExplorerSchemaV3>;

/** userData 下持久化会话(窗口段 / layout / 最近目录)的文件名;main 各处用 path.join(userData, 它)。 */
export const EXPLORER_FILE_NAME = 'explorer.json';
