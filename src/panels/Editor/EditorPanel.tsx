// M-Editor Step E4:Editor 主容器编排。
// 顶部 Toolbar + TabBar + 主体(Milkdown / CodeEditor / Welcome)+ 关闭确认 Dialog。
//
// mode 路由(决策 #1/#3/#4):
//   activeTab 是 .md → mode=edit:Milkdown;source:CodeEditor markdown;preview:Milkdown readonly
//   activeTab 非 .md → 直接 CodeEditor(mode 不显示)
//   activeTab 为 null → Welcome

import { useCallback, useMemo, useState } from 'react';
import {
  getEffectiveMode,
  isTabMilkdownUnsafe,
  useEditorStore,
  type EditorMode,
} from '@/stores/editor.store';
import { t as translate, useLocale } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import {
  basenameForEditorPath,
  isMarkdownPath as isMarkdownPathExact,
} from './editor-path-utils';
import { ConfirmDialog } from '@/panels/Explorer/ConfirmDialog';
import { SegmentedControl } from '@/design';
import { CodeEditor } from './CodeEditor';
import { EditorHeader, type TabChrome } from './EditorHeader';
import { EditorWelcome } from './EditorWelcome';
import { MilkdownEditor } from './MilkdownEditor';
import { findEditorFileTabById } from './editor-tab-lookup';
import { useAutoSave, isAutoSaveEnabled } from './useAutoSave';
import { useEditorFile } from './useEditorFile';
import { useExternalFileSync } from './useExternalFileSync';
import { resolveLink } from './link-resolve';
import { useSettingValue } from '@/plugins/settings/values-store';
import { coApi } from '@/lib/co-api';
import { notify } from '@/notifications/notify';
import type { EditorTab } from '@/stores/editor.store';

// i18n(I14):模式切换 label 走 catalog —— 此前硬编码英文 'Edit'/'Source'/'Preview',
// zh/ko 工具栏显英文且不随 locale 切换。id 稳定,label 在组件内用 useT 生成(响应 locale)。
const MODE_IDS: readonly EditorMode[] = ['edit', 'source', 'preview'];

function isMarkdownPath(p: string | null): boolean {
  // 可维护性 M13:非空判定共用 editor-path-utils.isMarkdownPath;此处只保留「草稿(null)默认
  // 按 markdown 处理」的 EditorPanel 业务语义。
  if (!p) return true;
  return isMarkdownPathExact(p);
}

function basename(p: string | null): string {
  // 可维护性 M12:非空 basename 规则共用 basenameForEditorPath;null fallback 文案各自处理。
  if (!p) return translate('panels.editor.draft');
  return basenameForEditorPath(p);
}

export function EditorPanel() {
  // 只订阅 active tab 对象(打磨 R27,延续 R22-R24 正文热路径收敛)。editor store
  // 的 updateContent/reloadFromDisk/markSaved 只替换被改的 tab 对象 → 非 active tab
  // 变化时 active tab 引用不变 → selector 返同一对象 → EditorPanel 主体不重渲;
  // active tab 变化(含切换/正文编辑)→ 新对象 → 正常重渲。tab 栏 chrome 由
  // EditorHeader 自己窄订阅,不依赖这里。
  const activeTab = useEditorStore(
    (s): EditorTab | null =>
      s.activeTabId === null ? null : findEditorFileTabById(s.tabs, s.activeTabId),
  );
  const locale = useLocale(); // i18n(I14):订阅 locale,模式切换 label 随语言更新
  const modeOptions = useMemo(
    () => {
      void locale; // deps:translate 内部按当前 locale 取值
      return MODE_IDS.map((id) => ({
        id,
        label: translate(`panels.editor.mode.${id}`),
      }));
    },
    [locale],
  );
  const mode = useEditorStore((s) => s.mode);
  const setMode = useEditorStore((s) => s.setMode);
  const updateContent = useEditorStore((s) => s.updateContent);
  const closeTab = useEditorStore((s) => s.closeTab);
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
        openFileByPath(target.absPath)
          .then((r) => {
            if (!r.ok) {
              notify.error(localizeErrorByCode(r.code, r.message ?? r.code), {
                code: r.code,
              });
            }
          })
          .catch((err) => {
            const code = (err as { code?: string })?.code ?? 'EXCEPTION';
            notify.error(localizeErrorByCode(code, (err as Error)?.message), { code });
          });
      } else {
        // a11y(A117,A50/A116 同族):外链打开须检查 IpcResult.ok + catch reject,否则 URL 被
        // 白名单拒绝或系统打开失败时无 toast/live 反馈,用户只感知链接「没反应」。
        coApi.shell
          .openExternal(target.url)
          .then((r) => {
            if (!r.ok) {
              notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
            }
          })
          .catch((err) => {
            const code = (err as { code?: string })?.code ?? 'EXCEPTION';
            notify.error(localizeErrorByCode(code, (err as Error)?.message), { code });
          });
      }
    },
    [activeTab?.filePath, openFileByPath],
  );
  // 自动保存(Markdown)开关 + 延迟 — 都受 SettingsPanel 控制
  const mdAutoSaveEnabled = useSettingValue<boolean>(
    'autoSave.markdown.enabled',
    true,
  );
  const autoSaveDelayMs = useSettingValue<number>('autoSave.delayMs', 2000);
  const autoSaveEnabled =
    isAutoSaveEnabled(activeTab?.filePath ?? null) && mdAutoSaveEnabled;

  // 自动保存:Markdown 启用,代码不启用(决策 #3)。按 tabId 保存,切走/卸载时
  // flush pending,避免连续输入后立即切 tab 丢失整段编辑。
  useAutoSave(saveTab, {
    enabled: autoSaveEnabled,
    delayMs: autoSaveDelayMs,
  });

  // 外部进程修改文件时,自动同步 non-dirty tab 的内容
  useExternalFileSync();

  // 显式保存(Cmd+S 或 toolbar)
  const handleSave = useCallback(async () => {
    const r = await saveActive();
    if (!r.ok) {
      // i18n(I7,codex 复查 P1):UNSAVED_DRAFT / TAB_NOT_FOUND / NO_ACTIVE_TAB / FS_* 都到
      // 这里,r.message 是 main/动作层的 raw(FS_* 英文、UNSAVED_DRAFT 含中文)→ 双向泄漏。
      // 按 code 经 catalog 本地化(单一来源 localizeErrorByCode),未收录 code 回退原 message。
      notify.error(localizeErrorByCode(r.code, r.message), { code: r.code });
    }
  }, [saveActive]);

  // 关闭脏 tab 二次确认。closeCandidate 用轻量 TabChrome(打磨 R23:不持完整
  // EditorTab/content,确认框只需 filePath,关闭只需 id)。
  const [closeCandidate, setCloseCandidate] = useState<TabChrome | null>(null);
  const onTabCloseRequest = useCallback(
    (tab: TabChrome) => {
      if (tab.dirty) setCloseCandidate(tab);
      else closeTab(tab.id);
    },
    [closeTab],
  );
  const confirmDiscard = useCallback(() => {
    if (closeCandidate) closeTab(closeCandidate.id);
    setCloseCandidate(null);
  }, [closeCandidate, closeTab]);

  // Unsafe markdown cannot be opened in Milkdown without an explicit warning.
  const [unsafeEditConfirmOpen, setUnsafeEditConfirmOpen] = useState(false);
  const requestModeChange = useCallback(
    (next: EditorMode) => {
      if (next === 'edit' && unsafeMarkdown) {
        setUnsafeEditConfirmOpen(true);
        return;
      }
      setMode(next);
    },
    [setMode, unsafeMarkdown],
  );
  const confirmUnsafeEdit = useCallback(() => {
    setMode('edit');
    setUnsafeEditConfirmOpen(false);
  }, [setMode]);

  // 判定主体渲染(根据 activeTab 类型 + mode)
  let body: React.ReactNode;
  if (!activeTab) {
    body = <EditorWelcome />;
  } else if (activeIsMarkdown) {
    if (effective === 'source') {
      body = (
        <CodeEditor
          key={`${activeTab.id}-src`}
          tabId={activeTab.id}
          value={activeTab.content}
          fileName={activeTab.filePath ?? ''}
          forceLanguage="markdown"
          onChange={(v) => updateContent(activeTab.id, v)}
        />
      );
    } else {
      body = (
        <MilkdownEditor
          // reloadEpoch 并入 key:外部进程改文件 → reloadFromDisk 递增 epoch →
          // Milkdown remount 拿新内容,避免基于陈旧内容编辑后保存覆盖外部改动。
          // 用户输入/保存不动 epoch,故不会每次按键 remount。
          key={`${activeTab.id}-${effective}-${activeTab.reloadEpoch ?? 0}`}
          defaultValue={activeTab.content}
          readonly={effective === 'preview'}
          onChange={(md) => updateContent(activeTab.id, md)}
          onLinkClick={handleLinkClick}
        />
      );
    }
  } else {
    body = (
      <CodeEditor
        key={activeTab.id}
        tabId={activeTab.id}
        value={activeTab.content}
        fileName={activeTab.filePath ?? ''}
        onChange={(v) => updateContent(activeTab.id, v)}
      />
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col bg-canvas"
      onKeyDown={(e) => {
        // Cmd/Ctrl+S 显式保存(Crepe 不会拦 ⌘S,所以可以放心)
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          void handleSave();
        }
      }}
    >
      <EditorHeader onCloseRequest={onTabCloseRequest} />
      {activeIsMarkdown && (
        // markdown 模式切换:tab 行下方独立一行,居中。
        // 不加 border — 与上方 tab 行 / 下方编辑器无缝衔接,只靠 SegmentedControl
        // 自身的 surface-container-low 背景与 canvas 形成视觉区分。
        // 显示条件 = markdown 文件(含未保存草稿) — 与 autoSave 解耦,
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
      <div className="min-h-0 flex-1">{body}</div>

      <ConfirmDialog
        open={closeCandidate !== null}
        title={translate('panels.editor.discard_title')}
        description={
          closeCandidate ? (
            <>
              <code className="text-fg">
                {basename(closeCandidate.filePath)}
              </code>{' '}
              {translate('panels.editor.discard_body')}
            </>
          ) : null
        }
        confirmLabel={translate('panels.editor.discard_confirm')}
        destructive
        onConfirm={confirmDiscard}
        onCancel={() => setCloseCandidate(null)}
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
