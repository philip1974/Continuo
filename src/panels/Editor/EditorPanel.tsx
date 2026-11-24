// M-Editor Step E4:Editor 主容器编排。
// 顶部 EditorHeader(tab 行)+ 模式切换行(SegmentedControl)+ 主体(Milkdown / CodeEditor / Welcome)+ 确认对话框。
//
// mode 路由(决策 #1/#3/#4):
//   activeTab 是 .md → mode=edit:Milkdown;source:CodeEditor markdown;preview:Milkdown readonly
//     (含 frontmatter / wiki-link 的 .md:edit 须先确认,否则落到 source;preview 照常)
//   activeTab 非 .md → 直接 CodeEditor(mode 不显示)
//   activeTab 为 null → Welcome

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { DockviewPanelApi } from 'dockview-react';
import {
  getEffectiveMode,
  isTabMilkdownUnsafe,
  useEditorStore,
  usesMilkdownEngine,
  type EditorMode,
} from '@/stores/editor.store';
import { t as translate, useLocale } from '@/i18n';
import { isMarkdownPath } from './editor-path-utils';
import { basename } from '@/lib/path-cross';
import { ConfirmDialog } from '@/lib/ConfirmDialog';
import { SegmentedControl, type SegmentedControlOption } from '@/design';
import { EditorHeader, type TabChrome } from './EditorHeader';
import { EditorWelcome } from './EditorWelcome';
import { createLazyCodeEditor, createLazyMilkdownEditor } from './editor-engine-loaders';
import { EditorEngineErrorBoundary } from './EditorEngineErrorBoundary';
import { toPreviewMarkdown } from './milkdown-roundtrip-safety';
import { findEditorFileTabById } from './editor-tab-lookup';
import { flushEditorWriteBacks } from './editor-writeback-registry';
import { rebindEditorRoots } from './editor-root-registry';
import { applyEditorWriteBack, EDITOR_DISK_CHANGED } from './editor-file-actions';
import { useAutoSave, isAutoSaveEnabled } from './useAutoSave';
import { useEditorFile } from './useEditorFile';
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
import { openFileOrNotify } from '@/notifications/notify-open-failed';
import { basenameForChrome } from '@/lib/path-label';
import { matchesHotkey } from '@/plugins/command-palette/useCommandHotkeys';
import { resolveActiveHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { editorCommandSpecs, openAdjacentEditor, registerEditorPanelActions, SAVE_COMMAND, NEXT_EDITOR_COMMAND_ID, PREVIOUS_EDITOR_COMMAND_ID } from './editor-commands';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';

const ADJACENT_EDITOR_SPECS = editorCommandSpecs(detectPlatform()).filter(
  (c) => c.id === NEXT_EDITOR_COMMAND_ID || c.id === PREVIOUS_EDITOR_COMMAND_ID,
);

/** 按生效绑定判定是否为下一个(1)/ 上一个(-1)编辑器;否则 0。 */
function adjacentEditorDeltaFor(e: KeyboardEvent, overrides: Readonly<Record<string, string>>): 1 | -1 | 0 {
  for (const spec of ADJACENT_EDITOR_SPECS) {
    const combo = resolveActiveHotkey(spec, overrides);
    if (combo !== undefined && matchesHotkey(combo, e)) return spec.id === NEXT_EDITOR_COMMAND_ID ? 1 : -1;
  }
  return 0;
}

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


export interface EditorPanelProps {
  /** dockview 面板 api(经 PanelHost 传入;测试直接渲染时缺省)。 */
  readonly api?: Pick<DockviewPanelApi, 'onDidLocationChange'>;
}

export function EditorPanel({ api }: EditorPanelProps = {}) {
  // 只订阅 active tab 对象(打磨 R27,延续 R22-R24 正文热路径收敛)。editor store
  // 的 updateContent/reloadFromDisk/markSaved 只替换被改的 tab 对象 → 非 active tab
  // 变化时 active tab 引用不变 → selector 返同一对象 → EditorPanel 主体不重渲;
  // active tab 变化(含切换/正文编辑)→ 新对象 → 正常重渲。tab 栏 chrome 由
  // EditorHeader 自己窄订阅,不依赖这里。
  const activeTab = useEditorStore(
    (s): EditorTab | null =>
      findEditorFileTabById(s.tabs, s.activeTabId),
  );
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
  const closeTab = useEditorStore((s) => s.closeTab);
  const acceptUnsafeEdit = useEditorStore((s) => s.acceptUnsafeEdit);
  // 引擎 lazy 实例 + 重试代数:重试新建失败引擎的 lazy 实例,并换 key 重挂错误边界。
  const [engines, setEngines] = useState(() => lazyEngines);
  const [engineRetry, setEngineRetry] = useState(0);
  const { code: CodeEditor, milkdown: MilkdownEditor } = engines;
  const retryEngine = useCallback((which: 'welcome' | 'code' | 'milkdown') => {
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
  const forcedSource = unsafeMarkdown && effective !== mode;
  const activeIsMarkdown = activeTab !== null && isMarkdownPath(activeTab.filePath);

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
        void openFileOrNotify(() => openFileByPath(target.absPath), name);
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
  const [closeCandidate, setCloseCandidate] = useState<TabChrome | null>(null);

  // 自动保存:Markdown 启用,代码不启用(决策 #3)。按 tabId 保存,切走/卸载时
  // flush pending,避免连续输入后立即切 tab 丢失整段编辑。
  // 关闭脏 tab 的「放弃修改?」确认框开着时暂停:否则停留超过 delay 会把待放弃的内容写盘。
  // !enabled 取消已排队的保存;取消确认后 enabled 恢复,仍脏照常重新排队。
  useAutoSave(saveTab, {
    enabled: autoSaveEnabled && closeCandidate === null,
    delayMs: autoSaveDelayMs,
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
  // closeAfter:来自关闭脏 tab 时选「保存」—— 覆盖写盘成功后接着关闭该 tab。
  const [overwriteCandidate, setOverwriteCandidate] = useState<
    (Pick<TabChrome, 'id' | 'filePath'> & { readonly closeAfter?: boolean }) | null
  >(null);

  // 显式保存(Cmd+S 或 toolbar)
  const handleSave = useCallback(async () => {
    const { activeTabId, tabs } = useEditorStore.getState();
    const target = findEditorFileTabById(tabs, activeTabId);
    const r = await saveActive();
    if (!r.ok) {
      if (r.code === EDITOR_DISK_CHANGED && target) {
        setOverwriteCandidate({ id: target.id, filePath: target.filePath });
        return;
      }
      // i18n(I7,复查 P1):TAB_NOT_FOUND / NO_ACTIVE_TAB / FS_* 都到
      // 这里,r.message 是 main/动作层的 raw(FS_* 英文)→ 双向泄漏。
      // 按 code 经 catalog 本地化(单一来源 localizeErrorByCode),未收录 code 回退原 message。
      notifyFailure(r);
    }
  }, [saveActive]);
  const confirmOverwrite = useCallback(async () => {
    const candidate = overwriteCandidate;
    setOverwriteCandidate(null);
    if (!candidate) return;
    try {
      const r = await saveTab(candidate.id, { force: true });
      if (!r.ok) notifyFailure(r);
      else if (candidate.closeAfter) closeTab(candidate.id);
    } catch (err) {
      notifyThrownError(err);
    }
  }, [overwriteCandidate, saveTab, closeTab]);

  // 关闭脏 tab 二次确认(closeCandidate 声明在 useAutoSave 之前,确认框开着时暂停 autosave)。
  const onTabCloseRequest = useCallback(
    (tab: TabChrome) => {
      // tab.dirty 是 TabChrome 快照,store 可能落后编辑器(Milkdown 自适应延迟上抛,单次最长约 2s、持续输入最长 5s):
      // 先同步回写未上抛的输入,再按 store 最新 dirty 判定。否则「干净」tab 直接关闭,
      // 随后卸载回写找不到 tab → 这段输入丢失。
      flushEditorWriteBacks([tab.id]);
      const live = findEditorFileTabById(useEditorStore.getState().tabs, tab.id);
      if (!live) return;
      if (live.dirty) setCloseCandidate({ id: live.id, filePath: live.filePath, dirty: true });
      else closeTab(live.id);
    },
    [closeTab],
  );
  const confirmDiscard = useCallback(() => {
    if (closeCandidate) closeTab(closeCandidate.id);
    setCloseCandidate(null);
  }, [closeCandidate, closeTab]);
  // 「保存」(VSCode 关闭脏编辑器的默认按钮):保存成功才关闭;磁盘已被外部修改 → 走覆盖确认(确认并写盘成功后
  // 关闭);其它失败不关闭、按 code 提示,改动留在 tab 里。
  const confirmSaveAndClose = useCallback(async () => {
    const candidate = closeCandidate;
    setCloseCandidate(null);
    if (!candidate) return;
    try {
      const r = await saveTab(candidate.id);
      if (r.ok) {
        closeTab(candidate.id);
        return;
      }
      if (r.code === EDITOR_DISK_CHANGED) {
        setOverwriteCandidate({ id: candidate.id, filePath: candidate.filePath, closeAfter: true });
        return;
      }
      notifyFailure(r);
    } catch (err) {
      notifyThrownError(err);
    }
  }, [closeCandidate, closeTab, saveTab]);

  // 全局命令 workbench.action.files.save / closeActiveEditor(⌘S / ⌘W,焦点在面板外也生效)经此调用面板内同一实现
  //(覆盖确认 / 保存·不保存·取消 确认框状态在本组件)。BDD: src/__tests__/workbench-editor-commands/
  useEffect(
    () =>
      registerEditorPanelActions({
        save: handleSave,
        closeActiveTab: () => {
          const { tabs, activeTabId } = useEditorStore.getState();
          const tab = findEditorFileTabById(tabs, activeTabId);
          if (!tab) return false;
          onTabCloseRequest(tab);
          return true;
        },
      }),
    [handleSave, onTabCloseRequest],
  );

  // Unsafe markdown cannot be opened in Milkdown without an explicit warning.
  const [unsafeEditConfirmOpen, setUnsafeEditConfirmOpen] = useState(false);
  const requestModeChange = useCallback(
    (next: EditorMode) => {
      if (next === 'edit' && unsafeMarkdown && !activeTab?.unsafeEditAccepted) {
        setUnsafeEditConfirmOpen(true);
        return;
      }
      setMode(next);
    },
    [setMode, unsafeMarkdown, activeTab?.unsafeEditAccepted],
  );
  const activeTabId = activeTab?.id ?? null;
  // 确认框针对打开它时的 tab;active tab 换了(如 SDK openFile)就作废,免得确认到别的文件上
  useEffect(() => setUnsafeEditConfirmOpen(false), [activeTabId]);
  const confirmUnsafeEdit = useCallback(() => {
    if (activeTabId !== null) acceptUnsafeEdit(activeTabId);
    setMode('edit');
    setUnsafeEditConfirmOpen(false);
  }, [acceptUnsafeEdit, activeTabId, setMode]);

  // 判定主体渲染(根据 activeTab 类型 + mode)
  let body: React.ReactNode;
  let engine: 'welcome' | 'code' | 'milkdown';
  if (!activeTab) {
    engine = 'welcome';
    body = <EditorWelcome />;
  } else if (usesMilkdownEngine(activeTab.filePath, activeTab)) {
    engine = 'milkdown';
    body = (
      <MilkdownEditor
        // reloadEpoch 并入 key:外部进程改文件 → reloadFromDisk 递增 epoch →
        // Milkdown remount 拿新内容,避免基于陈旧内容编辑后保存覆盖外部改动。
        // 用户输入/保存不动 epoch,故不会每次按键 remount。
        key={`${activeTab.id}-${effective}-${activeTab.reloadEpoch ?? 0}`}
        tabId={activeTab.id}
        // preview 只读不回写,frontmatter 换成 yaml 代码块展示(否则被解析成横线+标题)
        defaultValue={
          effective === 'preview'
            ? toPreviewMarkdown(activeTab.content)
            : activeTab.content
        }
        readonly={effective === 'preview'}
        onChange={(md) => updateContent(activeTab.id, md)}
        onWriteBack={(md, base) =>
          applyEditorWriteBack(activeTab.id, md, base)
        }
        onLinkClick={handleLinkClick}
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
    <div
      className="flex h-full w-full flex-col bg-canvas"
      onKeyDown={(e) => {
        // 保存命令(workbench.action.files.save)的生效绑定:面板内就地保存并截住冒泡,不再到 document 的全局分发
        //(否则一次按键保存两次)。面板外(Explorer 等)由全局命令保存;面板在 popout 子窗时全局分发不监听子窗
        // document,靠这里保存。按平台精确匹配修饰键(matchesHotkey,与全局热键同一规则,复审 loop R15);按生效绑定
        // 判定:用户改绑跟随新键、解绑后不再拦。
        const overrides = useKeybindingsStore.getState().overrides;
        const combo = resolveActiveHotkey(SAVE_COMMAND, overrides);
        if (combo !== undefined && matchesHotkey(combo, e.nativeEvent)) {
          e.preventDefault();
          e.stopPropagation();
          void handleSave();
          return;
        }
        // 下一个 / 上一个编辑器同理在面板内处理:它们只切本编辑器的文件 tab,面板在 popout 子窗时全局分发不监听
        // 子窗;且不放进子窗全局分发(编辑器不在该子窗时会切到主窗编辑器、子窗里看不到变化)。编辑器内容已处理的键
        //(defaultPrevented,如 CodeMirror 自有绑定)不抢。
        if (e.defaultPrevented) return;
        const delta = adjacentEditorDeltaFor(e.nativeEvent, overrides);
        if (delta !== 0) {
          e.preventDefault();
          e.stopPropagation();
          openAdjacentEditor(delta);
        }
      }}
    >
      <EditorHeader onCloseRequest={onTabCloseRequest} />
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
      {forcedSource && (
        <div className="bg-panel-soft px-4 py-2 text-xs text-fg-muted">
          {translate('panels.editor.milkdownUnsafe.banner')}
        </div>
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
                name: basename(closeCandidate.filePath),
              })
            : ''
        }
        description={translate('dialog.unsaved_close.detail')}
        confirmLabel={translate('common.save')}
        onConfirm={() => void confirmSaveAndClose()}
        alternativeLabel={translate('dialog.unsaved_close.dont_save')}
        onAlternative={confirmDiscard}
        onCancel={() => setCloseCandidate(null)}
      />
      <ConfirmDialog
        open={overwriteCandidate !== null}
        title={translate('panels.editor.disk_changed_title')}
        description={
          overwriteCandidate ? (
            <>
              <code className="text-fg">
                {basename(overwriteCandidate.filePath)}
              </code>{' '}
              {translate('panels.editor.disk_changed_body')}
            </>
          ) : null
        }
        confirmLabel={translate('panels.editor.disk_changed_confirm')}
        destructive
        onConfirm={() => void confirmOverwrite()}
        onCancel={() => setOverwriteCandidate(null)}
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
  );
}
