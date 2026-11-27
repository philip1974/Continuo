// M-Editor Step E4:Editor 主容器编排。
// 顶部 EditorHeader(tab 行)+ 模式切换行(SegmentedControl)+ 主体(Milkdown / CodeEditor / Welcome)+ 确认对话框。
//
// mode 路由(决策 #1/#3/#4):
//   activeTab 是 .md → mode=edit:Milkdown;source:CodeEditor markdown;preview:Milkdown readonly
//     (含 frontmatter / wiki-link 的 .md:edit 须先确认,否则落到 source;preview 照常)
//     (较大的 .md:edit / preview 都落到 source,手动切换后按所选模式;BDD: src/__tests__/markdown-large-file/)
//   activeTab 非 .md → 直接 CodeEditor(mode 不显示)
//   activeTab 为 null → Welcome

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import {
  editorGroupIdsOf,
  getEffectiveMode,
  groupActiveTabIdOf,
  groupTabsOf,
  isTabMilkdownTooLarge,
  isTabMilkdownUnsafe,
  isTabOpenInOtherGroup,
  useEditorStore,
  usesMilkdownEngine,
  type EditorMode,
} from '@/stores/editor.store';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';
import { EditorGroupIdContext } from './editor-group-context';
import { t as translate, translateCount, useLocale, type TranslationKey } from '@/i18n';
import { isMarkdownPath } from './editor-path-utils';
import { basename } from '@/lib/path-cross';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { isInsideMenu } from '@/lib/menu-focus';
import { SegmentedControl, type SegmentedControlOption } from '@/design';
import { focusWithinOrLost } from '@/design/focus-within-or-lost';
import { focusActiveEditor, requestEditorFocus } from './editor-focus-registry';
import { EditorHeader, type TabChrome } from './EditorHeader';
import { EditorWelcome } from './EditorWelcome';
import { ImageViewer } from './ImageViewer';
import { isImagePreviewPath } from './editor-image';
import { createLazyCodeEditor, createLazyMilkdownEditor } from './editor-engine-loaders';
import { EditorEngineErrorBoundary } from './EditorEngineErrorBoundary';
import { toPreviewMarkdown } from './milkdown-roundtrip-safety';
import { findEditorFileTabById } from './editor-tab-lookup';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { dirtyTabsInBatch, nextBatchCloseStep, type BatchClose } from './tab-batch-close';
import { useStableCallback } from '@/lib/use-stable-callback';
import { rebindEditorRoots } from './editor-root-registry';
import { applyEditorWriteBack, EDITOR_DISK_CHANGED, EDITOR_UNTITLED, revertFile } from './editor-file-actions';
import { saveTabAs } from './save-as';
import { editorTabTitle } from './untitled';
import { openConflictCompare } from './conflict-compare';
import { editorFileDeps, saveAsDeps } from './editor-file-deps';
import { useAutoSave, isAutoSaveEnabled } from './useAutoSave';
import { NO_ACTIVE_TAB, useEditorFile } from './useEditorFile';
import { resolveLink } from './link-resolve';
import { startDebugDecorationSync } from './decorations/debug-decoration-sync';
import { useSettingValue } from '@/plugins/settings/values-store';
import {
  AUTO_SAVE_DELAY_MS,
  AUTO_SAVE_MARKDOWN_ENABLED,
} from '@/plugins/settings/core-setting-specs';
import { coApi } from '@/lib/co-api';
import type { EditorTab } from '@/stores/editor.store';
import { notifyFailure, notifyIfFailed, notifyThrownError } from '@/notifications/notify-thrown-error';
import { ERROR_CODES } from '../../../electron/shared/error-codes';
import { notifySaveFailed, openFileOrNotify } from '@/notifications/notify-open-failed';
import type { NotifyAction } from '@/notifications/notify';
import { basenameForChrome } from '@/lib/path-label';
import { isModalOpenFor, winningCommandFor, withDefaultCommands } from '@/plugins/command-palette/useCommandHotkeys';
import { coApp } from '@/plugins/co-app';
import { editorCommandSpecs, openAdjacentEditor, registerEditorPanelActions, registerMarkdownModeAction, SAVE_AS_COMMAND, SAVE_COMMAND, NEXT_EDITOR_COMMAND_ID, PREVIOUS_EDITOR_COMMAND_ID } from './editor-commands';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';

/** 面板就地处理的命令(保存 / 另存为 / 下一个 / 上一个编辑器)。 */
const PANEL_COMMAND_IDS: ReadonlySet<string> = new Set([
  SAVE_COMMAND.id,
  SAVE_AS_COMMAND.id,
  NEXT_EDITOR_COMMAND_ID,
  PREVIOUS_EDITOR_COMMAND_ID,
]);
/** 面板就地处理的命令的约定默认键:命令尚未注册时兜底,已注册以注册的 spec 为准。 */
const PANEL_DEFAULT_COMMANDS = editorCommandSpecs(detectPlatform()).filter((c) => PANEL_COMMAND_IDS.has(c.id));

/**
 * 保存失败时通知上附「另存为… / 重试」的错误(VSCode textFileSaveErrorHandler:一般写入错误给 Retry / Save As…):目标位置不存在 /
 * 被换成目录 / 父路径不是目录 / 无权限 / 只读卷 / 磁盘满 / IO 错误。外部修改与写保护另有确认框,不在此列。
 * BDD: src/__tests__/editor-save-as/
 */
const SAVE_FAILURE_ACTION_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.FS_NOT_FOUND,
  ERROR_CODES.FS_NOT_FILE,
  ERROR_CODES.FS_NOT_DIRECTORY,
  ERROR_CODES.FS_DENIED,
  ERROR_CODES.FS_READONLY_FS,
  ERROR_CODES.FS_NO_SPACE,
  ERROR_CODES.FS_IO,
]);

// i18n(I14):模式切换 label 走 catalog —— 此前硬编码英文 'Edit'/'Source'/'Preview',
// zh/ko 工具栏显英文且不随 locale 切换。id 稳定,label 在组件内用 useT 生成(响应 locale)。
const MODE_IDS: readonly EditorMode[] = ['edit', 'source', 'preview'];

// perf E2:两套编辑引擎各自 lazy —— CodeEditor(CodeMirror + 语言包)与 MilkdownEditor
// (Crepe/ProseMirror/katex)不再一起进 Editor chunk:Welcome 不加载任何引擎,代码文件不加载
// Milkdown,Markdown edit/preview 不加载 CodeEditor。body 外的 <Suspense key={engine}> 让
// 切换引擎时整个边界重挂(旧编辑器完整卸载,新编辑器首挂才可能 suspend),与原先 key 重挂语义一致。
// import 工厂取自共享加载器:co-app 的 openFile({line}) 预加载与这里共用同一 promise。
// 模块级实例:引擎已加载后再挂载同步渲染、不闪 fallback。chunk 加载失败由 EditorEngineErrorBoundary
// 接住;重试时替换失败引擎的实例(React.lazy 永久缓存 rejection),后续挂载也用新实例。
type LazyEngines = {
  code: ReturnType<typeof createLazyCodeEditor>;
  milkdown: ReturnType<typeof createLazyMilkdownEditor>;
};
let lazyEngines: LazyEngines = {
  code: createLazyCodeEditor(),
  milkdown: createLazyMilkdownEditor(),
};

/** 文案模板 {name} 占位的拆分标记(不会出现在 catalog 文案里)。 */
const NAME_SLOT = '\u0000name\u0000';

/**
 * 确认框说明:把文件名以 <code> 插到文案的 {name} 占位处 —— 位置与助词由各语言文案决定(韩语「{name} 파일은…」),
 * 不在组件里固定「文件名 + 空格 + 文案」。拆分做法同 AgentAuthPrompt 的 UNTRUSTED_SLOT。
 */
function withCodeName(key: TranslationKey, name: string): ReactNode {
  const [before = '', after = ''] = translate(key, { name: NAME_SLOT }).split(NAME_SLOT);
  return (
    <>
      {before}
      <code className="text-fg">{name}</code>
      {after}
    </>
  );
}

/** 合并确认框里最多逐行列出的文件名数(同关窗确认框 / 删除确认框,VSCode MAX_CONFIRM_FILES),其余一行概括。 */
const UNSAVED_LIST_MAX_NAMES = 10;

/** 合并确认框正文:逐行文件名(列表样式同资源管理器删除确认)+ 丢失提示。 */
function UnsavedFileList({ paths }: { readonly paths: readonly string[] }) {
  const names = paths.slice(0, UNSAVED_LIST_MAX_NAMES).map((p) => editorTabTitle(p));
  const more = paths.length - names.length;
  return (
    <>
      <ul className="mb-2 list-none">
        {names.map((n, i) => (
          <li key={i} className="truncate text-fg">
            {n}
          </li>
        ))}
        {more > 0 && <li>{translateCount('dialog.unsaved_close.more', more)}</li>}
      </ul>
      <p>{translate('dialog.unsaved_close.detail')}</p>
    </>
  );
}

export interface EditorPanelProps {
  /** dockview 面板 api(经 PanelHost 传入;测试直接渲染时缺省)。id = 本面板的编辑器组 id。 */
  readonly api?: Pick<DockviewPanelApi, 'onDidLocationChange'> & { readonly id?: string };
}

/**
 * 组内关闭的脏确认按「文档」判定:仍在别的组打开的文档关掉这一个编辑器不丢修改(VSCode 同),不弹确认。
 */
function groupTabsForClose(groupId: string): readonly { id: string; filePath: string; dirty: boolean }[] {
  const s = useEditorStore.getState();
  return groupTabsOf(s, groupId).map((t) => ({
    id: t.id,
    filePath: t.filePath,
    dirty: t.dirty && !isTabOpenInOtherGroup(s, t.id, groupId),
  }));
}

export function EditorPanel({ api }: EditorPanelProps = {}) {
  // 本面板 = 一个编辑器组(多实例编辑器面板;BDD: src/__tests__/editor-groups/)。
  const groupId = api?.id ?? PRIMARY_EDITOR_GROUP_ID;
  // 只订阅 active tab 对象(打磨 R27,延续 R22-R24 正文热路径收敛)。editor store
  // 的 updateContent/reloadFromDisk/markSaved 只替换被改的 tab 对象 → 非 active tab
  // 变化时 active tab 引用不变 → selector 返同一对象 → EditorPanel 主体不重渲;
  // active tab 变化(含切换/正文编辑)→ 新对象 → 正常重渲。tab 栏 chrome 由
  // EditorHeader 自己窄订阅,不依赖这里。
  const activeTab = useEditorStore(
    (s): EditorTab | null =>
      findEditorFileTabById(s.tabs, groupActiveTabIdOf(s, groupId)),
  );
  // 恢复出的组面板(dock 布局里的 editor:N)挂载时确保组存在;拆分新建的组已先建好。
  useEffect(() => useEditorStore.getState().ensureGroup(groupId), [groupId]);
  const locale = useLocale(); // i18n(I14):订阅 locale,模式切换 label 随语言更新
  const modeOptions = useMemo(
    () => {
      void locale; // deps:translate 内部按当前 locale 取值
      const options = new Array<SegmentedControlOption<EditorMode>>(
        MODE_IDS.length,
      );
      for (let i = 0; i < MODE_IDS.length; i += 1) {
        const id = MODE_IDS[i]!;
        options[i] = {
          id,
          label: translate(`panels.editor.mode.${id}`),
        };
      }
      return options;
    },
    [locale],
  );
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const updateContent = useEditorStore((s) => s.updateContent);
  const closeStoreTab = useEditorStore((s) => s.closeTab);
  // 面板内关闭 tab(⌘W / × / 关闭确认框 / 右键批量关闭)的唯一入口,一批一起判定(按全部关完后的活动 tab 聚焦,
  // 不按中途的):关闭前焦点在本面板里(编辑区 / tab 行 / 本面板的确认框)或已丢到 body 时 ——
  // - 关掉了活动 tab → 新的活动 tab 的编辑器获焦(VSCode:关闭活动编辑器后同组新的活动编辑器获焦);
  // - 只关掉非活动 tab → 仅当焦点随被关的标签一起丢失(右键菜单关闭先把焦点还给被右键的 tab)时交给本组活动编辑器
  //   (VSCode 同点 ×),焦点仍在编辑区 / 其它标签上不动。
  // 焦点在面板外(如 Explorer)不动焦点。BDD: src/__tests__/focus-after-close/、src/__tests__/tab-context-menu/
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTabs = useCallback(
    (ids: readonly string[]) => {
      const root = rootRef.current;
      const closesActive = ids.some((id) => id === groupActiveTabIdOf(useEditorStore.getState(), groupId));
      const refocus = root !== null && focusWithinOrLost(root.ownerDocument, root);
      for (const id of ids) closeStoreTab(id, groupId);
      if (!refocus) return;
      const s = useEditorStore.getState();
      // 组随最后一个 tab 关闭(closeEmptyGroups)→ 焦点交给新的活动组的编辑器。
      if (!editorGroupIdsOf(s).includes(groupId)) {
        focusActiveEditor();
        return;
      }
      const next = groupActiveTabIdOf(s, groupId);
      // 关掉的是最后一个 tab → 焦点留在空编辑器组(面板根,tabIndex=-1),不随卸载的编辑区掉到 body(VSCode 同)。
      const focusNext = () => (next === null ? root.focus() : requestEditorFocus(next, groupId));
      if (closesActive) {
        focusNext();
        return;
      }
      // 标签在本次提交(useSyncExternalStore 同步优先级,微任务内)里才移除:下一帧再看焦点是否丢了。
      requestAnimationFrame(() => {
        if (focusWithinOrLost(root.ownerDocument, null)) focusNext();
      });
    },
    [closeStoreTab, groupId],
  );
  const acceptUnsafeEdit = useEditorStore((s) => s.acceptUnsafeEdit);
  const acceptLargeMilkdown = useEditorStore((s) => s.acceptLargeMilkdown);
  // 引擎 lazy 实例 + 重试代数:重试新建失败引擎的 lazy 实例,并换 key 重挂错误边界。
  const [engines, setEngines] = useState(() => lazyEngines);
  const [engineRetry, setEngineRetry] = useState(0);
  const { code: CodeEditor, milkdown: MilkdownEditor } = engines;
  const retryEngine = useCallback((which: 'welcome' | 'image' | 'code' | 'milkdown') => {
    if (which === 'code') {
      lazyEngines = { ...lazyEngines, code: createLazyCodeEditor() };
    } else if (which === 'milkdown') {
      lazyEngines = { ...lazyEngines, milkdown: createLazyMilkdownEditor() };
    }
    setEngines(lazyEngines);
    setEngineRetry((n) => n + 1);
  }, []);
  const effective = getEffectiveMode(activeTab);
  // perf P5:复用派生缓存(isTabMilkdownUnsafe 内部 cache-or-compute),不再在 render
  // 里对全文重跑 isMilkdownUnsafe —— 否则每按键 = updateContent 1 次 + 此处 1 次。
  const unsafeMarkdown = isTabMilkdownUnsafe(activeTab);
  const activeIsMarkdown = activeTab !== null && isMarkdownPath(activeTab.filePath);
  // 较大的 Markdown 且未手动选过编辑 / 预览:编辑 / 预览落到源码(窗口级 mode 不改),顶部一行提示
  const largeMarkdown = activeIsMarkdown && isTabMilkdownTooLarge(activeTab) && !activeTab.milkdownLargeAccepted;
  const forcedLarge = largeMarkdown && mode !== 'source';
  const forcedSource = unsafeMarkdown && effective !== mode && !forcedLarge;
  // 手动切到编辑 / 预览后正在渲染的较大文件(tab id):提示换成「正在渲染」,Milkdown 就绪后收起
  const [renderingLarge, setRenderingLarge] = useState<string | null>(null);
  const handleViewReady = useCallback(() => setRenderingLarge(null), []);

  const { saveActive, saveTab, openFileByPath } = useEditorFile();

  // markdown link 点击路由(issue #25):Cmd/Ctrl+click on <a> → MilkdownEditor
  // 上抛 href → 这里用 resolveLink 决定走 IDE 内打开还是系统外链。
  // 相对路径以当前 activeTab.filePath 所在目录为基底。
  const handleLinkClick = useCallback(
    (href: string) => {
      const target = resolveLink(href, activeTab?.filePath ?? null);
      if (!target) return;
      if (target.kind === 'file') {
        // a11y(A127,A117 同族):本地文件链接打开须检查 FileOpResult.ok + catch reject,否则
        // 目标文件不存在/读取失败时无 toast/live 反馈,用户只感知链接「没反应」(同外链分支)。
        // 失败提示与 Explorer / Quick Open 一致:「打开失败 <文件名>: <按 code 本地化的原因>」。
        const name = basenameForChrome(target.absPath);
        void openFileOrNotify(() => openFileByPath(target.absPath), name, undefined, (encoding) =>
          openFileByPath(target.absPath, { encoding }),
        );
      } else {
        // a11y(A117,A50/A116 同族):外链打开须检查 IpcResult.ok + catch reject,否则 URL 被
        // 白名单拒绝或系统打开失败时无 toast/live 反馈,用户只感知链接「没反应」。
        notifyIfFailed(coApi.shell.openExternal(target.url));
      }
    },
    [activeTab?.filePath, openFileByPath],
  );
  // 自动保存(Markdown)开关 + 延迟 — 都受 SettingsPanel 控制
  const mdAutoSaveEnabled = useSettingValue(AUTO_SAVE_MARKDOWN_ENABLED.id, AUTO_SAVE_MARKDOWN_ENABLED.default);
  const autoSaveDelayMs = useSettingValue(AUTO_SAVE_DELAY_MS.id, AUTO_SAVE_DELAY_MS.default);
  const autoSaveEnabled =
    isAutoSaveEnabled(activeTab?.filePath ?? null) && mdAutoSaveEnabled;

  // 关闭脏 tab 二次确认。closeCandidate 用轻量 TabChrome(打磨 R23:不持完整
  // EditorTab/content,确认框只需 filePath,关闭只需 id)。
  // batch:所属的批量关闭进度(右键「全部关闭」等;单个关闭也是一批只含它自己),确认后接着推进。
  const [closeCandidate, setCloseCandidate] = useState<(TabChrome & { readonly batch: BatchClose }) | null>(null);
  // 一批里多于 1 个脏 tab:合并确认框(VSCode showSaveConfirm「是否要保存对以下 N 个文件的更改?」全部保存 / 不保存 / 取消)。
  const [multiCloseCandidate, setMultiCloseCandidate] = useState<{
    readonly paths: readonly string[];
    readonly batch: BatchClose;
  } | null>(null);

  // 自动保存:Markdown 启用,代码不启用(决策 #3)。按 tabId 保存,切走/卸载时
  // flush pending,避免连续输入后立即切 tab 丢失整段编辑。
  // 关闭脏 tab 的「放弃修改?」确认框开着时暂停:否则停留超过 delay 会把待放弃的内容写盘。
  // !enabled 取消已排队的保存;取消确认后 enabled 恢复,仍脏照常重新排队。
  useAutoSave(saveTab, {
    enabled: autoSaveEnabled && closeCandidate === null && multiCloseCandidate === null,
    delayMs: autoSaveDelayMs,
    groupId,
  });

  // 外部进程修改文件时自动同步 non-dirty tab:useExternalFileSync 由常驻 MainApp 承载(见 App.tsx)。

  useEffect(() => startDebugDecorationSync(), []);

  // popout 弹出 / 收回只移动面板 DOM、不重挂编辑器:移动落定后(同终端拖放 topic-25 的 microtask)让已挂载的
  // CodeMirror / ProseMirror 按所在文档重绑 root,否则子窗里仍按主窗文档取选区。
  // BDD: src/__tests__/editor-popout-root/
  useEffect(() => {
    if (!api) return;
    const sub = api.onDidLocationChange(() => queueMicrotask(rebindEditorRoots));
    return () => sub.dispose();
  }, [api]);

  // 打磨 P2-BL:显式保存遇磁盘被外部改过(EDITOR_DISK_CHANGED)→ 确认覆盖,不静默写。
  // 轻量 TabChrome 子集(确认框只需 filePath,覆盖只需 id),同 closeCandidate。
  // batch:来自关闭脏 tab 时选「保存」—— 覆盖写盘 / 放弃并重新加载成功后接着推进这批关闭(VSCode 组内批量关闭同);
  // 失败 / 取消 → 整批结束,一个都不关。
  const [overwriteCandidate, setOverwriteCandidate] = useState<
    (Pick<TabChrome, 'id' | 'filePath'> & { readonly batch?: BatchClose }) | null
  >(null);
  // 保存遇写保护文件(FS_READONLY)→ 确认「覆盖 / 取消」(VSCode「File is write-protected … Overwrite」):覆盖 =
  // 带 overwriteReadonly 重试(主进程去掉写保护再写)。force:来自外部修改的「仍然覆盖」—— 重试时同样跳过磁盘比较。
  // BDD: src/__tests__/save-readonly-file/
  const [readonlyCandidate, setReadonlyCandidate] = useState<
    | (Pick<TabChrome, 'id' | 'filePath'> & { readonly batch?: BatchClose; readonly force?: boolean })
    | null
  >(null);

  // 另存为(⇧⌘S;无标题文件的保存同样走这里;BDD: src/__tests__/editor-save-as/):取消 → false,不提示;失败 → 「保存失败
  // <文件名>:<原因>」附「另存为…」(重新选位置)。返回保存到的路径(= tab 的新 id);未保存 → null。
  const saveAsTab = useStableCallback(async (tabId: string): Promise<string | null> => {
    const tab = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
    if (!tab) return null;
    try {
      const r = await saveTabAs(tabId, saveAsDeps);
      if (r.ok) return r.data;
      notifySaveFailed(editorTabTitle(tab.filePath), r, [
        { label: translate('editor.save_as_action'), run: () => void saveAsTab(tabId) },
      ]);
    } catch (err) {
      notifyThrownError(err);
    }
    return null;
  });

  // 另存为本组的活动文件 tab(无 → 无操作)。
  const activePanelSaveAs = useStableCallback(async (): Promise<void> => {
    const s = useEditorStore.getState();
    const id = groupActiveTabIdOf(s, groupId);
    if (id !== null && findEditorFileTabById(s.tabs, id)) await saveAsTab(id);
  });

  // 保存失败的统一出口:无标题文件 → 另存为(来自关闭时的「保存」→ 保存成功后接着推进这批关闭);写保护 → 覆盖确认;其它 →
  //「保存失败 <文件名>:<原因>」,写入类错误附「另存为… / 重试」(重试 = 同一次保存再来一遍,带上已确认的覆盖)。
  const onSaveFailed = useStableCallback(
    (
      target: Pick<TabChrome, 'id' | 'filePath'>,
      r: { readonly code: string; readonly message?: string },
      flags: { readonly batch?: BatchClose; readonly force?: boolean } = {},
    ) => {
      if (r.code === EDITOR_UNTITLED) {
        const batch = flags.batch;
        void saveAsTab(target.id).then((saved) => {
          // 另存后 tab 换了 id:这批关闭里的旧 id 换成新 id 再推进
          if (saved === null || !batch) return;
          const remap = (ids: readonly string[]) => ids.map((id) => (id === target.id ? saved : id));
          advanceBatchClose({ ...batch, rest: remap(batch.rest), closeIds: remap(batch.closeIds) });
        });
        return;
      }
      if (r.code === ERROR_CODES.FS_READONLY) {
        setReadonlyCandidate({ id: target.id, filePath: target.filePath, ...flags });
        return;
      }
      notifySaveFailed(editorTabTitle(target.filePath), r, saveFailureActions(target.id, r.code, flags.force === true));
    },
  );
  const saveFailureActions = useStableCallback(
    (tabId: string, code: string, force: boolean): NotifyAction[] | undefined =>
      SAVE_FAILURE_ACTION_CODES.has(code)
        ? [
            { label: translate('editor.save_as_action'), run: () => void saveAsTab(tabId) },
            { label: translate('editor.retry_save'), run: () => void retrySave(tabId, force) },
          ]
        : undefined,
  );
  // 「重试」:按同一 tab 再保存一次(tab 已关 → 无操作);结果处理同显式保存。
  const retrySave = useStableCallback(async (tabId: string, force: boolean) => {
    const target = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
    if (!target) return;
    try {
      flushEditorWriteBacks([tabId]);
      const r = await saveTab(tabId, force ? { force: true } : undefined);
      if (r.ok) return;
      if (r.code === EDITOR_DISK_CHANGED) setOverwriteCandidate({ id: target.id, filePath: target.filePath });
      else onSaveFailed(target, r, { force });
    } catch (err) {
      notifyThrownError(err);
    }
  });

  // 显式保存(Cmd+S 或 toolbar)
  const handleSave = useCallback(async () => {
    const s = useEditorStore.getState();
    const target = findEditorFileTabById(s.tabs, groupActiveTabIdOf(s, groupId));
    const r = await saveActive(target?.id);
    if (!r.ok) {
      // 没有可保存的 tab(无编辑器 tab 时按 ⌘S):VSCode 静默,不弹错误。真实保存失败仍提示。
      if (r.code === NO_ACTIVE_TAB) return;
      if (r.code === EDITOR_DISK_CHANGED && target) {
        setOverwriteCandidate({ id: target.id, filePath: target.filePath });
        return;
      }
      // i18n(I7,复查 P1):TAB_NOT_FOUND / FS_* 都到
      // 这里,r.message 是 main/动作层的 raw(FS_* 英文)→ 双向泄漏。
      // 按 code 经 catalog 本地化(单一来源 localizeErrorByCode),未收录 code 回退原 message。
      // 有目标 tab → 带文件名(保存失败 <name>:<原因>);无 → 只有原因。
      if (target) onSaveFailed(target, r);
      else notifyFailure(r);
    }
  }, [saveActive, onSaveFailed, groupId]);
  // 全部保存(⌥⌘S)的单个 tab(见 EditorPanelActions.saveTabForSaveAll):失败处理同显式保存;本次全部保存已弹过确认框
  //(allowPrompt = false)→ 外部修改 / 写保护也只按 code 提示,不叠第二个框。
  const saveTabForSaveAll = useStableCallback(async (tabId: string, allowPrompt: boolean): Promise<boolean> => {
    const target = findEditorFileTabById(useEditorStore.getState().tabs, tabId);
    if (!target) return false;
    const r = await saveTab(tabId);
    if (r.ok) return false;
    // 无标题文件:逐个弹另存为对话框(VSCode 全部保存同样为每个无标题文件弹保存对话框),不算本次的确认框
    if (r.code === EDITOR_UNTITLED) {
      await saveAsTab(tabId);
      return false;
    }
    if (!allowPrompt) {
      notifySaveFailed(editorTabTitle(target.filePath), r, saveFailureActions(target.id, r.code, false));
      return false;
    }
    if (r.code === EDITOR_DISK_CHANGED) {
      setOverwriteCandidate({ id: target.id, filePath: target.filePath });
      return true;
    }
    onSaveFailed(target, r);
    return r.code === ERROR_CODES.FS_READONLY;
  });
  // 「保存」(VSCode 关闭脏编辑器的默认按钮):保存成功才推进这批关闭;磁盘已被外部修改 / 写保护 → 走覆盖确认(覆盖或
  // 放弃并重新加载成功后接着推进,取消 / 失败则整批结束);其它失败不关闭、按 code 提示,改动留在 tab 里。
  // 合并框「全部保存」时每个脏 tab 也走这里(不弹单个确认框);某个失败 → 整批结束,之前已保存的落盘但 tab 不关。
  const saveAndAdvance = useStableCallback(async (candidate: TabChrome & { readonly batch: BatchClose }) => {
    try {
      const r = await saveTab(candidate.id);
      if (r.ok) {
        advanceBatchClose(candidate.batch);
        return;
      }
      if (r.code === EDITOR_DISK_CHANGED) {
        setOverwriteCandidate({ id: candidate.id, filePath: candidate.filePath, batch: candidate.batch });
        return;
      }
      onSaveFailed(candidate, r, { batch: candidate.batch });
    } catch (err) {
      notifyThrownError(err);
    }
  });
  // 关闭 tab(单个 × / ⌘W / 中键,与右键「关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭」同一路径):只有 1 个脏 tab → 确认它
  // (保存 / 不保存 / 取消;批量时先切到该 tab,VSCode 同);多于 1 个 → onTabsCloseRequest 先弹合并框,选「全部保存」
  // (saveAll)后不再逐个确认,按顺序保存(saveAndAdvance)。全部处理完才一起关闭;任一处取消 / 失败 → 整批不关。
  // closeCandidate 声明在 useAutoSave 之前,确认框开着时暂停 autosave。BDD: src/__tests__/tab-context-menu/
  const advanceBatchClose = useCallback(
    (progress: BatchClose) => {
      const step = nextBatchCloseStep(groupTabsForClose(groupId), progress);
      if (step.kind === 'close') {
        closeTabs(step.ids);
        return;
      }
      if (progress.saveAll) {
        void saveAndAdvance({ ...step.tab, batch: step.batch });
        return;
      }
      if (progress.closeIds.length > 1) useEditorStore.getState().switchTab(step.tab.id, { groupId });
      setCloseCandidate({ ...step.tab, batch: step.batch });
    },
    // saveAndAdvance 引用恒定(latest-ref),它与本函数互相调用(调用时取最新)。
    [closeTabs, groupId, saveAndAdvance],
  );
  const confirmOverwrite = useCallback(async () => {
    const candidate = overwriteCandidate;
    setOverwriteCandidate(null);
    if (!candidate) return;
    try {
      const r = await saveTab(candidate.id, { force: true });
      if (!r.ok) onSaveFailed(candidate, r, { batch: candidate.batch, force: true });
      else if (candidate.batch) advanceBatchClose(candidate.batch);
    } catch (err) {
      notifyThrownError(err);
    }
  }, [overwriteCandidate, saveTab, advanceBatchClose, onSaveFailed]);
  const confirmOverwriteReadonly = useCallback(async () => {
    const candidate = readonlyCandidate;
    setReadonlyCandidate(null);
    if (!candidate) return;
    try {
      const r = await saveTab(candidate.id, { force: candidate.force, overwriteReadonly: true });
      if (!r.ok) {
        if (r.code === EDITOR_DISK_CHANGED) {
          setOverwriteCandidate({ id: candidate.id, filePath: candidate.filePath, batch: candidate.batch });
        } else {
          notifySaveFailed(editorTabTitle(candidate.filePath), r, saveFailureActions(candidate.id, r.code, candidate.force === true));
        }
      } else if (candidate.batch) advanceBatchClose(candidate.batch);
    } catch (err) {
      notifyThrownError(err);
    }
  }, [readonlyCandidate, saveTab, advanceBatchClose, saveFailureActions]);
  // 冲突时「放弃更改并重新加载」(VSCode Revert):tab 换成磁盘版本、丢弃未保存修改;来自关闭时的「保存」→ 接着推进这批关闭。
  const revertOverwriteCandidate = useCallback(async () => {
    const candidate = overwriteCandidate;
    setOverwriteCandidate(null);
    if (!candidate) return;
    try {
      const r = await revertFile(candidate.id, editorFileDeps);
      if (!r.ok) notifyFailure(r);
      else if (candidate.batch) advanceBatchClose(candidate.batch);
    } catch (err) {
      notifyThrownError(err);
    }
  }, [overwriteCandidate, advanceBatchClose]);

  // 冲突时「比较」(VSCode Compare):打开差异 tab(左磁盘当前内容 ↔ 右你的版本),不写盘、tab 仍脏;来自关闭时的「保存」→
  // 这批关闭结束(同取消)。BDD: src/__tests__/editor-save-conflict-compare/
  const compareOverwriteCandidate = useCallback(() => {
    const candidate = overwriteCandidate;
    setOverwriteCandidate(null);
    if (candidate) openConflictCompare(candidate.id, groupId);
  }, [overwriteCandidate, groupId]);

  const onTabsCloseRequest = useCallback(
    (ids: readonly string[]) => {
      // TabChrome 的 dirty 是快照,store 可能落后编辑器(Milkdown 自适应延迟上抛,单次最长约 2s、持续输入最长 5s):
      // 先同步回写未上抛的输入,再按 store 最新 dirty 判定。否则「干净」tab 直接关闭,
      // 随后卸载回写找不到 tab → 这段输入丢失。
      flushEditorWriteBacks(ids);
      const progress: BatchClose = { rest: ids, closeIds: ids };
      const dirty = dirtyTabsInBatch(groupTabsForClose(groupId), progress);
      if (dirty.length > 1) {
        setMultiCloseCandidate({ paths: dirty.map((tab) => tab.filePath), batch: progress });
        return;
      }
      advanceBatchClose(progress);
    },
    [advanceBatchClose, groupId],
  );
  const onTabCloseRequest = useCallback((tab: TabChrome) => onTabsCloseRequest([tab.id]), [onTabsCloseRequest]);
  const confirmDiscard = useCallback(() => {
    setCloseCandidate(null);
    if (closeCandidate) advanceBatchClose(closeCandidate.batch);
  }, [closeCandidate, advanceBatchClose]);
  const confirmSaveAndClose = useCallback(() => {
    const candidate = closeCandidate;
    setCloseCandidate(null);
    if (candidate) void saveAndAdvance(candidate);
  }, [closeCandidate, saveAndAdvance]);
  // 合并框:全部保存 → saveAll 进度逐个保存;不保存 → 关闭这批里仍在的全部 tab;取消 → 整批不动。
  const confirmMultiSaveAll = useCallback(() => {
    const candidate = multiCloseCandidate;
    setMultiCloseCandidate(null);
    if (candidate) advanceBatchClose({ ...candidate.batch, saveAll: true });
  }, [multiCloseCandidate, advanceBatchClose]);
  const confirmMultiDiscard = useCallback(() => {
    const candidate = multiCloseCandidate;
    setMultiCloseCandidate(null);
    if (candidate) advanceBatchClose({ rest: [], closeIds: candidate.batch.closeIds });
  }, [multiCloseCandidate, advanceBatchClose]);

  // 全局命令 workbench.action.files.save / closeActiveEditor(⌘S / ⌘W,焦点在面板外也生效)经此调用面板内同一实现
  //(覆盖确认 / 保存·不保存·取消 确认框状态在本组件)。BDD: src/__tests__/workbench-editor-commands/
  useEffect(
    () =>
      registerEditorPanelActions(
        {
          save: handleSave,
          saveAs: activePanelSaveAs,
          closeActiveTab: () => {
            const s = useEditorStore.getState();
            const tab = findEditorFileTabById(s.tabs, groupActiveTabIdOf(s, groupId));
            if (!tab) return false;
            onTabCloseRequest(tab);
            return true;
          },
          closeTabs: onTabsCloseRequest,
          saveTabForSaveAll,
        },
        groupId,
      ),
    [handleSave, activePanelSaveAs, onTabCloseRequest, onTabsCloseRequest, saveTabForSaveAll, groupId],
  );

  // 切模式;较大的 Markdown 切到编辑 / 预览:该 tab 记为已接受。渲染是同步长任务 → 先让「正在渲染」提示画出来(下一帧之后)
  // 再切,渲染期间画面停在提示上。
  const activeTabIdForMode = activeTab?.id;
  const applyMode = useCallback(
    (next: EditorMode) => {
      const id = activeTabIdForMode;
      if (next === 'source' || id === undefined || !largeMarkdown) {
        setMode(next);
        return;
      }
      setRenderingLarge(id);
      requestAnimationFrame(() =>
        setTimeout(() => {
          acceptLargeMilkdown(id);
          setMode(next);
        }, 0),
      );
    },
    [setMode, acceptLargeMilkdown, activeTabIdForMode, largeMarkdown],
  );

  // Unsafe markdown cannot be opened in Milkdown without an explicit warning.
  const [unsafeEditConfirmOpen, setUnsafeEditConfirmOpen] = useState(false);
  const requestModeChange = useCallback(
    (next: EditorMode) => {
      if (next === 'edit' && unsafeMarkdown && !activeTab?.unsafeEditAccepted) {
        setUnsafeEditConfirmOpen(true);
        return;
      }
      applyMode(next);
    },
    [applyMode, unsafeMarkdown, activeTab?.unsafeEditAccepted],
  );
  // 命令 markdown.switchTo*Mode(BDD: src/__tests__/command-discoverability/):与模式切换控件同一路径;活动 tab 不是 Markdown → 忽略。
  useEffect(
    () =>
      registerMarkdownModeAction((next) => {
        if (activeIsMarkdown) requestModeChange(next);
      }, groupId),
    [activeIsMarkdown, requestModeChange, groupId],
  );
  const activeTabId = activeTab?.id ?? null;
  // 确认框针对打开它时的 tab;active tab 换了(如 SDK openFile)就作废,免得确认到别的文件上
  useEffect(() => {
    setUnsafeEditConfirmOpen(false);
    setRenderingLarge(null);
  }, [activeTabId]);
  const confirmUnsafeEdit = useCallback(() => {
    if (activeTabId !== null) acceptUnsafeEdit(activeTabId);
    applyMode('edit');
    setUnsafeEditConfirmOpen(false);
  }, [acceptUnsafeEdit, activeTabId, applyMode]);

  // 判定主体渲染(根据 activeTab 类型 + mode)
  let body: React.ReactNode;
  let engine: 'welcome' | 'image' | 'code' | 'milkdown';
  if (!activeTab) {
    engine = 'welcome';
    body = <EditorWelcome />;
  } else if (isImagePreviewPath(activeTab.filePath)) {
    // 图片:只读预览(不读成文本,见 editor-image)。reloadEpoch 并入 key:外部修改后重挂重新读图。
    engine = 'image';
    body = (
      <ImageViewer
        key={`${activeTab.id}-${activeTab.reloadEpoch ?? 0}`}
        tabId={activeTab.id}
        filePath={activeTab.filePath}
      />
    );
  } else if (usesMilkdownEngine(activeTab.filePath, activeTab)) {
    engine = 'milkdown';
    const tabId = activeTab.id;
    // preview 只读不回写,frontmatter 换成 yaml 代码块展示(否则被解析成横线+标题)
    const content = effective === 'preview' ? toPreviewMarkdown(activeTab.content) : activeTab.content;
    body = (
      <MilkdownEditor
        // reloadEpoch 并入 key:外部进程改文件 → reloadFromDisk 递增 epoch →
        // Milkdown remount 拿新内容,避免基于陈旧内容编辑后保存覆盖外部改动。
        // 用户输入/保存不动 epoch,故不会每次按键 remount。
        key={`${activeTab.id}-${effective}-${activeTab.reloadEpoch ?? 0}`}
        tabId={activeTab.id}
        fileName={activeTab.filePath}
        defaultValue={content}
        // store 内容被别处改了(另一编辑器组 / 程序化改内容)→ 编辑器以最小差异套进视图,不重挂载:本组光标 / 选区随变化
        // 映射、撤销栈保留(VSCode 各编辑器保留自己的光标)。本视图自己上抛的内容不套用。BDD: src/__tests__/editor-groups/
        value={content}
        readonly={effective === 'preview'}
        onChange={(md) => updateContent(tabId, md)}
        onWriteBack={(md, base) => applyEditorWriteBack(tabId, md, base)}
        onLinkClick={handleLinkClick}
        onViewReady={handleViewReady}
      />
    );
  } else {
    // 代码文件,或 Markdown 的源码模式(实际模式为 source:用户选的,或 unsafe 文档被强制):CodeEditor。
    // Markdown 源码视图 key 带 -src 后缀、强制 markdown 高亮。
    engine = 'code';
    body = (
      <CodeEditor
        key={activeIsMarkdown ? `${activeTab.id}-src` : activeTab.id}
        tabId={activeTab.id}
        value={activeTab.content}
        fileName={activeTab.filePath}
        {...(activeIsMarkdown ? { forceLanguage: 'markdown' as const } : {})}
        onChange={(v) => updateContent(activeTab.id, v)}
      />
    );
  }

  return (
    <EditorGroupIdContext.Provider value={groupId}>
    <div
      ref={rootRef}
      // 空编辑器组的焦点落点(关掉最后一个 tab 后);只经脚本聚焦,不进 Tab 顺序。
      tabIndex={-1}
      data-editor-panel-root=""
      className="flex h-full w-full flex-col bg-canvas outline-none"
      onKeyDown={(e) => {
        // 保存 / 下一个 / 上一个编辑器在面板内就地处理并截住冒泡:不再到 document 的全局分发(否则一次按键执行两次);
        // 面板在 popout 子窗时全局分发不监听子窗 document,靠这里处理;切换只作用于本编辑器的文件 tab。
        // 裁决与全局分发同一张表(winningCommandFor):只有胜出命令是这三个之一才处理 —— 用户把别的命令绑到 ⌘S 时
        // 这里不保存(交给全局分发执行那个命令);改绑 / 解绑都跟随。
        // 不处理:面板内确认框开着(按键冒泡自框内,对话框期间工作台快捷键不触发);编辑器内容已处理的键
        //(defaultPrevented,如保存改绑到 ⌘D / ⌘/ 时 CodeMirror 的选中下一处 / 切换注释)不再叠一个动作。
        // 面板内 tab 右键菜单(portal 出去,但 React 事件沿组件树冒泡到这里)里的按键同理不处理。
        if (e.defaultPrevented || isModalOpenFor(e.nativeEvent) || isInsideMenu(e.target)) return;
        const winner = winningCommandFor(
          e.nativeEvent,
          withDefaultCommands(coApp.commands.getAll(), PANEL_DEFAULT_COMMANDS),
        )?.id;
        if (winner === undefined || !PANEL_COMMAND_IDS.has(winner)) return;
        e.preventDefault();
        e.stopPropagation();
        if (winner === SAVE_COMMAND.id) void handleSave();
        else if (winner === SAVE_AS_COMMAND.id) void activePanelSaveAs();
        else openAdjacentEditor(winner === NEXT_EDITOR_COMMAND_ID ? 1 : -1, groupId);
      }}
      // 焦点进入本组(编辑区 / tab 行)→ 成为活动组:之后打开的文件落在这里(VSCode 最近活动的组)。
      onFocus={() => useEditorStore.getState().setActiveGroup(groupId)}
    >
      <EditorHeader onCloseRequest={onTabCloseRequest} onCloseTabsRequest={onTabsCloseRequest} />
      {activeIsMarkdown && (
        // markdown 模式切换:tab 行下方独立一行,居中。
        // 不加 border — 与上方 tab 行 / 下方编辑器无缝衔接,只靠 SegmentedControl
        // 自身的 surface-container-low 背景与 canvas 形成视觉区分。
        // 显示条件 = markdown 文件 — 与 autoSave 解耦,
        //   关掉自动保存不会让模式切换跟着消失。
        <div className="flex h-9 shrink-0 items-center justify-center bg-canvas px-3">
          <SegmentedControl
            // a11y(A22,A21 同族):radiogroup 须有 group 名,否则 AT 只读一组 radio(编辑/源码/
            // 预览)不知是「编辑器模式」选择器。这是除 SettingItemRow 外另一 SegmentedControl 调用点。
            ariaLabel={translate('panels.editor.mode_group')}
            options={modeOptions}
            value={effective}
            onChange={requestModeChange}
            size="sm"
          />
        </div>
      )}
      {renderingLarge !== null && renderingLarge === activeTabId ? (
        <div role="status" className="bg-panel-soft px-4 py-2 text-xs text-fg-muted">
          {translate('panels.editor.milkdownLarge.rendering')}
        </div>
      ) : forcedLarge ? (
        <div role="status" className="bg-panel-soft px-4 py-2 text-xs text-fg-muted">
          {translate('panels.editor.milkdownLarge.banner')}
        </div>
      ) : (
        forcedSource && (
          <div className="bg-panel-soft px-4 py-2 text-xs text-fg-muted">
            {translate('panels.editor.milkdownUnsafe.banner')}
          </div>
        )
      )}
      <div className="min-h-0 flex-1">
        {/* perf E2:引擎 chunk 首次加载期间 fallback 为空(同 lazyPanel 外层),加载完即挂载。
            key 含 engine:切换引擎时边界整体重挂;含重试代数:重试后清掉错误态重新加载。 */}
        <EditorEngineErrorBoundary
          key={`${engine}:${engineRetry}`}
          onRetry={() => retryEngine(engine)}
        >
          <Suspense fallback={null}>{body}</Suspense>
        </EditorEngineErrorBoundary>
      </div>

      {/* VSCode 式「保存 / 不保存 / 取消」:保存是主按钮且为初始焦点(非 destructive → ConfirmDialog 把
          data-autofocus 给确认按钮),弹出后紧接着的回车只会保存、不会丢改动。 */}
      <ConfirmDialog
        open={closeCandidate !== null}
        title={
          closeCandidate
            ? translate('panels.editor.save_changes_title', {
                name: editorTabTitle(closeCandidate.filePath),
              })
            : ''
        }
        description={translate('dialog.unsaved_close.detail')}
        confirmLabel={translate('common.save')}
        onConfirm={confirmSaveAndClose}
        alternativeLabel={translate('dialog.unsaved_close.dont_save')}
        onAlternative={confirmDiscard}
        onCancel={() => setCloseCandidate(null)}
      />
      <ConfirmDialog
        open={multiCloseCandidate !== null}
        title={
          multiCloseCandidate
            ? translate('dialog.unsaved_close.message', { count: multiCloseCandidate.paths.length })
            : ''
        }
        description={multiCloseCandidate ? <UnsavedFileList paths={multiCloseCandidate.paths} /> : null}
        confirmLabel={translate('dialog.unsaved_close.save_all')}
        onConfirm={confirmMultiSaveAll}
        alternativeLabel={translate('dialog.unsaved_close.dont_save')}
        onAlternative={confirmMultiDiscard}
        onCancel={() => setMultiCloseCandidate(null)}
      />
      <ConfirmDialog
        open={overwriteCandidate !== null}
        title={translate('panels.editor.disk_changed_title')}
        description={
          overwriteCandidate
            ? withCodeName('panels.editor.disk_changed_body', basename(overwriteCandidate.filePath))
            : null
        }
        confirmLabel={translate('panels.editor.disk_changed_confirm')}
        destructive
        onConfirm={() => void confirmOverwrite()}
        alternativeLabel={translate('panels.editor.disk_changed_revert')}
        onAlternative={() => void revertOverwriteCandidate()}
        extraActions={[{ label: translate('panels.editor.disk_changed_compare'), onClick: compareOverwriteCandidate }]}
        onCancel={() => setOverwriteCandidate(null)}
      />
      <ConfirmDialog
        open={readonlyCandidate !== null}
        title={translate('panels.editor.readonly_title')}
        description={
          readonlyCandidate
            ? withCodeName('panels.editor.readonly_body', basename(readonlyCandidate.filePath))
            : null
        }
        confirmLabel={translate('panels.editor.readonly_confirm')}
        destructive
        onConfirm={() => void confirmOverwriteReadonly()}
        onCancel={() => setReadonlyCandidate(null)}
      />
      <ConfirmDialog
        open={unsafeEditConfirmOpen}
        title={translate('panels.editor.milkdownUnsafe.modalTitle')}
        description={translate('panels.editor.milkdownUnsafe.modalBody')}
        confirmLabel={translate('panels.editor.milkdownUnsafe.switchAnyway')}
        onConfirm={confirmUnsafeEdit}
        onCancel={() => setUnsafeEditConfirmOpen(false)}
      />
    </div>
    </EditorGroupIdContext.Provider>
  );
}
